/**
 * Inspector routes over the session log (K2). People read every event of a
 * session; exports leave reasoning out. Every payload is scrubbed again on the
 * way out. The node binds to loopback; these routes add no remote access.
 */
import { Hono, type Context } from 'hono'
import {
  SESSION_EXPORT_VERSION,
  SSE_ERROR_EVENT_NAME,
  SSE_EVENT_NAME,
  SSE_LAST_EVENT_ID_HEADER,
  listSessionsQuery,
  listSessionsResponse,
  sessionEventSchema,
  sessionEventsQuery,
  sessionEventsResponse,
  sessionExportSchema,
  sessionPathParams,
  sessionSearchQuery,
  sessionSearchResponse,
  sessionSpansResponse,
  sessionSummarySchema,
  type ApiError,
  type SessionEvent,
} from '@guanxi/contract'
import { SessionLogError, type SessionLog } from './log.ts'
import { projectSpans } from './projection.ts'

const encoder = new TextEncoder()

function apiError(code: ApiError['code'], message: string): ApiError {
  return { code, message, details: null }
}

function invalid(context: Context, message: string): Response {
  return context.json(apiError('validation_failed', message), 400)
}

function failure(context: Context, error: unknown, log?: SessionLog): Response {
  if (error instanceof SessionLogError && error.code === 'session_not_found') {
    return context.json(apiError('session_not_found', 'Session not found'), 404)
  }
  if (error instanceof SessionLogError && error.code === 'egress_not_ready') {
    // Fail closed: nothing leaves the log until every declared secret source has registered.
    let pendingSources: readonly string[] = []
    try {
      pendingSources = log?.pendingSources() ?? []
    } catch {
      pendingSources = []
    }
    return context.json(
      { code: 'egress_not_ready', message: 'Secret redaction is not ready yet', details: { pendingSources: [...pendingSources] } },
      503,
    )
  }
  return context.json(apiError('storage_error', 'Session log read failed'), 500)
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
      return context.json(listSessionsResponse.parse({ sessions: log().list(parsed.data.limit) }))
    } catch (error) {
      return fail(context, error)
    }
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
    const raw = query(context, ['after', 'limit'])
    const parsed = raw ? sessionEventsQuery.safeParse(raw) : null
    if (!sessionId || !parsed?.success) return invalid(context, 'Invalid session events query')
    try {
      const page = log().read(sessionId, {
        afterSeq: parsed.data.after,
        limit: parsed.data.limit,
        audience: 'person',
      })
      return context.json(
        sessionEventsResponse.parse({
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
      const events = log().readAll(sessionId, 'person')
      return context.json(sessionSpansResponse.parse({ sessionId, spans: projectSpans(events) }))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:sessionId/export', (context) => {
    const sessionId = sessionIdOf(context)
    if (!sessionId || !query(context, [])) return invalid(context, 'Invalid session export request')
    try {
      const current = log()
      const all = current.readAll(sessionId, 'person')
      const events = all.filter((event) => event.class !== 'reasoning')
      const body = sessionExportSchema.parse({
        exportVersion: SESSION_EXPORT_VERSION,
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
    const raw = query(context, ['after'])
    const parsed = raw ? sessionEventsQuery.pick({ after: true }).safeParse(raw) : null
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
    const subscriber = new AbortController()
    const requestSignal = context.req.raw.signal
    const onAbort = () => subscriber.abort()
    requestSignal.addEventListener('abort', onAbort, { once: true })
    const iterator = current.subscribe(sessionId, after, 'person', subscriber.signal)
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
            controller.enqueue(eventFrame(next.value))
          } catch {
            const error = apiError('storage_error', 'Session event subscription failed')
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
