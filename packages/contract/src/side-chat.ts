/**
 * Ephemeral side chat (D-135, ADR-0036, LAYOUT_AND_SCREENS W4).
 *
 * A side chat reads one native session and talks to that session's own model connection with
 * no tools. Its turns live only in the caller's memory: `respond` is stateless and writes nothing
 * to the session log. Two explicit, idempotent actions make anything durable:
 *
 * - `save` appends one `agent.note` event carrying the encoded transcript (history only: the
 *   native replay ignores notes, so a saved side chat never becomes agent context or input);
 * - `send` posts one message to the main session as a queued prompt, exactly once per operation.
 *
 * Operation ids are chosen by the client per distinct action and are the only retry identity.
 */
import { z } from 'zod'

export const SIDE_CHAT_SAVED_NOTE_KEY = 'sideChat'

export const sideChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().refine((text) => text.trim().length > 0, 'A message must not be blank'),
}).strict()
export type SideChatMessage = z.infer<typeof sideChatMessageSchema>

/** Which part of the session the side chat may read. `lastTurns` is an explicit, user-chosen bound. */
export const sideChatContextSchema = z.discriminatedUnion('include', [
  z.object({ include: z.literal('none') }).strict(),
  z.object({ include: z.literal('session'), lastTurns: z.number().int().positive().optional() }).strict(),
])
export type SideChatContext = z.infer<typeof sideChatContextSchema>

export const sideChatRespondRequestSchema = z.object({
  /** Correlates one request; never persisted. */
  requestId: z.string().uuid(),
  /** The in-memory draft conversation so far; the last message is the user's new question. */
  messages: z.array(sideChatMessageSchema).min(1),
  context: sideChatContextSchema,
}).strict().refine((request) => request.messages.at(-1)?.role === 'user', {
  message: 'The last message must be the user question',
  path: ['messages'],
})
export type SideChatRespondRequest = z.infer<typeof sideChatRespondRequestSchema>

export const sideChatContextFactsSchema = z.object({
  source: z.literal('session.log'),
  include: z.enum(['none', 'session']),
  /** The session log head the context was read at. */
  upToSeq: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
  turns: z.number().int().nonnegative(),
  /** Prompts whose full text is stored elsewhere and only a bounded excerpt was read. */
  excerpted: z.number().int().nonnegative(),
  /** UTF-8 bytes of the rendered context (an upper bound on its token count). */
  bytes: z.number().int().nonnegative(),
}).strict()
export type SideChatContextFacts = z.infer<typeof sideChatContextFactsSchema>

export const sideChatRespondResponseSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string(),
  /** The model stopped at its output limit, so the answer may be cut short. */
  truncated: z.boolean(),
  context: sideChatContextFactsSchema,
}).strict()
export type SideChatRespondResponse = z.infer<typeof sideChatRespondResponseSchema>

export const sideChatSaveRequestSchema = z.object({
  operationId: z.string().uuid(),
  messages: z.array(sideChatMessageSchema).min(1),
}).strict()
export type SideChatSaveRequest = z.infer<typeof sideChatSaveRequestSchema>
export const sideChatSaveResponseSchema = z.object({
  operationId: z.string().uuid(),
  eventId: z.string().min(1),
  seq: z.number().int().positive(),
  /** True when this operation had already been saved and nothing new was appended. */
  duplicate: z.boolean(),
}).strict()
export type SideChatSaveResponse = z.infer<typeof sideChatSaveResponseSchema>

export const sideChatSendRequestSchema = z.object({
  operationId: z.string().uuid(),
  text: z.string().refine((text) => text.trim().length > 0, 'A message must not be blank'),
}).strict()
export type SideChatSendRequest = z.infer<typeof sideChatSendRequestSchema>
export const sideChatSendResponseSchema = z.object({
  operationId: z.string().uuid(),
  /** The prompt id the main session records for this operation. */
  messageId: z.string().uuid(),
  delivery: z.enum(['queued', 'started', 'already_sent']),
  duplicate: z.boolean(),
}).strict()
export type SideChatSendResponse = z.infer<typeof sideChatSendResponseSchema>

export const sideChatErrorCodeSchema = z.enum([
  'validation_failed', 'session_not_found', 'session_unavailable', 'session_busy', 'egress_unavailable',
  'context_too_large', 'connection_unavailable', 'quota_exhausted', 'model_failed', 'operation_conflict',
  'cancelled', 'agent_unavailable', 'budget_exhausted', 'too_many_requests', 'too_large',
])
export type SideChatErrorCode = z.infer<typeof sideChatErrorCodeSchema>
export const sideChatErrorSchema = z.object({
  code: sideChatErrorCodeSchema,
  details: z.union([
    z.object({
      /** UTF-8 bytes of everything that would be sent: instructions, context and the whole draft conversation. */
      bytes: z.number().int().nonnegative(),
      boundBytes: z.number().int().nonnegative(),
      windowTokens: z.number().int().positive(),
      outputTokens: z.number().int().nonnegative(),
      source: z.string(),
    }).strict(),
    /** `too_large` on Save: the encoded transcript and the explicit bound it exceeded. */
    z.object({ bytes: z.number().int().nonnegative(), boundBytes: z.number().int().nonnegative() }).strict(),
  ]).optional(),
}).strict()
export type SideChatError = z.infer<typeof sideChatErrorSchema>

/** Explicit bound on one saved transcript (UTF-8 bytes of the encoded note). Larger chats are refused, never truncated. */
export const SIDE_CHAT_SAVE_MAX_BYTES = 256 * 1024

/** The saved transcript as stored in the `agent.note` text. Key order is fixed. */
export const sideChatSavedNoteSchema = z.object({
  [SIDE_CHAT_SAVED_NOTE_KEY]: z.literal('saved'),
  operationId: z.string().uuid(),
  messages: z.array(sideChatMessageSchema).min(1),
}).strict()
export type SideChatSavedNote = z.infer<typeof sideChatSavedNoteSchema>

export function encodeSideChatSavedNote(operationId: string, messages: readonly SideChatMessage[]): string {
  return JSON.stringify({ [SIDE_CHAT_SAVED_NOTE_KEY]: 'saved', operationId, messages: messages.map(({ role, text }) => ({ role, text })) })
}
/** `null` for any note that is not a saved side chat, so other `agent.note` producers are unaffected. */
export function parseSideChatSavedNote(text: string): SideChatSavedNote | null {
  try {
    const parsed = sideChatSavedNoteSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch { return null }
}
