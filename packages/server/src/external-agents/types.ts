import { z } from 'zod'

export const adapterIdSchema = z.enum(['claude-code', 'copilot', 'gemini-cli', 'opencode', 'goose', 'codex'])
export type AdapterId = z.infer<typeof adapterIdSchema>
export const roleSchema = z.enum(['lead', 'executor', 'reviewer', 'judge', 'advisor', 'scout'])
export type Role = z.infer<typeof roleSchema>
export const bindingSchema = z.object({
  connectionId: z.string().uuid(), backend: z.enum(['native', ...adapterIdSchema.options]),
  model: z.string().min(1), params: z.object({
    temperature: z.number().finite().optional(), maxTokens: z.number().int().positive().optional(),
    reasoning: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  }).strict().default({}),
}).strict()
export type RoleBinding = z.infer<typeof bindingSchema>
export const rolesSchema = z.object({
  lead: bindingSchema.nullable().optional(), executor: bindingSchema.nullable().optional(),
  reviewer: bindingSchema.nullable().optional(), judge: bindingSchema.nullable().optional(),
  advisor: bindingSchema.nullable().optional(), scout: bindingSchema.nullable().optional(),
}).strict()
export type Roles = z.infer<typeof rolesSchema>

export class ExternalAgentError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'ExternalAgentError'; this.code = code }
}
export function resolveRole(role: Role, session: Roles, project: Roles) {
  roleSchema.parse(role); rolesSchema.parse(session); rolesSchema.parse(project)
  const source = session[role] !== undefined ? 'session' : 'project'
  const binding = source === 'session' ? session[role] : project[role]
  if (!binding) throw new ExternalAgentError('role_unassigned')
  return { binding: bindingSchema.parse(binding), source } as const
}

/** Trusted node configuration, never a request body or a replicated credential. */
export interface AgentInstallation {
  adapter: AdapterId
  connectionId: string
  ownerAccountId: string
  nodeId: string
  /** Owner-supplied opaque grouping key, identical for the same vendor account on other nodes. */
  billingAccount: string
  executable: string
  /** Exact version expected in ACP agentInfo / Codex initialize userAgent. */
  version: string
  /** Required for Claude's separately installed ACP bridge. */
  claudeExecutable?: string
  claudeBare?: boolean
  /** Explicit operator policy, not a vendor limit. Default 1 (conservative serialization). */
  concurrency?: number
}
export interface ExternalPolicy {
  nodeId: string
  installations: readonly AgentInstallation[]
  /** Transport safety and liveness policies, not model context/output limits. */
  frameBytes?: number
  requestTimeoutMs?: number
  quotaMaxAgeMs?: number
}
export interface Fact<T> {
  value: T | null
  source: string
  observedAt: string | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
}
export interface QuotaWindow {
  name: string
  usedPercent: number | null
  resetsAt: string | null
}
export interface QuotaObservation {
  ownerAccountId: string
  billingAccount: string
  adapter: AdapterId
  nodeId: string
  source: string
  observedAt: string
  confidence: 'high' | 'medium' | 'low'
  windows: QuotaWindow[]
}
export const quotaObservationSchema = z.object({
  ownerAccountId: z.string().min(1), billingAccount: z.string().min(1), adapter: adapterIdSchema,
  nodeId: z.string().min(1), source: z.string().min(1), observedAt: z.string().datetime(),
  confidence: z.enum(['high', 'medium', 'low']),
  windows: z.array(z.object({ name: z.string().min(1), usedPercent: z.number().finite().min(0).max(100).nullable(), resetsAt: z.string().datetime().nullable() }).strict()),
}).strict()
export interface AgentOutput {
  text: string
  stopReason: string
}
