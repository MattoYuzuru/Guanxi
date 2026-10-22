/**
 * Wire contract for the project work ledger (WG1-a, ADR-0032).
 *
 * Evidence accepted over HTTP is limited to human decisions. The node fixes `source` to
 * `user:<account>` and stamps `at`, so a caller can never forge harness acceptance results, judge verdicts or
 * agent claims; those enter through kernel services only. Reading evidence returns every type.
 */
import { z } from 'zod'
import { relayRelativePathSchema } from './relay.ts'

export const WORK_MODES = ['off', 'run', 'project'] as const
export const WORK_OWNER_ROLES = ['lead', 'executor', 'reviewer'] as const
export const WORK_DERIVED_STATUSES = [
  'proposed', 'blocked', 'ready', 'in_progress', 'verification_requested', 'done', 'failed', 'canceled',
] as const
export const WORK_EVENT_TYPES = [
  'proposed', 'accepted', 'rejected', 'claimed', 'released', 'verification_requested',
  'acceptance_result', 'commit_accepted', 'judge_verdict', 'human_decision',
] as const
/** Event types the REST boundary appends (D-172 human decisions). */
export const WORK_WIRE_EVENT_TYPES = ['accepted', 'rejected', 'human_decision'] as const
/** Transport budget for one request body. */
export const WORK_BODY_MAX_BYTES = 2 * 1024 * 1024
export const WORK_QUERY_MAX_LIMIT = 1000

export const workProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
export const workModeSchema = z.enum(WORK_MODES)
export const workOwnerRoleSchema = z.enum(WORK_OWNER_ROLES)
export const workStatusSchema = z.enum(WORK_DERIVED_STATUSES)
const itemId = z.string().min(1).max(200)

/**
 * Read shape of an item. It carries no length caps: a row written by a kernel caller (a planner
 * lead, an importer) must never turn a read route into a 500. The caps live on the request below.
 */
export const workItemSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Executable definition of done, or `null` when only a human decision can close the item. */
  acceptance: z.string().nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
  estimateMinutes: z.number().finite().nonnegative().nullable().default(null),
  ownerRole: workOwnerRoleSchema.nullable().default(null),
  protectedPaths: z.array(z.string()).default([]),
}).strict()
export type WorkItemSpecWire = z.output<typeof workItemSpecSchema>

/** Request shape of an item: the same fields with transport caps and safe relative paths. */
export const workItemSpecInputSchema = workItemSpecSchema.extend({
  id: itemId,
  title: z.string().min(1).max(500),
  acceptance: z.string().max(4000).nullable().default(null),
  dependsOn: z.array(itemId).default([]),
  protectedPaths: z.array(relayRelativePathSchema).default([]),
}).strict()
export type WorkItemSpecInput = z.input<typeof workItemSpecInputSchema>

export const addWorkRevisionBodySchema = z.object({ items: z.array(workItemSpecInputSchema) }).strict()
export type AddWorkRevisionBody = z.input<typeof addWorkRevisionBodySchema>

export const workPlanRevisionSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().positive().safe(),
  createdAt: z.string().min(1),
  author: z.enum(['user', 'lead']),
  items: z.array(workItemSpecSchema),
}).strict()
export type WorkPlanRevisionWire = z.infer<typeof workPlanRevisionSchema>

export const latestWorkRevisionResponseSchema = z.object({ revision: workPlanRevisionSchema.nullable() }).strict()

const at = z.union([z.string().min(1), z.number().finite()])
const base = { itemId: z.string().min(1), at, source: z.string().min(1), seq: z.number().int().positive().safe().optional() }
/** Every evidence type, as stored. Only the human subset is writable. */
export const workEvidenceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('proposed'), ...base, item: workItemSpecSchema }).strict(),
  z.object({ type: z.literal('accepted'), ...base }).strict(),
  z.object({ type: z.literal('rejected'), ...base }).strict(),
  z.object({ type: z.literal('claimed'), ...base }).strict(),
  z.object({ type: z.literal('released'), ...base }).strict(),
  z.object({ type: z.literal('verification_requested'), ...base }).strict(),
  z.object({
    type: z.literal('acceptance_result'), ...base,
    passed: z.boolean(), commit: z.string().min(1), cleanCheckout: z.boolean(), command: z.string(),
  }).strict(),
  z.object({ type: z.literal('commit_accepted'), ...base, commit: z.string().min(1) }).strict(),
  z.object({ type: z.literal('judge_verdict'), ...base, verdict: z.enum(['pass', 'fail', 'escalate']) }).strict(),
  z.object({ type: z.literal('human_decision'), ...base, decision: z.enum(['done', 'reopen', 'cancel']) }).strict(),
])
export type WorkEvidenceEventWire = z.infer<typeof workEvidenceEventSchema>

/** No `source`, no `at`, no `projectId`: the node supplies provenance. */
export const appendWorkEventBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), itemId }).strict(),
  z.object({ type: z.literal('rejected'), itemId }).strict(),
  z.object({ type: z.literal('human_decision'), itemId, decision: z.enum(['done', 'reopen', 'cancel']) }).strict(),
])
export type AppendWorkEventBody = z.input<typeof appendWorkEventBodySchema>

export const appendWorkEventResponseSchema = z.object({
  seq: z.number().int().positive().safe(),
  event: workEvidenceEventSchema,
}).strict()
export type AppendWorkEventResponse = z.infer<typeof appendWorkEventResponseSchema>

export const workQueryItemSchema = workItemSpecSchema.extend({
  status: workStatusSchema,
  reason: z.string(),
  evidence: z.array(workEvidenceEventSchema),
}).strict()

/** `limit` omitted returns the whole matching graph; there is no hidden cap. */
export const listWorkItemsQuerySchema = z.object({
  status: workStatusSchema.optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/).optional(),
  limit: z.string().regex(/^[0-9]{1,4}$/).optional().transform((value, ctx) => {
    if (value === undefined) return undefined
    const limit = Number(value)
    if (limit < 1 || limit > WORK_QUERY_MAX_LIMIT) { ctx.addIssue({ code: 'custom', message: 'limit out of range' }); return z.NEVER }
    return limit
  }),
}).strict()
export type ListWorkItemsQuery = { status?: (typeof WORK_DERIVED_STATUSES)[number]; cursor?: string; limit?: number }

export const workItemsPageSchema = z.object({
  revision: z.number().int().positive().safe().nullable(),
  items: z.array(workQueryItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  warnings: z.array(z.object({
    itemId: z.string(), type: z.string(), reason: z.enum(['unknown_item', 'invalid_proposal', 'duplicate_proposal']),
  }).strict()),
}).strict()
export type WorkItemsPage = z.infer<typeof workItemsPageSchema>

export const workModeSnapshotSchema = z.object({
  projectId: z.string().min(1), mode: workModeSchema, reason: z.string(),
}).strict()
export type WorkModeSnapshot = z.infer<typeof workModeSnapshotSchema>
export const setWorkModeBodySchema = z.object({
  mode: workModeSchema, reason: z.string().trim().min(1).max(500),
}).strict()
export type SetWorkModeBody = z.infer<typeof setWorkModeBodySchema>

export const workExportResponseSchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().positive().safe(),
  markdown: z.string(),
}).strict()
export type WorkExportResponse = z.infer<typeof workExportResponseSchema>

export const WORK_ERROR_CODES = [
  'validation_failed', 'json_required', 'origin_denied', 'loopback_only', 'body_too_large',
  'revision_not_found', 'item_not_found', 'duplicate_item', 'missing_dependency', 'dependency_cycle', 'invalid_proposal',
  'item_canceled', 'invalid_cursor', 'cursor_mismatch', 'work_unavailable', 'internal_error',
] as const
export const workErrorSchema = z.object({ code: z.enum(WORK_ERROR_CODES) }).strict()
export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number]
