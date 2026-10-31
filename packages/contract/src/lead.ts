import { z } from 'zod'
import { runStateSchema } from './events/session-events.ts'
import { relayCapsSchema, relayPlanSchema } from './relay.ts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
const positive = z.number().int().positive().safe()

/** ADR-0021 decision 5, the part an external lead supplies through `guanxi_delegate`.
 * Identity, roots, network policy, judges and wake policy are owned by the node and are
 * never accepted from the lead. `deadlineMs` is relative to the node clock at the call. */
export const leadDelegateInputSchema = z.object({
  objective: z.string().min(1).max(4_000),
  definitionOfDone: z.array(z.string().min(1).max(1_000)).min(1).max(50),
  plan: relayPlanSchema,
  /** Exact per-item estimates; when present they must cover every plan item and nothing else. */
  estimatesMs: z.record(id, positive).optional(),
  caps: relayCapsSchema,
  executor: z.object({ connectionId: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict(),
  deadlineMs: positive,
  onDeadline: z.enum(['wrap_up', 'detach']).default('wrap_up'),
  onCancel: z.enum(['cancel', 'detach']).default('cancel'),
}).strict().superRefine((brief, ctx) => {
  if (!brief.estimatesMs) return
  const items = new Set(brief.plan.items.map(item => item.id))
  const keys = Object.keys(brief.estimatesMs)
  if (keys.length !== items.size || keys.some(key => !items.has(key))) {
    ctx.addIssue({ code: 'custom', path: ['estimatesMs'], message: 'estimates must cover exactly the plan items' })
  }
})
export type LeadDelegateInput = z.infer<typeof leadDelegateInputSchema>

export const LEAD_DELEGATE_TOOL = 'guanxi_delegate'
/** The lead's read-only view of the delegated project's committed files, served by the node on the same per-turn tool server. */
export const LEAD_PROJECT_TREE_TOOL = 'guanxi_project_tree'
export const LEAD_PROJECT_READ_TOOL = 'guanxi_project_read'
export const LEAD_PROJECT_SEARCH_TOOL = 'guanxi_project_search'
export const LEAD_WAKE_FORMAT = 'guanxi.wake/v1'
export const leadWakeKindSchema = z.enum(['resolution', 'escalation', 'quota'])
export const leadWakeOutcomeSchema = z.enum(['completed', 'failed', 'canceled', 'deadline', 'pending'])

/** The bounded, scrubbed packet that resumes a hibernating lead (ADR-0019 decision 8).
 * It carries structured facts and references only; a full trace never appears here. */
export const leadWakePacketSchema = z.object({
  format: z.literal(LEAD_WAKE_FORMAT),
  runId: z.string().min(1),
  wakeSeq: z.number().int().positive().safe(),
  kind: leadWakeKindSchema,
  outcome: leadWakeOutcomeSchema,
  child: z.object({
    runId: z.string().min(1),
    state: runStateSchema,
    attempts: z.number().int().nonnegative().safe(),
    costs: z.array(z.object({
      currency: z.string().min(1), inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(), costMicrounits: z.number().int().nonnegative().safe().nullable(),
    }).strict()),
  }).strict(),
  items: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['open', 'verification_requested', 'done']) }).strict()),
  gates: z.array(z.object({ item: z.string(), ok: z.boolean(), head: z.string(), output: z.string() }).strict()),
  head: z.string().nullable(),
  diffstat: z.string(),
  handoff: z.object({ ref: z.string().min(1), cycle: z.number().int().nonnegative().safe().nullable() }).strict().nullable(),
  narrative: z.string(),
  openQuestions: z.array(z.string()),
  metrics: z.object({
    cycles: z.number().int().nonnegative().safe().nullable(), tokens: z.number().int().nonnegative().safe().nullable(),
    moneyMicros: z.number().int().nonnegative().safe().nullable(),
  }).strict(),
  drilldown: z.array(z.object({ kind: z.enum(['run', 'handoff']), id: z.string().min(1) }).strict()),
  /** Sections that were shortened or dropped to fit the budget, in the order they were reduced. */
  truncated: z.array(z.string()),
}).strict()
export type LeadWakePacket = z.infer<typeof leadWakePacketSchema>
