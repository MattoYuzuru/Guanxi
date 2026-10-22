/**
 * Wire contract for the voice glossary (V1, ADR-0028 decision 3).
 *
 * Over HTTP the revision source is always `user`; `import` and `candidate` belong to later
 * adapters. Stored account ids never leave the node.
 */
import { z } from 'zod'

export const GLOSSARY_LANGUAGES = ['en', 'ru', 'any'] as const
export const GLOSSARY_SCOPES = ['account', 'project'] as const
export const GLOSSARY_REVISION_OPS = ['create', 'update', 'deactivate', 'reactivate', 'revert'] as const
export const GLOSSARY_REVISION_SOURCES = ['user', 'import', 'candidate'] as const
/** Transport budget for one preview body, not a limit on dictation length. */
export const GLOSSARY_PREVIEW_MAX_CHARS = 250_000

const text = (max: number) => z.string().min(1).max(max)
export const glossaryEntryIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
export const glossaryProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
export const glossaryLanguageSchema = z.enum(GLOSSARY_LANGUAGES)
export const glossaryScopeSchema = z.enum(GLOSSARY_SCOPES)

/** The editable part of an entry; the id lives in the path or is assigned by the node. */
export const glossaryEntryBodySchema = z.object({
  canonical: text(200),
  variants: z.array(text(200)).max(200),
  language: glossaryLanguageSchema,
  caseSensitive: z.boolean().optional(),
  inflect: z.boolean().optional(),
}).strict()
export type GlossaryEntryBody = z.infer<typeof glossaryEntryBodySchema>

/**
 * Read shape of an entry, without the request's id pattern or length caps: an entry written by a
 * kernel caller (an importer, a candidate adapter) must never turn the list route into a 500.
 */
export const glossaryEntrySchema = z.object({
  id: z.string().min(1),
  canonical: z.string().min(1),
  variants: z.array(z.string()),
  language: glossaryLanguageSchema,
  caseSensitive: z.boolean().optional(),
  inflect: z.boolean().optional(),
}).strict()
export type GlossaryEntryWire = z.infer<typeof glossaryEntrySchema>

export const createGlossaryEntryBodySchema = z.object({
  id: glossaryEntryIdSchema.optional(),
  scope: glossaryScopeSchema,
  projectId: glossaryProjectIdSchema.nullable().optional(),
  entry: glossaryEntryBodySchema,
}).strict().superRefine((value, ctx) => {
  const hasProject = value.projectId !== undefined && value.projectId !== null
  if (value.scope === 'project' && !hasProject) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'project entries need a projectId' })
  if (value.scope === 'account' && hasProject) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'account entries have no projectId' })
})
export type CreateGlossaryEntryBody = z.input<typeof createGlossaryEntryBodySchema>

export const updateGlossaryEntryBodySchema = z.object({ entry: glossaryEntryBodySchema }).strict()
export type UpdateGlossaryEntryBody = z.infer<typeof updateGlossaryEntryBodySchema>

const millis = z.number().int().nonnegative().safe()
export const storedGlossaryEntrySchema = z.object({
  id: z.string().min(1),
  scope: glossaryScopeSchema,
  projectId: z.string().nullable(),
  entry: glossaryEntrySchema,
  active: z.boolean(),
  revision: z.number().int().positive().safe(),
  createdAt: millis,
  updatedAt: millis,
}).strict()
export type StoredGlossaryEntryWire = z.infer<typeof storedGlossaryEntrySchema>

/** `projectId` absent lists everything the account owns; present lists account entries plus that project. */
export const listGlossaryQuerySchema = z.object({
  projectId: glossaryProjectIdSchema.optional(),
  includeInactive: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
}).strict()
export type ListGlossaryQuery = { projectId?: string; includeInactive?: 'true' | 'false' }

export const listGlossaryResponseSchema = z.object({ entries: z.array(storedGlossaryEntrySchema) }).strict()
export type ListGlossaryResponse = z.infer<typeof listGlossaryResponseSchema>

export const glossaryRevisionSchema = z.object({
  entryId: z.string().min(1),
  revision: z.number().int().positive().safe(),
  op: z.enum(GLOSSARY_REVISION_OPS),
  entry: glossaryEntrySchema.nullable(),
  source: z.enum(GLOSSARY_REVISION_SOURCES),
  createdAt: millis,
}).strict()
export const glossaryHistoryResponseSchema = z.object({ revisions: z.array(glossaryRevisionSchema) }).strict()
export type GlossaryHistoryResponse = z.infer<typeof glossaryHistoryResponseSchema>

/** Entry-level lifecycle commands carry no payload. */
export const glossaryEmptyBodySchema = z.object({}).strict()

export const glossaryPreviewBodySchema = z.object({
  text: z.string().max(GLOSSARY_PREVIEW_MAX_CHARS),
  projectId: glossaryProjectIdSchema.nullable().optional(),
}).strict()
export type GlossaryPreviewBody = z.infer<typeof glossaryPreviewBodySchema>

export const glossaryPreviewResponseSchema = z.object({
  text: z.string(),
  replacements: z.array(z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    original: z.string(),
    replacement: z.string(),
    entryId: z.string().min(1),
  }).strict()),
  /** SHA-256 over the effective entry ids and revisions; the voice marker records the same value. */
  glossaryRevision: z.string().regex(/^[0-9a-f]{64}$/),
  entryCount: z.number().int().nonnegative(),
}).strict()
export type GlossaryPreviewResponse = z.infer<typeof glossaryPreviewResponseSchema>

export const GLOSSARY_ERROR_CODES = [
  'validation_failed', 'json_required', 'origin_denied', 'loopback_only', 'body_too_large',
  'entry_not_found', 'entry_exists', 'entry_inactive', 'already_active', 'already_inactive',
  'glossary_invalid', 'glossary_unavailable', 'internal_error',
] as const
export const glossaryErrorSchema = z.object({ code: z.enum(GLOSSARY_ERROR_CODES) }).strict()
export type GlossaryErrorCode = (typeof GLOSSARY_ERROR_CODES)[number]
