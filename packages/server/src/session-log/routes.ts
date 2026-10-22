/**
 * Inspector routes over the session log (K2). People read every event of a
 * session, reasoning included; exports leave reasoning out. Every payload is
 * scrubbed again on the way out.
 *
 * The `person` audience is only for someone at this machine: until the remote
 * security profile exists (accounts, TLS, scoped credentials), every route
 * answers loopback socket peers only, even when the server listens on another
 * interface (`HOST`). A Host-header allowlist does not authenticate a peer, so
 * this checks the socket's remote address, and refuses when it is unknown.
 */
import { Hono, type Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  SESSION_EXPORT_VERSION,
  SSE_ERROR_EVENT_NAME,
  SSE_EVENT_NAME,
  SSE_LAST_EVENT_ID_HEADER,
  listSessionsQuery,
  listSessionsResponse,
  sessionPageQuery,
  sessionPageCursorSchema,
  sessionPageResponse,
  type SessionPageCursor,
  sessionEventSchema,
  sessionEventsQuery,
  sessionEventsResponse,
  sessionExportQuery,
  sessionExportSchema,
  sessionPathParams,
  sessionSearchQuery,
  sessionSearchResponse,
  sessionSpansResponse,
  sessionSummarySchema,
  type ApiError,
  type SessionEvent,
} from '@guanxi/contract'
import { SessionEventVersionError, SessionLogError, type SessionLog } from './log.ts'
import { projectSpans } from './projection.ts'

const encoder = new TextEncoder()

function apiError(code: ApiError['code'], message: string): ApiError {
  return { code, message, details: null }
}

/** True only for a loopback socket peer: 127.0.0.0/8, ::1, or their IPv4-mapped form. */
export function isLoopbackPeer(context: Context): boolean {
  let address: string | undefined
  try {
    address = getConnInfo(context).remote.address
  } catch {
    return false
  }
  if (!address) return false
  const plain = address.toLowerCase().replace(/^::ffff:/u, '')
  return plain === '::1' || /^127(\.\d{1,3}){3}$/u.test(plain)
}

function invalid(context: Context, message: string): Response {
  return context.json(apiError('validation_failed', message), 400)
}

const WITHHELD_MESSAGE = 'This session is withheld: one of its identifiers contains a registered secret'
const CATCHING_UP_MESSAGE = 'This session history is still being restored from the Chat job store'

/** Explicit catching-up state (GPT re-check N2): never an empty or partial success. */
function catchingUp(error: SessionLogError): ApiError {
  return { code: 'session_catching_up', message: CATCHING_UP_MESSAGE, details: { failure: error.catchUpFailure } }
}

/** One mapping of read failures for JSON responses and SSE error frames; every body is content-free. */
function errorBody(error: unknown, log?: SessionLog): { status: 403 | 404 | 406 | 500 | 503; body: ApiError } {
  if (error instanceof SessionEventVersionError) {
    return {
      status: 406,
      body: {
        code: 'session_event_version_unsupported',
        message: 'The next session event needs a newer envelope version',
        details: { seq: error.seq, supported: error.supported, required: error.required },
      },
    }
  }
  if (error instanceof SessionLogError && error.code === 'session_not_found') {
    return { status: 404, body: apiError('session_not_found', 'Session not found') }
  }
  if (error instanceof SessionLogError && error.code === 'session_withheld') {
    // Content-free: the id is never echoed back (GPT re-check N1).
    return { status: 403, body: apiError('session_withheld', WITHHELD_MESSAGE) }
  }
  if (error instanceof SessionLogError && error.code === 'session_catching_up') {
    return { status: 503, body: catchingUp(error) }
  }
  if (error instanceof SessionLogError && error.code === 'egress_not_ready') {
    // Fail closed: nothing leaves the log until every declared secret source has registered.
    let pendingSources: readonly string[] = []
    try {
      pendingSources = log?.pendingSources() ?? []
    } catch {
      pendingSources = []
    }
    return {
      status: 503,
      body: { code: 'egress_not_ready', message: 'Secret redaction is not ready yet', details: { pendingSources: [...pendingSources] } },
    }
  }
  return { status: 500, body: apiError('storage_error', 'Session log read failed') }
}

function failure(context: Context, error: unknown, log?: SessionLog): Response {
  const { status, body } = errorBody(error, log)
  return context.json(body, status)
}

/** Strict query parsing: unknown or repeated keys are refused. */
function query(context: Context, allowed: readonly string[]): Record<string, string> | null {
  const params = new URL(context.req.url).searchParams
  const keys = [...params.keys()]
  if (keys.some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) return null
  return Object.fromEntries(params)
}

function sessionIdOf(context: Context): string | null {
  const parsed = sessionPathParams.safeParse({ sessionId: context.req.param('sessionId') })
  return parsed.success ? parsed.data.sessionId : null
}

function eventFrame(event: SessionEvent): Uint8Array {
  const parsed = sessionEventSchema.parse(event)
  return encoder.encode(`id: ${parsed.seq}\nevent: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(parsed)}\n\n`)
}

export function sessionLogRoutes(resolve: () => SessionLog | undefined): Hono {
  const routes = new Hono()
  routes.use('*', async (context, next) => {
    if (!isLoopbackPeer(context)) {
      return context.json(apiError('loopback_only', 'The session inspector answers this machine only'), 403)
    }
    await next()
  })
  const log = (): SessionLog => {
    const current = resolve()
    if (!current) throw new SessionLogError('closed', 'The session log is not available')
    return current
  }
  // Every route funnels its failures here, with the log for the not-ready details.
  const fail = (context: Context, error: unknown) => failure(context, error, resolve())

  routes.get('/', (context) => {
    const raw = query(context, ['limit'])
    const parsed = raw ? listSessionsQuery.safeParse(raw) : null
    if (!parsed?.success) return invalid(context, 'Invalid session list query')
    try {
      return context.json(listSessionsResponse.parse(log().list(parsed.data.limit)))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/list/page', (context) => {
    const raw = query(context, ['limit', 'cursor'])
    const parsed = raw ? sessionPageQuery.safeParse(raw) : null
    if (!parsed?.success) return invalid(context, 'Invalid session page query')
    let cursor: SessionPageCursor | undefined
    if (parsed.data.cursor) {
      try { cursor = sessionPageCursorSchema.parse(JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString('utf8'))) }
      catch { return invalid(context, 'Invalid session page cursor') }
    }
    try { return context.json(sessionPageResponse.parse(log().page(parsed.data.limit, cursor))) }
    catch (error) { return fail(context, error) }
  })

  routes.get('/search', (context) => {
    const raw = query(context, ['q', 'sessionId', 'limit'])
    const parsed = raw ? sessionSearchQuery.safeParse(raw) : null
    if (!parsed?.success) return invalid(context, 'Invalid session search query')
    try {
      const current = log()
      const hits = current.search(parsed.data.q, {
        sessionId: parsed.data.sessionId,
        audience: 'person',
        limit: parsed.data.limit,
      })
      return context.json(sessionSearchResponse.parse({ query: current.redact(parsed.data.q), hits }))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:sessionId', (context) => {
    const sessionId = sessionIdOf(context)
    if (!sessionId || !query(context, [])) return invalid(context, 'Invalid session request')
    try {
      const current = log()
      const session = current.session(sessionId)
      if (!session) return fail(context, new SessionLogError('session_not_found', sessionId))
      const { counts, purged, redactions } = current.counts(sessionId)
      return context.json(
        sessionSummarySchema.parse({
          ...session,
          counts,
          eventCount: Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0),
          reasoningPurged: purged,
          redactions,
          tokens: current.tokenMeter(sessionId),
        }),
      )
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:sessionId/events', (context) => {
    const sessionId = sessionIdOf(context)
    const raw = query(context, ['after', 'limit', 'eventVersion'])
    const parsed = raw ? sessionEventsQuery.safeParse(raw) : null
    if (!sessionId || !parsed?.success) return invalid(context, 'Invalid session events query')
    try {
      const current = log()
      const page = current.read(sessionId, {
        afterSeq: parsed.data.after,
        limit: parsed.data.limit,
        audience: 'person',
        maxVersion: parsed.data.eventVersion,
      })
      if (page.unsupportedSeq !== null) {
        throw new SessionEventVersionError(
          page.unsupportedSeq,
          parsed.data.eventVersion,
          page.requiredVersion ?? parsed.data.eventVersion,
        )
      }
      return context.json(
        sessionEventsResponse.parse({
          // The read above refused an id holding a registered value, so the id is safe to echo.
          sessionId,
          events: page.events,
          nextAfter: page.events.at(-1)?.seq ?? parsed.data.after,
          lastSeq: page.lastSeq,
          hasMore: page.hasMore,
        }),
      )
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:sessionId/spans', (context) => {
    const sessionId = sessionIdOf(context)
    if (!sessionId || !query(context, [])) return invalid(context, 'Invalid session spans request')
    try {
      const current = log()
      const events = current.readAll(sessionId, 'person')
      return context.json(sessionSpansResponse.parse({ sessionId, spans: projectSpans(events) }))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:sessionId/export', (context) => {
    const sessionId = sessionIdOf(context)
    const raw = query(context, ['exportVersion'])
    const parsed = raw ? sessionExportQuery.safeParse(raw) : null
    if (!sessionId || !parsed?.success) return invalid(context, 'Invalid session export request')
    try {
      const current = log()
      const all = current.readAll(sessionId, 'person')
      const events = all.filter((event) => event.class !== 'reasoning')
      // The minimum body version is the highest envelope actually exported.
      // Refuse a smaller requested maximum before serialising any partial body.
      const requiredVersion = events.reduce(
        (maximum, event) => Math.max(maximum, event.version),
        SESSION_EXPORT_VERSION,
      )
      const incompatible = events.find((event) => event.version > parsed.data.exportVersion)
      if (incompatible !== undefined) {
        throw new SessionEventVersionError(
          incompatible.seq,
          parsed.data.exportVersion,
          incompatible.version,
        )
      }
      const body = sessionExportSchema.parse({
        exportVersion: requiredVersion,
        sessionId,
        exportedAt: new Date().toISOString(),
        lastSeq: all.at(-1)?.seq ?? 0,
        excluded: { reasoning: all.length - events.length },
        events,
      })
      context.header('content-disposition', `attachment; filename="session-${sessionId}.json"`)
      return context.json(body)
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:sessionId/stream', (context) => {
    const sessionId = sessionIdOf(context)
    const raw = query(context, ['after', 'eventVersion'])
    const parsed = raw ? sessionEventsQuery.pick({ after: true, eventVersion: true }).safeParse(raw) : null
    const lastEventId = context.req.header(SSE_LAST_EVENT_ID_HEADER)
    const reconnect = lastEventId === undefined ? undefined : Number(lastEventId)
    if (
      !sessionId ||
      !parsed?.success ||
      (reconnect !== undefined && (!Number.isSafeInteger(reconnect) || reconnect < 0))
    ) {
      return invalid(context, 'Invalid session stream cursor')
    }
    let current: SessionLog
    try {
      current = log()
      if (!current.session(sessionId)) throw new SessionLogError('session_not_found', sessionId)
    } catch (error) {
      return fail(context, error)
    }
    const after = reconnect ?? parsed.data.after
    try {
      const first = current.read(sessionId, {
        afterSeq: after,
        limit: 1,
        audience: 'person',
        maxVersion: parsed.data.eventVersion,
      })
      if (first.unsupportedSeq !== null) {
        throw new SessionEventVersionError(
          first.unsupportedSeq,
          parsed.data.eventVersion,
          first.requiredVersion ?? parsed.data.eventVersion,
        )
      }
    } catch (error) {
      return fail(context, error)
    }
    const subscriber = new AbortController()
    const requestSignal = context.req.raw.signal
    const onAbort = () => subscriber.abort()
    requestSignal.addEventListener('abort', onAbort, { once: true })
    const iterator = current.subscribe(sessionId, after, 'person', subscriber.signal, parsed.data.eventVersion)
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await iterator.next()
            if (next.done) {
              requestSignal.removeEventListener('abort', onAbort)
              controller.close()
              return
            }
            // The actual output boundary, after the await: check and scrub again
            // right before serialising (GPT final check N5).
            controller.enqueue(eventFrame(current.outward(sessionId, next.value)))
          } catch (failed) {
            // A value registered while the stream is open withholds the session from then on;
            // a Job deferred meanwhile makes its history incomplete until it is caught up;
            // a source declared meanwhile closes the gate.
            const error = failed instanceof SessionLogError || failed instanceof SessionEventVersionError
              ? errorBody(failed, current).body
              : apiError('storage_error', 'Session event subscription failed')
            controller.enqueue(encoder.encode(`event: ${SSE_ERROR_EVENT_NAME}\ndata: ${JSON.stringify(error)}\n\n`))
            subscriber.abort()
            await iterator.return(undefined)
            requestSignal.removeEventListener('abort', onAbort)
            controller.close()
          }
        },
        async cancel() {
          subscriber.abort()
          await iterator.return(undefined)
          requestSignal.removeEventListener('abort', onAbort)
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  })

  return routes
}
