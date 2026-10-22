/**
 * Wire contract for the notification inbox (NC1, ADR-0033).
 *
 * The wire is deliberately narrower than the server library: stored account ids and idempotency
 * keys never leave the node, action arguments are content-free (ids, enums and integers only),
 * and the three actions that would carry prompts, free text or money intent are not exposed.
 */
import { z } from 'zod'

export const NOTIFICATION_STATES = ['unread', 'read', 'acted', 'snoozed', 'expired'] as const
export const NOTIFICATION_ACTIONS = [
  'open', 'add_prompt', 'accept_recommendation', 'choose_action', 'wake_leads',
  'switch_connection', 'pause_runs', 'resume_runs', 'snooze', 'raise_budget',
] as const
/** Actions the REST boundary executes. The others stay library-only until a content-free form exists. */
export const NOTIFICATION_WIRE_ACTIONS = [
  'open', 'accept_recommendation', 'wake_leads', 'switch_connection', 'pause_runs', 'resume_runs', 'snooze',
] as const
export const NOTIFICATION_LIST_MAX_LIMIT = 200
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 50

export const notificationStateSchema = z.enum(NOTIFICATION_STATES)
export const notificationActionSchema = z.enum(NOTIFICATION_ACTIONS)
export const notificationWireActionSchema = z.enum(NOTIFICATION_WIRE_ACTIONS)
export const notificationKindSchema = z.enum(['threshold', 'forecast', 'exhausted'])
export const notificationSeveritySchema = z.enum(['info', 'warning', 'critical'])
export const quotaWindowSchema = z.enum(['five_hour', 'seven_day', 'daily', 'monthly', 'balance', 'rate_requests', 'rate_tokens'])

export const notificationIdSchema = z.string().regex(/^ntf_[0-9a-f]{40}$/)
/** Connection, run and recommendation identifiers: opaque, no whitespace, no free text. */
export const notificationRefIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
export const notificationIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
export const NOTIFICATION_IDEMPOTENCY_HEADER = 'Idempotency-Key'

const millis = z.number().int().nonnegative().safe()

export const notificationFactsSchema = z.object({
  window: quotaWindowSchema,
  threshold: z.number().min(0).max(100).nullable(),
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.string().nullable(),
  source: z.string().min(1),
  observedAt: z.string().min(1),
  confidence: z.enum(['observed', 'estimated']),
  forecast: z.object({
    exhaustsAt: z.string().min(1),
    before: z.enum(['reset', 'dependent_run_eta']),
    runId: z.string().min(1).optional(),
  }).strict().optional(),
}).strict()

export const notificationSchema = z.object({
  id: notificationIdSchema,
  kind: notificationKindSchema,
  severity: notificationSeveritySchema,
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }).strict(),
  facts: notificationFactsSchema,
  actions: z.array(notificationActionSchema),
  state: notificationStateSchema,
  snoozedUntil: millis.nullable(),
  createdAt: millis,
  updatedAt: millis,
}).strict()
export type NotificationWire = z.infer<typeof notificationSchema>

/** Query string: `state` is a comma list, `before` a notification id from `nextCursor`. */
export const listNotificationsQuerySchema = z.object({
  state: z.string().optional().transform((value, ctx) => {
    if (value === undefined || value === '') return undefined
    const parts = value.split(',')
    const parsed = z.array(notificationStateSchema).safeParse(parts)
    if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'unknown state' }); return z.NEVER }
    return [...new Set(parsed.data)]
  }),
  limit: z.string().regex(/^[0-9]{1,4}$/).optional().transform((value, ctx) => {
    if (value === undefined) return NOTIFICATION_LIST_DEFAULT_LIMIT
    const limit = Number(value)
    if (limit < 1 || limit > NOTIFICATION_LIST_MAX_LIMIT) { ctx.addIssue({ code: 'custom', message: 'limit out of range' }); return z.NEVER }
    return limit
  }),
  before: notificationIdSchema.optional(),
}).strict()
export type ListNotificationsQuery = z.input<typeof listNotificationsQuerySchema>

export const listNotificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  nextCursor: notificationIdSchema.nullable(),
}).strict()
export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>

export const snoozeNotificationBodySchema = z.object({ untilMs: millis }).strict()
export type SnoozeNotificationBody = z.infer<typeof snoozeNotificationBodySchema>

const noArgs = z.object({}).strict()
/**
 * Content-free action commands. Arguments are identifiers, enums and integers: no prompt, no
 * reason, no URL and no free text. `add_prompt`, `choose_action` and `raise_budget` are absent.
 */
export const executeNotificationActionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), args: noArgs.default({}) }).strict(),
  z.object({
    action: z.literal('accept_recommendation'),
    args: z.object({ recommendation: z.enum(['snooze', 'switch_connection']).optional() }).strict().default({}),
  }).strict(),
  z.object({
    action: z.literal('wake_leads'),
    args: z.object({ connectionId: notificationRefIdSchema.optional() }).strict().default({}),
  }).strict(),
  z.object({
    action: z.literal('switch_connection'),
    args: z.object({
      connectionId: notificationRefIdSchema,
      role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
    }).strict(),
  }).strict(),
  z.object({
    action: z.literal('pause_runs'),
    args: z.object({
      runIds: z.array(notificationRefIdSchema).min(1).optional(),
      connectionId: notificationRefIdSchema.optional(),
    }).strict().default({}),
  }).strict(),
  z.object({
    action: z.literal('resume_runs'),
    args: z.object({
      runIds: z.array(notificationRefIdSchema).min(1).optional(),
      connectionId: notificationRefIdSchema.optional(),
    }).strict().default({}),
  }).strict(),
  z.object({ action: z.literal('snooze'), args: z.object({ untilMs: millis }).strict() }).strict(),
])
export type ExecuteNotificationActionBody = z.input<typeof executeNotificationActionBodySchema>

/** Port results are reduced to flat scalars; nothing nested or free-form crosses the wire. */
export const notificationActionResultSchema = z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).nullable()

export const notificationActionResponseSchema = z.object({
  notificationId: notificationIdSchema,
  action: notificationActionSchema,
  status: z.enum(['done', 'failed']),
  result: notificationActionResultSchema,
  duplicate: z.boolean(),
}).strict()
export type NotificationActionResponse = z.infer<typeof notificationActionResponseSchema>

export const notificationActionAvailabilitySchema = z.enum(['available', 'not_configured', 'not_exposed'])
export const notificationActionsResponseSchema = z.object({
  actions: z.array(z.object({ action: notificationActionSchema, availability: notificationActionAvailabilitySchema }).strict()),
}).strict()
export type NotificationActionsResponse = z.infer<typeof notificationActionsResponseSchema>

export const NOTIFICATION_ERROR_CODES = [
  'validation_failed', 'json_required', 'origin_denied', 'loopback_only', 'body_too_large',
  'idempotency_key_required', 'notification_not_found', 'action_not_offered', 'notification_acted',
  'action_in_progress', 'idempotency_conflict', 'action_outcome_unknown', 'not_configured',
  'port_failed', 'invalid_snooze_time', 'notifications_unavailable', 'internal_error',
] as const
export const notificationErrorSchema = z.object({ code: z.enum(NOTIFICATION_ERROR_CODES) }).strict()
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number]
