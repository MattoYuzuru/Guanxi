import { z } from 'zod'
import { jobSchema } from './schemas.ts'
import {
  recipeConfigurationSchema,
  recipeModelReferenceSchema,
  recipeOperationSchema,
} from './recipes.ts'

export const RECIPE_JOB_SNAPSHOT_VERSION = 1 as const

const normalizedProjectReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), 'Project reference must be normalized')

const recipeJobScopeFields = {
  recipeJobSnapshotVersion: z.literal(RECIPE_JOB_SNAPSHOT_VERSION),
}

export const recipeJobSnapshotScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless') }).strict(),
  z
    .object({ scope: z.literal('project'), projectId: normalizedProjectReferenceSchema })
    .strict(),
])
export type RecipeJobSnapshotScope = z.infer<typeof recipeJobSnapshotScopeSchema>

export const recipeJobSnapshotSchema = z
  .object({
    recipeJobSnapshotVersion: z.literal(RECIPE_JOB_SNAPSHOT_VERSION),
    jobId: z.string().uuid(),
    jobKind: z.literal('inference'),
    recipeId: z.string().uuid(),
    recipeRevision: z.number().int().positive(),
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedProjectReferenceSchema.nullable(),
    operation: recipeOperationSchema,
    model: recipeModelReferenceSchema,
    configuration: recipeConfigurationSchema,
    canonical: z
      .object({
        format: z.literal('canonical_json_v1'),
        byteSize: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    createdAt: z.string().datetime(),
    execution: z.literal('not_implemented'),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'Recipe Job snapshot scope mismatch',
      })
    }
    if (value.operation !== value.configuration.operation) {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Recipe Job snapshot operation drifted from its configuration',
      })
    }
    if (JSON.stringify(value.model) !== JSON.stringify(value.configuration.model)) {
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Recipe Job snapshot model drifted from its configuration',
      })
    }
  })
export type RecipeJobSnapshot = z.infer<typeof recipeJobSnapshotSchema>

export const createRecipeJobSnapshotBody = z.discriminatedUnion('scope', [
  z
    .object({
      ...recipeJobScopeFields,
      scope: z.literal('projectless'),
      idempotencyKey: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...recipeJobScopeFields,
      scope: z.literal('project'),
      projectId: normalizedProjectReferenceSchema,
      idempotencyKey: z.string().uuid(),
    })
    .strict(),
])
export type CreateRecipeJobSnapshotBody = z.infer<typeof createRecipeJobSnapshotBody>

export const recipeJobSnapshotQuery = z.discriminatedUnion('scope', [
  z
    .object({
      recipeJobSnapshotVersion: z.coerce
        .number()
        .pipe(z.literal(RECIPE_JOB_SNAPSHOT_VERSION)),
      scope: z.literal('projectless'),
    })
    .strict(),
  z
    .object({
      recipeJobSnapshotVersion: z.coerce
        .number()
        .pipe(z.literal(RECIPE_JOB_SNAPSHOT_VERSION)),
      scope: z.literal('project'),
      projectId: normalizedProjectReferenceSchema,
    })
    .strict(),
])
export type RecipeJobSnapshotQuery = z.infer<typeof recipeJobSnapshotQuery>

export const recipeJobSnapshotPathParams = z
  .object({
    id: z.string().uuid(),
    revision: z.coerce.number().int().positive(),
  })
  .strict()

export const recipeJobSnapshotReadPathParams = recipeJobSnapshotPathParams
  .extend({ jobId: z.string().uuid() })
  .strict()

const recipeJobSnapshotResponseFields = {
  job: jobSchema,
  snapshot: recipeJobSnapshotSchema,
  eventsUrl: z.string().min(1),
}

function validateJobSnapshotAssociation(
  value: { job: z.infer<typeof jobSchema>; snapshot: RecipeJobSnapshot },
  context: z.RefinementCtx,
): void {
    if (
      value.job.id !== value.snapshot.jobId ||
      value.job.kind !== value.snapshot.jobKind ||
      value.job.operation !== value.snapshot.operation
    ) {
      context.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: 'Recipe Job snapshot does not match its canonical Job',
      })
    }
}

export const createRecipeJobSnapshotResponse = z
  .object({ ...recipeJobSnapshotResponseFields, created: z.boolean() })
  .strict()
  .superRefine(validateJobSnapshotAssociation)
export type CreateRecipeJobSnapshotResponse = z.infer<
  typeof createRecipeJobSnapshotResponse
>

export const getRecipeJobSnapshotResponse = z
  .object(recipeJobSnapshotResponseFields)
  .strict()
  .superRefine(validateJobSnapshotAssociation)
export type GetRecipeJobSnapshotResponse = z.infer<typeof getRecipeJobSnapshotResponse>
