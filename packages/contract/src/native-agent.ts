import { z } from 'zod'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  queueArtifactV3Schema,
  queueInlineV3Schema,
} from './events/queue-v3.ts'
export const accessModeSchema = z.enum(['read-only', 'full-access'])
export type AccessMode = z.infer<typeof accessModeSchema>
/** IP and localhost grants name one TCP service, never every local/LAN port. */
const domainSchema = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/).refine(value => {
  try {
    const url = new URL(`http://${value}`)
    // WHATWG URL normalizes numeric IPv4 aliases (0, 0x0, octal, shortened).
    const requiresPort = url.hostname.startsWith('[') || /^[0-9.]+$/.test(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    const port = /(?:\]|[^:]):([0-9]+)$/.exec(value)?.[1]
    const explicitPort = port !== undefined && Number(port) >= 1 && Number(port) <= 65535
    return (!requiresPort || explicitPort) && (port === undefined || explicitPort)
  } catch { return false }
}, 'IP literal and localhost entries require an explicit TCP port (1–65535)')
export const nativeRunBudgetSchema = z.object({
  maxModelCalls: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  maxCostMicrounits: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  reportMaxCalls: z.number().int().nonnegative().default(1),
  reportMaxDurationMs: z.number().int().positive().default(10000),
}).strict()
export type NativeRunBudget = z.infer<typeof nativeRunBudgetSchema>
export const nativeRetentionInputSchema = z.object({ mode: z.enum(['keep', 'ttl', 'session']) }).strict()
export const nativeRetentionSchema = z.object({ mode: z.enum(['keep', 'ttl', 'session']), state: z.enum(['active', 'trash', 'deleting']), expiresAt: z.string().nullable(), recoveryDeadline: z.string().nullable() }).strict()
export const deleteNativeSessionResponseSchema = z.object({ sessionId: z.string(), deleted: z.literal(true) }).strict()
export const nativeAgentInputSchema = z.object({
  projectId: z.string().min(1), connectionId: z.string().min(1), model: z.string().min(1),
  mode: accessModeSchema.default('read-only'), prompt: z.string().min(1),
  domains: z.array(domainSchema).default([]),
  protectedPaths: z.array(z.string()).default([]),
  attachmentIds: z.array(z.string()).default([]),
  budget: nativeRunBudgetSchema.optional(),
  retention: z.enum(['keep', 'ttl', 'session']).default('ttl'),
  contextTokens: z.number().int().positive().optional(),
}).strict()
export type NativeAgentInput = z.infer<typeof nativeAgentInputSchema>
export const nativeAgentPromptSchema = z.object({ text: z.string().trim().min(1) }).strict()
export const nativeProjectRootsInputSchema = z.object({ workspaceIds: z.array(z.string().min(1)) }).strict()
export const agentExecResultSchema = z.object({
  version: z.literal(1), sessionId: z.string().nullable(),
  status: z.enum(['completed', 'failed', 'cancelled', 'interrupted', 'input_required']),
  text: z.string(), error: z.string().nullable(),
}).strict()
export type AgentExecResult = z.infer<typeof agentExecResultSchema>
export const agentProgressSchema = z.object({
  sessionId: z.string(), projectId: z.string(), connectionId: z.string(), model: z.string(), mode: accessModeSchema,
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'input_required']),
  plan: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'active', 'verification_requested']) })),
  queue: z.array(z.object({ id: z.string(), text: z.string() })),
  summary: z.string(), error: z.string().nullable(), observedAt: z.string(), source: z.literal('session.log'), confidence: z.literal('high'),
  retention: nativeRetentionSchema.optional(),
  shellUnavailable: z.enum(['container_runtime_unavailable', 'container_path_unsupported', 'container_home_root_denied', 'container_runtime_protected']).optional(),
}).strict()
export type AgentProgress = z.infer<typeof agentProgressSchema>

/**
 * Explicit negotiated progress query; omitting it keeps the legacy v1 body. Only the exact
 * strings `1` and `2` are accepted: no numeric coercion (` 2`, `02`, `2.0`, `0x2`, an empty
 * value) and no repeated key, which the route passes through as an array.
 */
export const agentProgressQuerySchema = z
  .object({
    progressVersion: z.enum(['1', '2']).default('1').transform((value) => (value === '2' ? 2 : 1) as 1 | 2),
  })
  .strict()
export type AgentProgressQuery = z.infer<typeof agentProgressQuerySchema>

/**
 * A pending oversized legacy-v1 queue entry. A read-only progress request
 * cannot fabricate a persisted artifact reference, so it reports the bounded
 * current-registry preview and the exact current byte size instead.
 */
export const agentProgressLegacyPreviewSchema = z
  .object({
    id: z.string(),
    kind: z.literal('legacy-preview'),
    excerpt: z.string(),
    excerptBytes: z.number().int().nonnegative().max(INPUT_EXCERPT_BYTES).safe(),
    byteSize: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => new TextEncoder().encode(value.excerpt).byteLength === value.excerptBytes, {
    message: 'A legacy preview must declare its exact UTF-8 byte length',
    path: ['excerptBytes'],
  })
  .refine((value) => value.byteSize > INPUT_INLINE_BYTES, {
    message: 'A legacy preview represents input above the inline byte bound',
    path: ['byteSize'],
  })
export type AgentProgressLegacyPreview = z.infer<typeof agentProgressLegacyPreviewSchema>

export const agentProgressQueueItemV2Schema = z.union([
  queueInlineV3Schema,
  queueArtifactV3Schema,
  agentProgressLegacyPreviewSchema,
])
export type AgentProgressQueueItemV2 = z.infer<typeof agentProgressQueueItemV2Schema>

export const agentProgressV2Schema = agentProgressSchema
  .omit({ queue: true })
  .extend({
    version: z.literal(2),
    queue: z.array(agentProgressQueueItemV2Schema),
  })
  .strict()
export type AgentProgressV2 = z.infer<typeof agentProgressV2Schema>

/** The exact content-free refusal when a legacy client asks for artifact-backed progress. */
export const nativeProgressVersionUnsupportedSchema = z
  .object({
    code: z.literal('native_progress_version_unsupported'),
    supported: z.literal(1),
    required: z.literal(2),
  })
  .strict()
export type NativeProgressVersionUnsupported = z.infer<typeof nativeProgressVersionUnsupportedSchema>

/**
 * Restricted-reader floor (Q1): while the latest pending queue snapshot is v3,
 * a node that still produces v1 refuses both add and remove with HTTP 409.
 * The body is content-free.
 */
export const nativeQueueProducerUnavailableSchema = z
  .object({ code: z.literal('native_queue_producer_unavailable') })
  .strict()
export type NativeQueueProducerUnavailable = z.infer<typeof nativeQueueProducerUnavailableSchema>
