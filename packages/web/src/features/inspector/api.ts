/**
 * Inspector client over the session log routes (K2). Paths come from the
 * contract's SESSION_ROUTES; every response is parsed by its contract schema.
 */
import type { output, ZodTypeAny } from 'zod'
import {
  SESSION_EVENT_MAX_VERSION,
  SESSION_EXPORT_MAX_VERSION,
  SESSION_ROUTES,
  apiErrorSchema,
  listSessionsResponse,
  sessionPageResponse,
  sessionEventSchema,
  sessionEventsResponse,
  sessionSearchResponse,
  sessionSpansResponse,
  sessionSummarySchema,
  type SessionEvent,
} from '@guanxi/contract'
import { ApiRequestError, ApiShapeError } from '../../lib/api.ts'
import { sseStream } from '../../lib/sse.ts'

async function getJson<Schema extends ZodTypeAny>(
  path: string,
  schema: Schema,
  signal?: AbortSignal,
): Promise<output<Schema>> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body)
    throw new ApiRequestError(
      response.status,
      error.success ? error.data : null,
      error.success ? error.data.message : `HTTP ${response.status}`,
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiShapeError(path, parsed.error.issues)
  return parsed.data
}

export const inspectorApi = {
  page: (cursor?: string, signal?: AbortSignal) => getJson(
    `${SESSION_ROUTES.page()}?${new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })}`,
    sessionPageResponse, signal),
  sessions: (signal?: AbortSignal) =>
    getJson(`${SESSION_ROUTES.sessions()}?limit=100`, listSessionsResponse, signal),
  summary: (sessionId: string, signal?: AbortSignal) =>
    getJson(SESSION_ROUTES.session(sessionId), sessionSummarySchema, signal),
  spans: (sessionId: string, signal?: AbortSignal) =>
    getJson(SESSION_ROUTES.spans(sessionId), sessionSpansResponse, signal),
  search: (sessionId: string, query: string, signal?: AbortSignal) =>
    getJson(
      `${SESSION_ROUTES.search()}?${new URLSearchParams({ q: query, sessionId, limit: '50' })}`,
      sessionSearchResponse,
      signal,
    ),
  exportUrl: (sessionId: string) =>
    `${SESSION_ROUTES.export(sessionId)}?${new URLSearchParams({ exportVersion: String(SESSION_EXPORT_MAX_VERSION) })}`,

  /** Every persisted event in order, page by page. */
  async allEvents(sessionId: string, signal?: AbortSignal): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    let after = 0
    while (true) {
      const page = await getJson(
        `${SESSION_ROUTES.events(sessionId)}?after=${after}&limit=500&eventVersion=${SESSION_EVENT_MAX_VERSION}`,
        sessionEventsResponse,
        signal,
      )
      events.push(...page.events)
      if (!page.hasMore || page.events.length === 0) return events
      after = page.nextAfter
    }
  },

  /** Live tail after `afterSeq`; persisted first, so a reconnect neither loses nor repeats events. */
  live(
    sessionId: string,
    afterSeq: number,
    signal: AbortSignal,
    handlers: { onOpen?: () => void; onReconnect?: () => void } = {},
  ): AsyncIterable<SessionEvent> {
    return sseStream({
      url: `${SESSION_ROUTES.stream(sessionId)}?after=${afterSeq}&eventVersion=${SESSION_EVENT_MAX_VERSION}`,
      method: 'GET',
      schema: sessionEventSchema,
      signal,
      maxRetries: 5,
      lastEventId: afterSeq,
      sequenceOf: (event) => event.seq,
      onOpen: handlers.onOpen,
      onReconnect: handlers.onReconnect,
    })
  },
}
