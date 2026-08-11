import { z } from 'zod'

export const CHAT_RETENTION_VERSION = 1 as const
export const CHAT_RETENTION_DAYS = 7 as const
export const CHAT_LIFECYCLE_VERSION = 1 as const
export const CHAT_TRASH_DEFAULT_LIMIT = 20 as const
export const CHAT_TRASH_MAX_LIMIT = 100 as const

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
  })
export type ChatRetentionProjection = z.infer<typeof chatRetentionProjectionSchema>

export const chatTrashReasonSchema = z.literal('ttl_expired')
export type ChatTrashReason = z.infer<typeof chatTrashReasonSchema>

export const chatTrashItemSchema = z
  .object({
    lifecycleVersion: z.literal(CHAT_LIFECYCLE_VERSION),
    chatId: z.string().min(1),
    title: z.string(),
    projectId: z.string().min(1).nullable(),
    state: z.literal('trash'),
    reason: chatTrashReasonSchema,
    tombstonedAt: z.string().datetime(),
    activityBasis: z
      .object({
        at: z.string().datetime(),
        source: z.enum(['chat_created', 'user_message', 'chat_restored']),
      })
      .strict(),
    source: z.literal('server_maintenance'),
    hardDeletion: z.literal('not_implemented'),
  })
  .strict()
export type ChatTrashItem = z.infer<typeof chatTrashItemSchema>

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
    hardDeletion: z.literal('not_implemented'),
  })
  .strict()
export type RestoredChatLifecycle = z.infer<typeof restoredChatLifecycleSchema>
