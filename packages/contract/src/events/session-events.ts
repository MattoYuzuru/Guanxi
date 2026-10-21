/**
 * Session event log schemas (K2, ADR-0023).
 *
 * One append-only log per session. Every event carries a monotonic `seq`
 * without gaps, the writer epoch that appended it, and an optional span. Event
 * payloads were scrubbed by the egress scrubber before they were stored.
 * Reasoning events form their own class: people and agents on local runtimes
 * may read them; agents on remote providers never receive them (D-113).
 */
import { z } from 'zod'
import {
  contextStateSchema,
  jobStateSchema,
  safeJobMetadataSchema,
  toolCallStatusSchema,
  turnTerminalOutcomeSchema,
  usageSchema,
} from '../schemas.ts'

export const SESSION_EVENT_VERSION = 1

/**
 * Redaction markers in scrubbed payloads (D-141): `⟦REDACTED secret://ref⟧`.
 * The egress scrubber writes them; clients render them. Registered secret
 * values may not contain the delimiters, so a marker is unambiguous.
 */
export const REDACTION_MARKER_OPEN = '\u27E6'
export const REDACTION_MARKER_CLOSE = '\u27E7'
export const REDACTION_MARKER_PREFIX = `${REDACTION_MARKER_OPEN}REDACTED `

export const sessionKindSchema = z.enum(['chat', 'agent'])
export type SessionKind = z.infer<typeof sessionKindSchema>

export const sessionEventClassSchema = z.enum(['standard', 'reasoning'])
export type SessionEventClass = z.infer<typeof sessionEventClassSchema>

/** Who reads the log. `remote_agent` never receives reasoning events. */
export const sessionAudienceSchema = z.enum(['person', 'local_agent', 'remote_agent'])
export type SessionAudience = z.infer<typeof sessionAudienceSchema>

export const promptOriginSchema = z.enum(['typed', 'voice', 'queued', 'remote', 'delegated'])
export type PromptOrigin = z.infer<typeof promptOriginSchema>

/**
 * Why a writer epoch began. The epoch is a process-level fencing token for one
 * node database, not an ADR-0018 lease: `writer_process_gone` hands over before
 * expiry when the previous process is known to be dead.
 */
export const sessionWriterReasonSchema = z.enum([
  'initial',
  'released',
  'expired',
  'writer_process_gone',
])
export type SessionWriterReason = z.infer<typeof sessionWriterReasonSchema>

export const sessionSpanKindSchema = z.enum(['turn', 'step', 'tool'])
export type SessionSpanKind = z.infer<typeof sessionSpanKindSchema>

const id = z.string().min(1).max(200)

export const runStateSchema = z.enum([
  'submitted', 'working', 'waiting_children', 'input_required', 'wrapping_up',
  'completed', 'failed', 'canceled', 'rejected', 'interrupted',
])
export type RunState = z.infer<typeof runStateSchema>
export const RUN_A2A_STATE = {
  submitted: 'submitted', working: 'working', waiting_children: 'working',
  input_required: 'input-required', wrapping_up: 'working', completed: 'completed',
  failed: 'failed', canceled: 'canceled', rejected: 'rejected', interrupted: 'failed',
} as const satisfies Record<RunState, string>

export const sessionEventDataSchemas = {
  'run.lifecycle': z.object({
    runId: id,
    state: runStateSchema,
    version: z.number().int().positive(),
    action: z.enum(['created', 'attempt', 'model_started', 'delegated', 'resolved', 'wake',
      'acknowledged', 'signal', 'wrapping_up', 'input_required', 'terminal', 'canceled',
      'interrupted', 'resource', 'cost', 'yielded']),
    relatedId: id.nullable(),
    wakeSeq: z.number().int().nonnegative().nullable(),
  }).strict(),
  'session.created': z.object({ kind: sessionKindSchema, threadId: id.nullable() }).strict(),
  'writer.acquired': z
    .object({
      epoch: z.number().int().positive(),
      previousEpoch: z.number().int().positive().nullable(),
      reason: sessionWriterReasonSchema,
    })
    .strict(),
  prompt: z
    .object({
      origin: promptOriginSchema,
      messageId: id,
      text: z.string(),
      attachmentCount: z.number().int().nonnegative(),
    })
    .strict(),
  'assistant.started': z
    .object({ messageId: id, model: z.string(), step: z.number().int().nonnegative() })
    .strict(),
  'assistant.message': z
    .object({ messageId: id.nullable(), step: z.number().int().nonnegative().nullable(), text: z.string() })
    .strict(),
  reasoning: z
    .object({ messageId: id.nullable(), step: z.number().int().nonnegative().nullable(), text: z.string() })
    .strict(),
  'tool.call': z
    .object({
      toolCallId: id,
      name: z.string(),
      arguments: z.record(z.unknown()),
      source: z.enum(['builtin', 'mcp']),
      parsedFrom: z.enum(['native', 'content_json']),
      /**
       * Only the path of a write preview; the preview's before/after text is not
       * stored. Tool arguments and results are stored as the tool saw them
       * (scrubbed); bounding them is K4's (ADR-0023 §4).
       */
      diffPath: z.string().nullable(),
    })
    .strict(),
  'tool.approval': z.object({ toolCallId: id, timeoutMs: z.number().int() }).strict(),
  'tool.result': z
    .object({
      toolCallId: id,
      status: toolCallStatusSchema,
      result: z.string().nullable(),
      error: z.string().nullable(),
      durationMs: z.number().int(),
    })
    .strict(),
  usage: usageSchema.strict(),
  context: contextStateSchema.strict(),
  'job.lifecycle': z
    .object({
      jobSequence: z.number().int().positive(),
      state: jobStateSchema,
      phase: z.string().nullable(),
      metadata: safeJobMetadataSchema,
    })
    .strict(),
  intervention: z.object({ action: z.literal('stop'), reason: z.string() }).strict(),
  error: z.object({ code: z.string(), message: z.string() }).strict(),
  'turn.done': z
    .object({
      messageId: id,
      outcome: turnTerminalOutcomeSchema.nullable(),
      stopReason: z.string(),
      steps: z.number().int().nonnegative(),
    })
    .strict(),
} as const

export type SessionEventType = keyof typeof sessionEventDataSchemas
export type SessionEventData<T extends SessionEventType> = z.infer<(typeof sessionEventDataSchemas)[T]>

export const SESSION_EVENT_TYPES = Object.keys(sessionEventDataSchemas) as SessionEventType[]
export const sessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES as [SessionEventType, ...SessionEventType[]])

/** Event types whose class is `reasoning`. */
export const REASONING_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set(['reasoning'])

export function sessionEventClassOf(type: SessionEventType): SessionEventClass {
  return REASONING_EVENT_TYPES.has(type) ? 'reasoning' : 'standard'
}

const envelope = {
  sessionId: id,
  seq: z.number().int().positive(),
  id: z.string().uuid(),
  version: z.literal(SESSION_EVENT_VERSION),
  spanId: id.nullable(),
  parentSpanId: id.nullable(),
  jobId: id.nullable(),
  writerEpoch: z.number().int().positive(),
  /** Redaction markers the scrubber inserted into this event. */
  redactions: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}

function standardEvent<T extends Exclude<SessionEventType, 'reasoning'>>(type: T) {
  return z
    .object({
      ...envelope,
      type: z.literal(type),
      class: z.literal('standard'),
      data: sessionEventDataSchemas[type] as (typeof sessionEventDataSchemas)[T],
    })
    .strict()
}

export const reasoningSessionEventSchema = z
  .object({
    ...envelope,
    type: z.literal('reasoning'),
    class: z.literal('reasoning'),
    /** `null` once retention purged the content; the event itself stays. */
    data: sessionEventDataSchemas.reasoning.nullable(),
    expiresAt: z.string().datetime(),
    purgedAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine((event) => (event.data === null) === (event.purgedAt !== null), {
    message: 'A reasoning event has data exactly until it is purged',
  })

export const sessionEventSchema = z.union([
  standardEvent('session.created'),
  standardEvent('run.lifecycle'),
  standardEvent('writer.acquired'),
  standardEvent('prompt'),
  standardEvent('assistant.started'),
  standardEvent('assistant.message'),
  standardEvent('tool.call'),
  standardEvent('tool.approval'),
  standardEvent('tool.result'),
  standardEvent('usage'),
  standardEvent('context'),
  standardEvent('job.lifecycle'),
  standardEvent('intervention'),
  standardEvent('error'),
  standardEvent('turn.done'),
  reasoningSessionEventSchema,
])
export type SessionEvent = z.infer<typeof sessionEventSchema>
export type ReasoningSessionEvent = z.infer<typeof reasoningSessionEventSchema>
