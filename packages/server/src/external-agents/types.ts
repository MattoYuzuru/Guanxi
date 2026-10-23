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
  /** Claude Code only: the bridge's `effort` config option applied to every session (operator policy, not a vendor limit).
   * It is a launch-time choice made through the ACP client; the vendor's settings files are never edited. */
  claudeEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Explicit operator policy, not a vendor limit. Default 1 (conservative serialization). */
  concurrency?: number
}
export interface ExternalPolicy {
  nodeId: string
  installations: readonly AgentInstallation[]
  /** Transport safety and liveness policies, not model context/output limits. */
  frameBytes?: number
  /** Wall-clock deadline for one agent run. A timeout is reported as `timeout`. */
  runDeadlineMs?: number
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
  windows: z.array(z.object({ name: z.string().min(1), usedPercent: z.number().finite().min(0).nullable(), resetsAt: z.string().datetime().nullable() }).strict()),
}).strict()
export interface AgentOutput {
  text: string
  stopReason: string
  /** Lead turns only: the latest cumulative usage the agent reported for its ACP session. */
  usage?: LeadUsage | null
}

/** LW lead extension: an ACP turn that exposes a node-owned HTTP MCP tool, can load a saved
 * session and can be hibernated cooperatively. Nothing here carries a credential from a vendor. */
export interface LeadMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}
/** Cumulative per ACP session, as reported by the agent; null means not reported. */
export interface LeadUsage {
  inputTokens: number | null
  outputTokens: number | null
  cost: { amount: number; currency: string } | null
}
export interface LeadSessionInfo {
  acpSessionId: string
  /** `seeded`: a resume was requested but a new session replaced it. */
  mode: 'new' | 'load' | 'seeded'
  loadSession: boolean
}
export interface LeadTurn {
  mcpServers: readonly LeadMcpServer[]
  resume: { acpSessionId: string } | null
  /** Prompt used instead of the main one when a requested resume opens a new session. */
  seededPrompt?: string
  /** Aborting asks the agent to cancel its turn and return its final usage. */
  hibernateSignal: AbortSignal
  cancelGraceMs?: number
  onSession(info: LeadSessionInfo): void
  /** First `session/update` of the prompt, of any kind (including dropped thought chunks). */
  onActivity(): void
  onUsage(usage: LeadUsage): void
}

/** Durable same-node admission is local account coordination, never a vendor cap or lease. */
export type AdmissionKind = 'run' | 'login'
export type AdmissionState = 'held' | 'cleanup_unconfirmed'
export type AdmissionCleanupReason = 'group_timeout' | 'permission_denied' | 'close_error' | 'unsupported_platform'
export interface AdmissionHolder {
  holderId: string
  instanceId: string
  owner: string
  adapter: AdapterId
  billingAccount: string
  kind: AdmissionKind
  policyDigest: string
  createdAt: string
  state: AdmissionState
}
/** Boot reconciliation facts (v3). They never authorize a signal on their own: see `reconcileAdmission`. */
export interface AdmissionProcess {
  ownerPid: number
  /** Real boot identifier of the machine boot that wrote the holder; null when it could not be read (no reboot is then provable). */
  bootId: string | null
  phase: 'prepared' | 'spawning' | 'running'
  groupId: number | null
  groupStartedAt: number | null
}
export interface AdmissionRequest {
  /** The node process that owns the holder; stored so a later boot can prove it dead. */
  process?: { pid: number; bootId: string | null }
  instanceId: string
  owner: string
  adapter: AdapterId
  billingAccount: string
  kind: AdmissionKind
  policyDigest: string
  ceiling: number
}
export interface AdmissionGrant {
  holder: AdmissionHolder
  /** Run rows committed by this transaction, including the new holder. */
  admittedRuns: number
}
export interface AdmissionOccupancy {
  held: number
  cleanupUnconfirmed: number
  total: number
}
