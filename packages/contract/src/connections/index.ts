import { z } from 'zod'

export const connectionKindSchema = z.enum(['agent', 'model_api', 'local_runtime', 'service'])
export const connectionProviderSchema = z.enum([
  'claude-code', 'codex', 'copilot', 'anthropic', 'openai', 'google',
  'openrouter', 'deepseek', 'ollama', 'brave', 'tavily', 'openai-stt',
])
export const connectionFactSchema = z.object({
  value: z.union([z.string(), z.number().finite(), z.boolean()]).nullable(),
  source: z.string().min(1),
  observedAt: z.string().datetime().nullable(),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
}).strict()
export const connectionBalanceSchema = z.object({
  scope: z.enum(['key_allowance', 'account_balance']).optional(),
  amount: z.number().finite().nullable(),
  currency: z.enum(['USD', 'CNY']).nullable(),
  source: z.string().min(1),
  // Old or incomplete observations remain representable, but must render unknown.
  observedAt: z.string().datetime().nullish(),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
}).strict()
export const secretReferenceSchema = z.string().regex(/^secret:\/\/[A-Za-z0-9_-]+\/[0-9a-f-]{36}$/)
/** Owner-pinned API root, never accepted on a completion request. */
export const connectionBaseUrlSchema = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { return false }
}, 'API root requires HTTPS (or loopback HTTP) without credentials, query or fragment')
export const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: connectionKindSchema,
  provider: connectionProviderSchema,
  auth: z.enum(['api_key', 'cli_login', 'none']),
  unattended: z.boolean().default(false),
  baseUrl: connectionBaseUrlSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const agents = ['claude-code', 'codex', 'copilot']
  const models = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek']
  const valid = value.kind === 'agent'
    ? agents.includes(value.provider) && value.auth === 'cli_login'
    : value.kind === 'model_api'
      ? models.includes(value.provider) && value.auth === 'api_key'
      : value.kind === 'local_runtime'
        ? value.provider === 'ollama' && value.auth === 'none'
        : ['brave', 'tavily', 'openai-stt'].includes(value.provider) && value.auth === 'api_key'
  if (value.baseUrl && (value.provider !== 'openai' || value.kind !== 'model_api')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Custom API roots require an OpenAI-compatible model connection' })
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported connection route' })
})
export const connectionSchema = z.object({
  id: z.string().uuid(), accountId: z.string().min(1), name: z.string(),
  kind: connectionKindSchema, provider: connectionProviderSchema,
  auth: z.enum(['api_key', 'cli_login', 'none']), unattended: z.boolean(),
  baseUrl: connectionBaseUrlSchema.optional(),
  secretRef: secretReferenceSchema.nullable(),
  facts: z.record(connectionFactSchema), balance: connectionBalanceSchema.nullable(),
  createdAt: z.string().datetime(),
}).strict()
export const updateConnectionSchema = z.object({ unattended: z.boolean() }).strict()
export const connectionSecretInputSchema = z.object({ value: z.string().min(8).max(16384) }).strict()
export const connectionCostSchema = z.object({
  id: z.string().uuid(), connectionId: z.string().uuid(), accountId: z.string(),
  runId: z.string().min(1), requestId: z.string().min(1),
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
  source: z.string().min(1), observedAt: z.string().datetime(),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
}).strict()
export const connectionSnapshotSchema = z.object({
  connections: z.array(connectionSchema), costs: z.array(connectionCostSchema),
  vault: z.object({ unlocked: z.boolean(), unattendedAvailable: z.boolean() }).strict(),
}).strict()
export type Connection = z.infer<typeof connectionSchema>
export type CreateConnection = z.input<typeof createConnectionSchema>
export type ConnectionFact = z.infer<typeof connectionFactSchema>
export type ConnectionBalance = z.infer<typeof connectionBalanceSchema>
export type ConnectionCost = z.infer<typeof connectionCostSchema>
export type ConnectionSnapshot = z.infer<typeof connectionSnapshotSchema>


/** Stable recovery categories; raw provider/keychain errors never cross the wire. */
export const connectionErrorCodeSchema = z.enum([
  'connection_not_found', 'vault_locked', 'policy_denied', 'egress_unavailable',
  'internal_error', 'validation_failed', 'quota_exhausted', 'provider_failed',
])
export const connectionErrorSchema = z.object({ code: connectionErrorCodeSchema }).strict()
export type ConnectionErrorCode = z.infer<typeof connectionErrorCodeSchema>

/** Generic picker data; selection is opaque to clients and persists as Thread.model. */
export const chatModelSelection = (connectionId: string, modelId: string): string =>
  `k3:${connectionId}:${encodeURIComponent(modelId)}`
export function parseChatModelSelection(value: string): { connectionId: string; modelId: string } | null {
  const match = /^k3:([0-9a-f-]{36}):(.+)$/.exec(value)
  if (!match) return null
  try { return { connectionId: z.string().uuid().parse(match[1]), modelId: decodeURIComponent(match[2]!) } } catch { return null }
}
export const chatModelsResponse = z.object({ groups: z.array(z.object({
  id: z.string(), label: z.string(), kind: z.enum(['local', 'provider']),
  models: z.array(z.object({ selection: z.string(), modelId: z.string(),
    source: z.string(), observedAt: z.string().datetime(), confidence: z.enum(['medium', 'low']),
  }).strict()),
}).strict()) }).strict()
export type ChatModelsResponse = z.infer<typeof chatModelsResponse>
