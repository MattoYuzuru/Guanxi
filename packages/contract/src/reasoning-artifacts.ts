import { z } from 'zod'

export const REASONING_ARTIFACT_VERSION = 1 as const
export const REASONING_RETENTION_DAYS = 7 as const

export const reasoningArtifactScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless'), projectId: z.null() }).strict(),
  z.object({ scope: z.literal('project'), projectId: z.string().min(1) }).strict(),
])

export const reasoningArtifactSchema = z
  .object({
    artifactVersion: z.literal(REASONING_ARTIFACT_VERSION),
    id: z.string().uuid(),
    type: z.literal('reasoning'),
    mediaType: z.literal('text/markdown; charset=utf-8'),
    storageKind: z.literal('sqlite_text'),
    byteSize: z.number().int().nonnegative().safe(),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
    source: z
      .object({
        chatId: z.string().min(1),
        messageId: z.string().min(1),
        jobId: z.string().uuid(),
      })
      .strict(),
    ownership: reasoningArtifactScopeSchema,
    retention: z
      .object({
        basis: z.literal('diagnostic_7_days'),
        expiresAfterDays: z.literal(REASONING_RETENTION_DAYS),
        artifactExpiresAt: z.string().datetime(),
        parentMode: z.enum(['keep', 'ttl', 'session']),
        parentExpiresAt: z.string().datetime().nullable(),
        effectiveExpiresAt: z.string().datetime(),
        relationship: z.literal('shorter_parent_retention_wins'),
        automaticDeletion: z.literal('not_implemented'),
      })
      .strict(),
  })
  .strict()

export const reasoningArtifactWithContentSchema = reasoningArtifactSchema
  .extend({ content: z.string() })
  .strict()
  .superRefine((artifact, context) => {
    if (new TextEncoder().encode(artifact.content).byteLength !== artifact.byteSize) {
      context.addIssue({ code: 'custom', path: ['byteSize'], message: 'Artifact byte size mismatch' })
    }
  })

export const generatedAnswerProjectionSchema = z
  .object({
    messageId: z.string().min(1),
    jobId: z.string().uuid(),
    createdAt: z.string().datetime(),
    byteSize: z.number().int().nonnegative().safe(),
  })
  .strict()

export type ReasoningArtifact = z.infer<typeof reasoningArtifactSchema>
export type ReasoningArtifactWithContent = z.infer<typeof reasoningArtifactWithContentSchema>
export type GeneratedAnswerProjection = z.infer<typeof generatedAnswerProjectionSchema>
