import { z } from 'zod'
import { retentionPolicySchema } from './retention.ts'
import { QUICK_RUN_OPERATIONS, quickRunOperationSchema } from './quick-runs.ts'

export const RECIPE_VERSION = 1 as const
export const RECIPE_REVISION_VERSION = 1 as const
export const RECIPE_OPERATIONS = QUICK_RUN_OPERATIONS
export const recipeOperationSchema = quickRunOperationSchema
export type RecipeOperation = z.infer<typeof recipeOperationSchema>

const normalizedReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), 'Reference must be normalized')

export const recipeNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), 'Recipe name must be normalized')

export const recipeScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless') }).strict(),
  z.object({ scope: z.literal('project'), projectId: normalizedReferenceSchema }).strict(),
])
export type RecipeScope = z.infer<typeof recipeScopeSchema>

export const recipeModelReferenceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none'), reason: z.literal('not_selected') }).strict(),
  z
    .object({
      state: z.literal('explicit'),
      provider: z.literal('ollama'),
      reference: normalizedReferenceSchema,
    })
    .strict(),
])
export type RecipeModelReference = z.infer<typeof recipeModelReferenceSchema>

export type RecipeJsonValue =
  | null
  | boolean
  | number
  | string
  | RecipeJsonValue[]
  | { [key: string]: RecipeJsonValue }

export const recipeJsonValueSchema: z.ZodType<RecipeJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(recipeJsonValueSchema),
    z.record(z.string(), recipeJsonValueSchema),
  ]),
)

export const recipeConfigurationSchema = z
  .object({
    recipeRevisionVersion: z.literal(RECIPE_REVISION_VERSION),
    operation: recipeOperationSchema,
    model: recipeModelReferenceSchema,
    instructions: z.string(),
    defaultParameters: z.record(z.string(), recipeJsonValueSchema),
    retention: retentionPolicySchema,
  })
  .strict()
export type RecipeConfiguration = z.infer<typeof recipeConfigurationSchema>

export const recipeRevisionSchema = z
  .object({
    recipeRevisionVersion: z.literal(RECIPE_REVISION_VERSION),
    recipeId: z.string().uuid(),
    revision: z.number().int().positive(),
    configuration: recipeConfigurationSchema,
    canonical: z
      .object({
        format: z.literal('canonical_json_v1'),
        byteSize: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict()
export type RecipeRevision = z.infer<typeof recipeRevisionSchema>

export const recipeSchema = z
  .object({
    recipeVersion: z.literal(RECIPE_VERSION),
    id: z.string().uuid(),
    name: recipeNameSchema,
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedReferenceSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    currentRevision: recipeRevisionSchema,
    advancedRouting: z.literal('not_implemented'),
    execution: z.literal('not_implemented'),
    jobSnapshot: z.literal('not_implemented'),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({ code: 'custom', path: ['projectId'], message: 'Recipe scope mismatch' })
    }
    if (value.currentRevision.recipeId !== value.id) {
      context.addIssue({ code: 'custom', path: ['currentRevision'], message: 'Recipe revision mismatch' })
    }
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Recipe time moved backwards' })
    }
  })
export type Recipe = z.infer<typeof recipeSchema>

const recipeScopeFields = { recipeVersion: z.coerce.number().pipe(z.literal(RECIPE_VERSION)) }
export const recipeScopeQuery = z.discriminatedUnion('scope', [
  z.object({ ...recipeScopeFields, scope: z.literal('projectless') }).strict(),
  z
    .object({
      ...recipeScopeFields,
      scope: z.literal('project'),
      projectId: normalizedReferenceSchema,
    })
    .strict(),
])
export type RecipeScopeQuery = z.infer<typeof recipeScopeQuery>

const createConfigurationFields = {
  recipeRevisionVersion: z.literal(RECIPE_REVISION_VERSION),
  operation: recipeOperationSchema,
  model: recipeModelReferenceSchema,
  instructions: z.string(),
  defaultParameters: z.record(z.string(), recipeJsonValueSchema),
  retention: retentionPolicySchema,
}

export const createRecipeBody = z.discriminatedUnion('scope', [
  z
    .object({
      recipeVersion: z.literal(RECIPE_VERSION),
      name: recipeNameSchema,
      scope: z.literal('projectless'),
      configuration: z.object(createConfigurationFields).strict(),
    })
    .strict(),
  z
    .object({
      recipeVersion: z.literal(RECIPE_VERSION),
      name: recipeNameSchema,
      scope: z.literal('project'),
      projectId: normalizedReferenceSchema,
      configuration: z.object(createConfigurationFields).strict(),
    })
    .strict(),
])
export type CreateRecipeBody = z.infer<typeof createRecipeBody>

export const renameRecipeBody = z.discriminatedUnion('scope', [
  z.object({ recipeVersion: z.literal(RECIPE_VERSION), scope: z.literal('projectless'), name: recipeNameSchema }).strict(),
  z.object({ recipeVersion: z.literal(RECIPE_VERSION), scope: z.literal('project'), projectId: normalizedReferenceSchema, name: recipeNameSchema }).strict(),
])
export type RenameRecipeBody = z.infer<typeof renameRecipeBody>

export const reviseRecipeBody = z.discriminatedUnion('scope', [
  z.object({
    recipeVersion: z.literal(RECIPE_VERSION),
    scope: z.literal('projectless'),
    expectedRevision: z.number().int().positive(),
    configuration: z.object(createConfigurationFields).strict(),
  }).strict(),
  z.object({
    recipeVersion: z.literal(RECIPE_VERSION),
    scope: z.literal('project'),
    projectId: normalizedReferenceSchema,
    expectedRevision: z.number().int().positive(),
    configuration: z.object(createConfigurationFields).strict(),
  }).strict(),
])
export type ReviseRecipeBody = z.infer<typeof reviseRecipeBody>

export const listRecipesResponse = z
  .object({
    recipeVersion: z.literal(RECIPE_VERSION),
    scope: z.enum(['projectless', 'project']),
    projectId: normalizedReferenceSchema.nullable(),
    recipes: z.array(recipeSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({ code: 'custom', path: ['projectId'], message: 'Recipe list scope mismatch' })
    }
    const expectedProject = value.scope === 'project' ? value.projectId : null
    const ids = new Set<string>()
    value.recipes.forEach((recipe, index) => {
      if (recipe.scope !== value.scope || recipe.projectId !== expectedProject) {
        context.addIssue({ code: 'custom', path: ['recipes', index], message: 'Recipe crossed scope' })
      }
      if (ids.has(recipe.id)) {
        context.addIssue({ code: 'custom', path: ['recipes', index, 'id'], message: 'Duplicate Recipe identity' })
      }
      ids.add(recipe.id)
    })
  })

export const recipePathParams = z.object({ id: z.string().uuid() }).strict()

export const recipeRevisionPathParams = z.object({
  id: z.string().uuid(),
  revision: z.coerce.number().int().positive(),
}).strict()

export const createRecipeResponse = recipeSchema
export const getRecipeResponse = recipeSchema
export const renameRecipeResponse = recipeSchema
export const reviseRecipeResponse = recipeSchema
export const getRecipeRevisionResponse = recipeRevisionSchema
