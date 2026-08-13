import { z } from 'zod'

export const ARTIFACT_VERSION = 1 as const

export const artifactKindSchema = z.enum([
  'text',
  'reasoning',
  'transcript',
  'image',
  'audio',
  'video',
  'document',
  'structured',
  'embedding',
  'file',
  'checkpoint',
  'report',
])
export type ArtifactKind = z.infer<typeof artifactKindSchema>

/** Canonical lower-case media type; parameters use one explicit SP separator. */
export const artifactMediaTypeSchema = z
  .string()
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:; [a-z0-9][a-z0-9!#$&^_.+-]{0,62}=[a-z0-9][a-z0-9!#$&^_.+:-]{0,126})*$/u,
  )

export const artifactScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless') }).strict(),
  z.object({ scope: z.literal('project'), projectId: z.string().uuid() }).strict(),
])
export type ArtifactScope = z.infer<typeof artifactScopeSchema>

export const artifactSourceSchema = z
  .object({
    jobId: z.string().uuid().nullable(),
    parentArtifactId: z.string().uuid().nullable(),
  })
  .strict()
export type ArtifactSource = z.infer<typeof artifactSourceSchema>

export const artifactCreateMetadataSchema = z
  .object({
    artifactVersion: z.literal(ARTIFACT_VERSION),
    idempotencyKey: z.string().uuid(),
    kind: artifactKindSchema,
    mediaType: artifactMediaTypeSchema,
    ownership: artifactScopeSchema,
    source: artifactSourceSchema,
  })
  .strict()
export type ArtifactCreateMetadata = z.infer<typeof artifactCreateMetadataSchema>

export const artifactSchema = z
  .object({
    artifactVersion: z.literal(ARTIFACT_VERSION),
    id: z.string().uuid(),
    kind: artifactKindSchema,
    mediaType: artifactMediaTypeSchema,
    byteSize: z.number().int().nonnegative().safe(),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    ownership: artifactScopeSchema,
    source: artifactSourceSchema,
    retention: z.object({ mode: z.literal('keep') }).strict(),
    reference: z.object({ state: z.literal('referenced') }).strict(),
    gc: z.object({ state: z.literal('not_implemented') }).strict(),
    createdAt: z.string().datetime(),
  })
  .strict()
export type Artifact = z.infer<typeof artifactSchema>

export const artifactContentSchema = z
  .object({
    artifact: artifactSchema,
    content: z.instanceof(Uint8Array),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.content.byteLength !== value.artifact.byteSize) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Artifact byte size mismatch',
      })
    }
  })
export type ArtifactContent = z.infer<typeof artifactContentSchema>
