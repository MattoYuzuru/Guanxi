import { z } from 'zod'

export const CONTEXT_CHECKPOINT_VERSION = 1 as const

export const contextCheckpointSourceStateSchema = z.enum([
  'source_preserved',
  'legacy_source_unavailable',
])

export const contextCheckpointSchema = z
  .object({
    contextCheckpointVersion: z.literal(CONTEXT_CHECKPOINT_VERSION),
    id: z.string().min(1),
    threadId: z.string().min(1),
    previousCheckpointId: z.string().min(1).nullable(),
    source: z
      .object({
        state: contextCheckpointSourceStateSchema,
        upToSeq: z.number().int().nonnegative(),
        messageCount: z.number().int().positive().nullable(),
      })
      .strict(),
    summary: z
      .object({
        format: z.literal('text_utf8_v1'),
        content: z.string().min(1),
        byteSize: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.source.state === 'source_preserved' &&
      checkpoint.source.messageCount === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'messageCount'],
        message: 'Preserved source must have an exact Message count',
      })
    }
    if (
      checkpoint.source.state === 'legacy_source_unavailable' &&
      checkpoint.source.messageCount !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'messageCount'],
        message: 'Legacy deleted source count is unknown',
      })
    }
  })
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>

export const contextCheckpointListSchema = z.array(contextCheckpointSchema)
