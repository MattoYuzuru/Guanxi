import { z } from 'zod'

export const CHAT_RETENTION_VERSION = 1 as const
export const CHAT_RETENTION_DAYS = 7 as const

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
        source: z.enum(['chat_created', 'user_message']),
      })
      .strict(),
    expiresAt: z.string().datetime().nullable(),
    expirySource: z.enum(['server_calculated', 'policy_without_time_expiry']),
    enforcement: z.literal('not_implemented'),
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
