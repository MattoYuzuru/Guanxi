import { z } from 'zod'
export const accessModeSchema = z.enum(['read-only', 'full-access'])
export type AccessMode = z.infer<typeof accessModeSchema>
export const nativeAgentInputSchema = z.object({
  projectId: z.string().min(1), connectionId: z.string().min(1), model: z.string().min(1),
  mode: accessModeSchema.default('read-only'), prompt: z.string().min(1),
  domains: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/)).default([]),
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
}).strict()
export type AgentProgress = z.infer<typeof agentProgressSchema>
