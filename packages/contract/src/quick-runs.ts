import { z } from 'zod'
import {
  RETENTION_POLICY_VERSION,
  retentionPolicySchema,
} from './retention.ts'

export const QUICK_RUN_VERSION = 1 as const

/** Accepted one-shot operations; Chat and Agent remain separate work entities. */
export const QUICK_RUN_OPERATIONS = [
  'complete',
  'embed',
  'transcribe',
  'textToSpeech',
  'ocr',
  'caption',
  'generateImage',
  'generateVideo',
] as const

export const quickRunOperationSchema = z.enum(QUICK_RUN_OPERATIONS)
export type QuickRunOperation = z.infer<typeof quickRunOperationSchema>

const normalizedProjectReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), 'Project reference must be normalized')

const quickRunScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless') }).strict(),
  z.object({ scope: z.literal('project'), projectId: normalizedProjectReferenceSchema }).strict(),
])

export const quickRunRetentionSchema = z
  .object({
    retentionVersion: z.literal(RETENTION_POLICY_VERSION),
    policy: retentionPolicySchema,
    policySource: z.enum(['default', 'user']),
    policyUpdatedAt: z.string().datetime(),
    expiryCalculation: z.literal('not_implemented'),
    automaticCleanup: z.literal('not_implemented'),
    sessionEnforcement: z.literal('not_implemented'),
  })
  .strict()
export type QuickRunRetention = z.infer<typeof quickRunRetentionSchema>

export const quickRunSchema = z
  .object({
    quickRunVersion: z.literal(QUICK_RUN_VERSION),
    id: z.string().uuid(),
    operation: quickRunOperationSchema,
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedProjectReferenceSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    retention: quickRunRetentionSchema,
    execution: z
      .object({
        state: z.literal('not_implemented'),
        jobId: z.null(),
        artifactCount: z.literal(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedProject = value.scope === 'project' ? value.projectId : null
    if ((value.scope === 'project') !== (value.projectId !== null) || value.projectId !== expectedProject) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Quick Run requires exactly one Project or projectless scope',
      })
    }
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Quick Run time moved backwards' })
    }
    if (value.retention.policySource === 'default') {
      if (
        value.retention.policy.mode !== 'ttl' ||
        value.retention.policyUpdatedAt !== value.createdAt
      ) {
        context.addIssue({
          code: 'custom',
          path: ['retention'],
          message: 'Default Quick Run retention must be seven days from creation',
        })
      }
    }
  })
export type QuickRun = z.infer<typeof quickRunSchema>

const quickRunScopeFields = {
  quickRunVersion: z.coerce.number().pipe(z.literal(QUICK_RUN_VERSION)),
}

export const quickRunScopeQuery = z.discriminatedUnion('scope', [
  z.object({ ...quickRunScopeFields, scope: z.literal('projectless') }).strict(),
  z
    .object({
      ...quickRunScopeFields,
      scope: z.literal('project'),
      projectId: normalizedProjectReferenceSchema,
    })
    .strict(),
])
export type QuickRunScopeQuery = z.infer<typeof quickRunScopeQuery>

export const createQuickRunBody = z.discriminatedUnion('scope', [
  z
    .object({
      quickRunVersion: z.literal(QUICK_RUN_VERSION),
      operation: quickRunOperationSchema,
      scope: z.literal('projectless'),
    })
    .strict(),
  z
    .object({
      quickRunVersion: z.literal(QUICK_RUN_VERSION),
      operation: quickRunOperationSchema,
      scope: z.literal('project'),
      projectId: normalizedProjectReferenceSchema,
    })
    .strict(),
])
export type CreateQuickRunBody = z.infer<typeof createQuickRunBody>

export const updateQuickRunRetentionBody = z.discriminatedUnion('scope', [
  z
    .object({
      quickRunVersion: z.literal(QUICK_RUN_VERSION),
      retentionVersion: z.literal(RETENTION_POLICY_VERSION),
      scope: z.literal('projectless'),
      policy: retentionPolicySchema,
    })
    .strict(),
  z
    .object({
      quickRunVersion: z.literal(QUICK_RUN_VERSION),
      retentionVersion: z.literal(RETENTION_POLICY_VERSION),
      scope: z.literal('project'),
      projectId: normalizedProjectReferenceSchema,
      policy: retentionPolicySchema,
    })
    .strict(),
])
export type UpdateQuickRunRetentionBody = z.infer<typeof updateQuickRunRetentionBody>

export const listQuickRunsResponse = z
  .object({
    quickRunVersion: z.literal(QUICK_RUN_VERSION),
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedProjectReferenceSchema.nullable(),
    quickRuns: z.array(quickRunSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedProject = value.scope === 'project' ? value.projectId : null
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({ code: 'custom', path: ['projectId'], message: 'Quick Run list scope mismatch' })
    }
    const ids = new Set<string>()
    value.quickRuns.forEach((quickRun, index) => {
      if (quickRun.scope !== value.scope || quickRun.projectId !== expectedProject) {
        context.addIssue({
          code: 'custom',
          path: ['quickRuns', index, 'projectId'],
          message: 'Quick Run crossed its requested scope',
        })
      }
      if (ids.has(quickRun.id)) {
        context.addIssue({
          code: 'custom',
          path: ['quickRuns', index, 'id'],
          message: 'Duplicate Quick Run identity',
        })
      }
      ids.add(quickRun.id)
    })
  })
export type ListQuickRunsResponse = z.infer<typeof listQuickRunsResponse>

export const createQuickRunResponse = quickRunSchema
export const getQuickRunResponse = quickRunSchema
export const updateQuickRunRetentionResponse = quickRunSchema

// Keep the scope schema live as a single source for internal callers and tests.
export type QuickRunScope = z.infer<typeof quickRunScopeSchema>
