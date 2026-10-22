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
import { nativeAgentInputSchema } from '../native-agent.ts'
import {
  contextStateSchema,
  jobStateSchema,
  safeJobMetadataSchema,
  toolCallStatusSchema,
  turnTerminalOutcomeSchema,
  usageSchema,
} from '../schemas.ts'

export const SESSION_EVENT_VERSION = 1
/** The first event envelope that can carry a bounded input artifact reference. */
export const SESSION_EVENT_VERSION_2 = 2
export const SESSION_EVENT_MAX_VERSION = 2

/**
 * Representation policy, not an acceptance cap: an event stores its input
 * inline at or below this scrubbed UTF-8 size and as a local artifact above it.
 */
export const INPUT_INLINE_BYTES = 16 * 1024
/** The exact maximum scrubbed UTF-8 excerpt an artifact reference carries. */
export const INPUT_EXCERPT_BYTES = 8 * 1024
export const SESSION_INPUT_TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8' as const
export const SESSION_INPUT_JSON_MEDIA_TYPE = 'application/json' as const

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

export const sessionInputMediaTypeSchema = z.enum([
  SESSION_INPUT_TEXT_MEDIA_TYPE,
  SESSION_INPUT_JSON_MEDIA_TYPE,
])
export type SessionInputMediaType = z.infer<typeof sessionInputMediaTypeSchema>

const inputChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)

/**
 * The published reference a v2 event carries. There is deliberately no full
 * `text`/`arguments` field beside it, so a reference cannot be misused as
 * content. `excerptBytes` must equal the UTF-8 length of `excerpt`.
 */
export const sessionInputArtifactRefSchema = z
  .object({
    artifactId: z.string().uuid(),
    checksum: inputChecksumSchema,
    byteSize: z.number().int().positive().safe(),
    mediaType: sessionInputMediaTypeSchema,
    excerpt: z.string(),
    excerptBytes: z.number().int().nonnegative().max(INPUT_EXCERPT_BYTES).safe(),
  })
  .strict()
  .refine((value) => new TextEncoder().encode(value.excerpt).byteLength === value.excerptBytes, {
    message: 'An input excerpt must declare its exact UTF-8 byte length',
  })
export type SessionInputArtifactRef = z.infer<typeof sessionInputArtifactRefSchema>

/** The append-time descriptor; the log resolves the owned `artifactId`. */
export const sessionInputArtifactInputSchema = z
  .object({
    checksum: inputChecksumSchema,
    byteSize: z.number().int().positive().safe(),
    mediaType: sessionInputMediaTypeSchema,
    excerpt: z.string(),
  })
  .strict()
export type SessionInputArtifactInput = z.infer<typeof sessionInputArtifactInputSchema>

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

/** Append-time data for the two v2 producers (no content field). */
export const sessionEventDataV2Schemas = {
  prompt: z
    .object({
      origin: promptOriginSchema,
      messageId: id,
      attachmentCount: z.number().int().nonnegative(),
    })
    .strict(),
  'tool.call': z
    .object({
      toolCallId: id,
      name: z.string(),
      source: z.enum(['builtin', 'mcp']),
      parsedFrom: z.enum(['native', 'content_json']),
      diffPath: z.string().nullable(),
    })
    .strict(),
} as const
export type SessionEventV2Type = keyof typeof sessionEventDataV2Schemas

export const sessionEventDataSchemas = {
  'agent.policy': nativeAgentInputSchema.omit({ prompt: true }).extend({
    scratch: z.string(), roots: z.array(z.string()), attachments: z.array(z.string()),
    hiddenPaths: z.array(z.string()).optional(),
    nodePorts: z.array(z.number().int().min(1).max(65535)).optional(),
    runtimeBase: z.string().optional(),
    attachmentMetadata: z.array(z.object({ path: z.string(), mediaType: z.string(), displayName: z.string() }).strict()).optional(),
  }).strict(),
  'agent.state': z.object({ status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']), error: z.string().nullable() }).strict(),
  'agent.plan': z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'active', 'verification_requested']) }).strict()) }).strict(),
  'agent.queue': z.object({ items: z.array(z.object({ id: z.string(), text: z.string() }).strict()) }).strict(),
  'agent.note': z.object({ text: z.string() }).strict(),
  'run.lifecycle': z.object({
    reason: z.string().optional(),
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
export type SessionEventDataV2<T extends SessionEventV2Type> = z.infer<(typeof sessionEventDataV2Schemas)[T]>

/** The published v2 data shapes, after the log resolved the artifact id. */
export const promptV2DataSchema = sessionEventDataV2Schemas.prompt
  .extend({ artifact: sessionInputArtifactRefSchema })
  .strict()
export const toolCallV2DataSchema = sessionEventDataV2Schemas['tool.call']
  .extend({ artifact: sessionInputArtifactRefSchema })
  .strict()
export type PromptV2Data = z.infer<typeof promptV2DataSchema>
export type ToolCallV2Data = z.infer<typeof toolCallV2DataSchema>

/** Whether a type may use the v2 input-artifact envelope. */
export function sessionEventTypeSupportsV2(type: SessionEventType): type is SessionEventV2Type {
  return type === 'prompt' || type === 'tool.call'
}

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
      version: z.literal(SESSION_EVENT_VERSION),
      type: z.literal(type),
      class: z.literal('standard'),
      data: sessionEventDataSchemas[type] as (typeof sessionEventDataSchemas)[T],
    })
    .strict()
}

function v2InputEvent<T extends SessionEventV2Type>(type: T) {
  const data = type === 'prompt' ? promptV2DataSchema : toolCallV2DataSchema
  return z
    .object({
      ...envelope,
      version: z.literal(SESSION_EVENT_VERSION_2),
      type: z.literal(type),
      class: z.literal('standard'),
      data: data as T extends 'prompt' ? typeof promptV2DataSchema : typeof toolCallV2DataSchema,
    })
    .strict()
}

export const promptV2SessionEventSchema = v2InputEvent('prompt')
export const toolCallV2SessionEventSchema = v2InputEvent('tool.call')
export type PromptV2SessionEvent = z.infer<typeof promptV2SessionEventSchema>
export type ToolCallV2SessionEvent = z.infer<typeof toolCallV2SessionEventSchema>

export const reasoningSessionEventSchema = z
  .object({
    ...envelope,
    version: z.literal(SESSION_EVENT_VERSION),
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
  standardEvent('agent.policy'),
  standardEvent('agent.state'),
  standardEvent('agent.plan'),
  standardEvent('agent.queue'),
  standardEvent('agent.note'),
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
  promptV2SessionEventSchema,
  toolCallV2SessionEventSchema,
  reasoningSessionEventSchema,
])
export type SessionEvent = z.infer<typeof sessionEventSchema>

/** The excerpt/reference a reader may show; the full input never leaves the local store. */
export function inputArtifactOf(event: SessionEvent): SessionInputArtifactRef | null {
  if (event.version === SESSION_EVENT_VERSION_2) return event.data.artifact
  return null
}

/** Scrubbed prompt text a reader may show: v1 inline text or the v2 bounded excerpt. */
export function promptTextOf(event: Extract<SessionEvent, { type: 'prompt' }>): string {
  return event.version === SESSION_EVENT_VERSION ? event.data.text : event.data.artifact.excerpt
}

/** Scrubbed argument text a reader may show: v1 canonical JSON or the v2 bounded excerpt. */
export function toolCallArgumentsTextOf(event: Extract<SessionEvent, { type: 'tool.call' }>): string {
  return event.version === SESSION_EVENT_VERSION ? JSON.stringify(event.data.arguments) : event.data.artifact.excerpt
}
export type ReasoningSessionEvent = z.infer<typeof reasoningSessionEventSchema>
