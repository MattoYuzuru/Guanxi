/**
 * Interim inspector and agent query tool over the session log (K2, ADR-0023 §5).
 * People read every event; agents read through the query tool with an audience
 * decided by the node, never by the agent.
 */
import { z } from 'zod'
import { contextStateSchema } from '../schemas.ts'
import {
  sessionAudienceSchema,
  sessionEventClassSchema,
  sessionEventSchema,
  sessionEventTypeSchema,
  sessionKindSchema,
  sessionSpanKindSchema,
} from './session-events.ts'

export const SESSION_EXPORT_VERSION = 1

const sessionId = z.string().min(1).max(200)

export const sessionPathParams = z.object({ sessionId }).strict()

export const sessionTokenMeterSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    /** Usage events counted. */
    samples: z.number().int().nonnegative(),
    /** Latest context window state, or null when the session reported none. */
    context: contextStateSchema.nullable(),
  })
  .strict()
export type SessionTokenMeter = z.infer<typeof sessionTokenMeterSchema>

export const sessionListItemSchema = z
  .object({
    sessionId,
    kind: sessionKindSchema,
    threadId: z.string().nullable(),
    title: z.string().nullable(),
    createdAt: z.string().datetime(),
    lastSeq: z.number().int().nonnegative(),
    lastEventAt: z.string().datetime().nullable(),
  })
  .strict()
export type SessionListItem = z.infer<typeof sessionListItemSchema>

export const listSessionsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict()
export const listSessionsResponse = z.object({ sessions: z.array(sessionListItemSchema) }).strict()
export type ListSessionsResponse = z.infer<typeof listSessionsResponse>

export const sessionSummarySchema = sessionListItemSchema
  .extend({
    /** Events per type, reasoning included (people see every event). */
    counts: z.record(sessionEventTypeSchema, z.number().int().nonnegative()),
    eventCount: z.number().int().nonnegative(),
    reasoningPurged: z.number().int().nonnegative(),
    redactions: z.number().int().nonnegative(),
    tokens: sessionTokenMeterSchema,
  })
  .strict()
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const sessionEventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict()
export type SessionEventsQuery = z.infer<typeof sessionEventsQuery>

export const sessionEventsResponse = z
  .object({
    sessionId,
    events: z.array(sessionEventSchema),
    /** Cursor for the next page: the last returned `seq`, or `after` when empty. */
    nextAfter: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict()
export type SessionEventsResponse = z.infer<typeof sessionEventsResponse>

export const sessionSpanSchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    kind: sessionSpanKindSchema,
    label: z.string(),
    firstSeq: z.number().int().positive(),
    lastSeq: z.number().int().positive(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    eventCount: z.number().int().positive(),
    /** Terminal Job state for a turn, tool status for a tool, null otherwise. */
    status: z.string().nullable(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  })
  .strict()
export type SessionSpan = z.infer<typeof sessionSpanSchema>

export const sessionSpansResponse = z
  .object({ sessionId, spans: z.array(sessionSpanSchema) })
  .strict()
export type SessionSpansResponse = z.infer<typeof sessionSpansResponse>

export const sessionSearchQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    sessionId: sessionId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
export type SessionSearchQuery = z.infer<typeof sessionSearchQuery>

export const sessionSearchHitSchema = z
  .object({
    sessionId,
    seq: z.number().int().positive(),
    type: sessionEventTypeSchema,
    class: sessionEventClassSchema,
    /** Matched terms are wrapped in U+E000 … U+E001; clients render them as marks. */
    snippet: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict()
export type SessionSearchHit = z.infer<typeof sessionSearchHitSchema>

export const SEARCH_MATCH_OPEN = '\uE000'
export const SEARCH_MATCH_CLOSE = '\uE001'

export const sessionSearchResponse = z
  .object({ query: z.string(), hits: z.array(sessionSearchHitSchema) })
  .strict()
export type SessionSearchResponse = z.infer<typeof sessionSearchResponse>

/** Exports never contain reasoning (ADR-0023 §3) and are scrubbed again on the way out. */
export const sessionExportSchema = z
  .object({
    exportVersion: z.literal(SESSION_EXPORT_VERSION),
    sessionId,
    exportedAt: z.string().datetime(),
    lastSeq: z.number().int().nonnegative(),
    excluded: z.object({ reasoning: z.number().int().nonnegative() }).strict(),
    events: z.array(sessionEventSchema),
  })
  .strict()
  .refine((value) => value.events.every((event) => event.class !== 'reasoning'), {
    message: 'Exports never contain reasoning',
  })
export type SessionExport = z.infer<typeof sessionExportSchema>

export const SESSION_QUERY_TOOL_NAME = 'session_log_query'

export const sessionQueryToolArgsSchema = z
  .object({
    text: z.string().trim().min(1).max(200).optional(),
    types: z.array(sessionEventTypeSchema).min(1).max(20).optional(),
    afterSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
export type SessionQueryToolArgs = z.infer<typeof sessionQueryToolArgsSchema>

export const sessionQueryToolResultSchema = z
  .object({
    sessionId,
    audience: sessionAudienceSchema,
    events: z.array(sessionEventSchema),
    /** True when the audience excluded reasoning events from this answer. */
    reasoningExcluded: z.boolean(),
  })
  .strict()
export type SessionQueryToolResult = z.infer<typeof sessionQueryToolResultSchema>

export const SESSION_ROUTES = {
  sessions: () => '/api/sessions',
  search: () => '/api/sessions/search',
  session: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`,
  events: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/events`,
  stream: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/stream`,
  spans: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/spans`,
  export: (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/export`,
} as const
