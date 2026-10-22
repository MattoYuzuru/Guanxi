import { z } from 'zod'
import { nativeAgentInputSchema } from './native-agent.ts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
export const relayRelativePathSchema = z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => s === '..' || s === '.' || !s) && !p.startsWith('-'), 'relative path required')
export const relayPlanSchema = z.object({
  revision: id, base: z.string().regex(/^[a-f0-9]{40,64}$/), goal: z.string().min(1),
  items: z.array(z.object({ id, title: z.string().min(1), dependsOn: z.array(id),
    acceptance: z.array(z.string().min(1)).min(1), protectedPaths: z.array(relayRelativePathSchema),
  }).strict()).min(1), protectedPaths: z.array(relayRelativePathSchema),
}).strict().superRefine((p, ctx) => {
  const ids = new Set(p.items.map(i => i.id))
  if (ids.size !== p.items.length || p.items.some(i => i.dependsOn.some(d => !ids.has(d) || d === i.id))) {
    ctx.addIssue({ code: 'custom', message: 'invalid dependencies' }); return
  }
  const visit = (key: string, seen: Set<string>): boolean => !seen.has(key) &&
    p.items.find(i => i.id === key)!.dependsOn.every(d => visit(d, new Set([...seen, key])))
  if (!p.items.every(i => visit(i.id, new Set()))) ctx.addIssue({ code: 'custom', message: 'cyclic dependencies' })
})
export const relayCapsSchema = z.object({ cycles: z.number().int().positive().safe().nullable(), tokens: z.number().int().positive().safe().nullable(),
  moneyMicros: z.number().int().nonnegative().safe().nullable(), wallMs: z.number().int().positive().safe().nullable() }).strict()
export const relayReservesSchema = z.object({ turn: z.number().int().positive().safe(), safety: z.number().int().nonnegative().safe(),
  handoff: z.number().int().positive().safe(), tool: z.number().int().nonnegative().safe(), stepMedian: z.number().int().nonnegative().safe(),
  effective: z.number().int().positive().safe() }).strict()
export const relayStartInputSchema = z.object({
  key: id, projectId: z.string().min(1), connectionId: z.string().min(1), model: z.string().min(1),
  consent: z.literal('full-access'), domains: nativeAgentInputSchema.shape.domains,
  plan: relayPlanSchema, caps: relayCapsSchema,
}).strict()
export type RelayStartInput = z.infer<typeof relayStartInputSchema>
export const relayRuntimeFactSchema = z.object({ model: z.string().min(1), digest: z.string().min(1), contextTokens: z.number().int().positive().safe(),
  runtimeVersion: z.string().min(1), source: z.string().min(1), observedAt: z.number().int().nonnegative().safe(), confidence: z.literal('high') }).strict()
export type RelayRuntimeFact = z.infer<typeof relayRuntimeFactSchema>
export const relayMeterFactSchema = z.object({ source: z.string().min(1), observedAt: z.number().int().nonnegative().safe(),
  confidence: z.literal('high'), measurement: z.literal('exact_rendered_request'), framing: z.literal('included'),
  computeCost: z.literal('host_local_compute_policy') }).strict()
export type RelayMeterFact = z.infer<typeof relayMeterFactSchema>
export const relayStartStatusSchema = z.object({
  key: id, runId: z.string().nullable(), sessionId: z.string().nullable(),
  status: z.enum(['preparing', 'running', 'wrapping_up', 'input_required', 'completed', 'canceled', 'interrupted', 'failed']),
  error: z.string().nullable(), source: z.enum(['start-owner', 'run-home']), observedAt: z.string().datetime(), confidence: z.literal('observed'),
  runtime: relayRuntimeFactSchema.nullable(), runtimeAgeMs: z.number().int().nonnegative().safe().nullable(),
  meter: relayMeterFactSchema.nullable(),
  reserves: relayReservesSchema.nullable(),
}).strict()
export type RelayStartStatus = z.infer<typeof relayStartStatusSchema>
