import { z } from 'zod'

export const CHAT_RETENTION_VERSION = 1 as const
export const CHAT_RETENTION_DAYS = 7 as const
export const CHAT_LIFECYCLE_VERSION = 1 as const
export const CHAT_TRASH_DEFAULT_LIMIT = 20 as const
export const CHAT_TRASH_MAX_LIMIT = 100 as const
export const SESSION_LEAVE_VERSION = 1 as const
export const SESSION_TRASH_RECOVERY_HOURS = 24 as const
export const CHAT_DELETION_VERSION = 1 as const

export const chatRetentionPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }).strict(),
  z
    .object({
      mode: z.literal('ttl'),
      expiresAfterDays: z.literal(CHAT_RETENTION_DAYS),
    })
    .strict(),
  z.object({ mode: z.literal('session') }).strict(),
])
export type ChatRetentionPolicy = z.infer<typeof chatRetentionPolicySchema>

export const chatRetentionProjectionSchema = z
  .object({
    retentionVersion: z.literal(CHAT_RETENTION_VERSION),
    chatId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    policy: chatRetentionPolicySchema,
    policySource: z.enum(['default', 'user', 'legacy_compatibility']),
    policyUpdatedAt: z.string().datetime(),
    lastUserActivity: z
      .object({
        at: z.string().datetime(),
        source: z.enum(['chat_created', 'user_message', 'chat_restored']),
      })
      .strict(),
    expiresAt: z.string().datetime().nullable(),
    expirySource: z.enum(['server_calculated', 'policy_without_time_expiry']),
    enforcement: z.enum(['not_implemented', 'rolling_ttl_trash']),
    sessionLeave: z
      .object({
        at: z.string().datetime(),
        source: z.literal('explicit_user_action'),
        state: z.enum(['pending_maintenance', 'blocked_active_job']),
        activeJobCount: z.number().int().nonnegative(),
      })
      .strict()
      .nullable()
      .optional()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const expectsExpiry = value.policy.mode === 'ttl'
    if (expectsExpiry !== (value.expiresAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Only the rolling seven-day policy has an exact expiry',
      })
      return
    }
    if (expectsExpiry && value.expirySource !== 'server_calculated') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expirySource'],
        message: 'Rolling expiry must be calculated by the server',
      })
    }
    if (
      expectsExpiry &&
      value.expiresAt !== null &&
      Date.parse(value.expiresAt) !==
        Date.parse(value.lastUserActivity.at) + CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Rolling expiry must be exactly seven days after user activity',
      })
    }
    if (!expectsExpiry && value.expirySource !== 'policy_without_time_expiry') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expirySource'],
        message: 'Keep and Session have no time expiry in the retention foundation',
      })
    }
    if (value.policy.mode !== 'session' && value.sessionLeave !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessionLeave'],
        message: 'Only Session retention can have a pending leave basis',
      })
    }
    if (
      value.sessionLeave &&
      ((value.sessionLeave.state === 'blocked_active_job') !== (value.sessionLeave.activeJobCount > 0))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessionLeave', 'activeJobCount'],
        message: 'Blocked Session leave requires a canonical active Job',
      })
    }
  })
export type ChatRetentionProjection = z.infer<typeof chatRetentionProjectionSchema>

export const chatTrashReasonSchema = z.enum(['ttl_expired', 'session_left'])
export type ChatTrashReason = z.infer<typeof chatTrashReasonSchema>

const chatTrashItemBase = {
  lifecycleVersion: z.literal(CHAT_LIFECYCLE_VERSION),
  chatId: z.string().min(1),
  title: z.string(),
  projectId: z.string().min(1).nullable(),
  state: z.literal('trash'),
  tombstonedAt: z.string().datetime(),
  source: z.literal('server_maintenance'),
}

const ttlTrashItemSchema = z
  .object({
    ...chatTrashItemBase,
    reason: z.literal('ttl_expired'),
    activityBasis: z
      .object({
        at: z.string().datetime(),
        source: z.enum(['chat_created', 'user_message', 'chat_restored']),
      })
      .strict(),
    hardDeletion: z.literal('not_implemented'),
  })
  .strict()

const sessionTrashItemSchema = z
  .object({
    ...chatTrashItemBase,
    reason: z.literal('session_left'),
    activityBasis: z
      .object({
        at: z.string().datetime(),
        source: z.literal('session_leave'),
      })
      .strict(),
    recovery: z
      .object({
        deadline: z.string().datetime(),
        state: z.enum(['available', 'grace_elapsed']),
        source: z.literal('server_calculated_24_hours'),
      })
      .strict(),
    hardDeletion: z
      .object({
        state: z.enum(['scheduled_after_recovery', 'pending_maintenance']),
        eligibleAt: z.string().datetime(),
        source: z.literal('server_maintenance'),
        blobGc: z.literal('not_applicable'),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Date.parse(value.recovery.deadline) !==
      Date.parse(value.tombstonedAt) + SESSION_TRASH_RECOVERY_HOURS * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recovery', 'deadline'],
        message: 'Session recovery deadline must be exactly 24 hours after Trash entry',
      })
    }
    if (value.hardDeletion.eligibleAt !== value.recovery.deadline) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hardDeletion', 'eligibleAt'],
        message: 'Session metadata deletion must use the recovery deadline',
      })
    }
    if (
      (value.recovery.state === 'available') !==
      (value.hardDeletion.state === 'scheduled_after_recovery')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hardDeletion', 'state'],
        message: 'Session metadata deletion state must follow recovery availability',
      })
    }
  })

export const chatTrashItemSchema = z.union([ttlTrashItemSchema, sessionTrashItemSchema])
export type ChatTrashItem = z.infer<typeof chatTrashItemSchema>

const normalizedProjectReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), 'Project reference must be normalized')

export const chatDeletionAuditSchema = z
  .object({
    deletionVersion: z.literal(CHAT_DELETION_VERSION),
    chatId: z.string().min(1),
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedProjectReferenceSchema.nullable(),
    state: z.literal('deleted'),
    reason: z.literal('session_recovery_elapsed'),
    tombstonedAt: z.string().datetime(),
    recoveryDeadline: z.string().datetime(),
    deletedAt: z.string().datetime(),
    source: z.literal('server_maintenance'),
    boundary: z.literal('thread_owned_sqlite_metadata'),
    blobGc: z.literal('not_applicable'),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectId'],
        message: 'Deletion audit requires exactly one Project or projectless scope',
      })
    }
    if (
      Date.parse(value.recoveryDeadline) !==
      Date.parse(value.tombstonedAt) + SESSION_TRASH_RECOVERY_HOURS * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryDeadline'],
        message: 'Deletion audit deadline must be exactly 24 hours after Trash entry',
      })
    }
    if (Date.parse(value.deletedAt) < Date.parse(value.recoveryDeadline)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deletedAt'],
        message: 'Session metadata cannot be deleted before recovery ends',
      })
    }
  })
export type ChatDeletionAudit = z.infer<typeof chatDeletionAuditSchema>

const sessionLeaveScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless') }).strict(),
  z.object({ scope: z.literal('project'), projectId: normalizedProjectReferenceSchema }).strict(),
])

export const leaveSessionChatBody = z
  .object({
    leaveVersion: z.literal(SESSION_LEAVE_VERSION),
    chatId: z.string().min(1),
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedProjectReferenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const parsedScope = sessionLeaveScopeSchema.safeParse({
      scope: value.scope,
      ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    })
    if (!parsedScope.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Session leave requires exactly one Project or projectless scope',
      })
    }
  })
export type LeaveSessionChatBody = z.infer<typeof leaveSessionChatBody>

export const leaveSessionChatResponse = z
  .object({
    leaveVersion: z.literal(SESSION_LEAVE_VERSION),
    chatId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    state: z.enum(['pending_maintenance', 'blocked_active_job', 'trash']),
    leaveBasis: z
      .object({
        at: z.string().datetime(),
        source: z.literal('explicit_user_action'),
      })
      .strict(),
    activeJobCount: z.number().int().nonnegative(),
    recoveryDeadline: z.string().datetime().nullable(),
    hardDeletion: z.literal('session_metadata_after_recovery'),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === 'blocked_active_job') !== (value.activeJobCount > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeJobCount'],
        message: 'Only an active canonical Job can block Session leave',
      })
    }
    if ((value.state === 'trash') !== (value.recoveryDeadline !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recoveryDeadline'],
        message: 'Only a trashed Session Chat has a recovery deadline',
      })
    }
  })
export type LeaveSessionChatResponse = z.infer<typeof leaveSessionChatResponse>

export const restoredChatLifecycleSchema = z
  .object({
    lifecycleVersion: z.literal(CHAT_LIFECYCLE_VERSION),
    chatId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    state: z.literal('active'),
    restored: z.boolean(),
    restoredAt: z.string().datetime(),
    activityBasis: z
      .object({
        at: z.string().datetime(),
        source: z.literal('chat_restored'),
      })
      .strict(),
    source: z.literal('user_restore'),
    hardDeletion: z.enum(['not_implemented', 'session_metadata_after_recovery_not_scheduled']),
  })
  .strict()
export type RestoredChatLifecycle = z.infer<typeof restoredChatLifecycleSchema>
