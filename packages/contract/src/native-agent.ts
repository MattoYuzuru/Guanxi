import { z } from 'zod'
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
export const nativeAgentInputSchema = z.object({
  projectId: z.string().min(1), connectionId: z.string().min(1), model: z.string().min(1),
  mode: accessModeSchema.default('read-only'), prompt: z.string().min(1),
  domains: z.array(domainSchema).default([]),
  protectedPaths: z.array(z.string()).default([]),
  attachmentIds: z.array(z.string()).default([]),
  contextTokens: z.number().int().positive().optional(),
}).strict()
export type NativeAgentInput = z.infer<typeof nativeAgentInputSchema>
export const nativeAgentPromptSchema = z.object({ text: z.string().trim().min(1) }).strict()
export const nativeProjectRootsInputSchema = z.object({ workspaceIds: z.array(z.string().min(1)) }).strict()
export const agentExecResultSchema = z.object({
  version: z.literal(1), sessionId: z.string().nullable(),
  status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
  text: z.string(), error: z.string().nullable(),
}).strict()
export type AgentExecResult = z.infer<typeof agentExecResultSchema>
export const agentProgressSchema = z.object({
  sessionId: z.string(), projectId: z.string(), connectionId: z.string(), model: z.string(), mode: accessModeSchema,
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  plan: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'active', 'verification_requested']) })),
  queue: z.array(z.object({ id: z.string(), text: z.string() })),
  summary: z.string(), error: z.string().nullable(), observedAt: z.string(), source: z.literal('session.log'), confidence: z.literal('high'),
  shellUnavailable: z.enum(['container_runtime_unavailable', 'container_path_unsupported', 'container_home_root_denied', 'container_runtime_protected']).optional(),
}).strict()
export type AgentProgress = z.infer<typeof agentProgressSchema>
