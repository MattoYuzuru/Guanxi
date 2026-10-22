/**
 * Shared runtime schemas for bounded session inputs and queue v3.
 *
 * This leaf imports only `zod`. Both the event barrel and the native-agent
 * contract use it, so neither has to import the other at module evaluation time
 * (an eager `session-events` <-> `native-agent` Zod cycle would make a cold
 * import order-dependent). Public names that used to live in `session-events.ts`
 * are re-exported there unchanged.
 */
import { z } from 'zod'

/**
 * Representation policy, not an acceptance cap: an event stores its input
 * inline at or below this scrubbed UTF-8 size and as a local artifact above it.
 */
export const INPUT_INLINE_BYTES = 16 * 1024
/** The exact maximum scrubbed UTF-8 excerpt an artifact reference carries. */
export const INPUT_EXCERPT_BYTES = 8 * 1024
export const SESSION_INPUT_TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8' as const
export const SESSION_INPUT_JSON_MEDIA_TYPE = 'application/json' as const

/**
 * Redaction markers in scrubbed payloads (D-141): `⟦REDACTED secret://ref⟧`.
 * The egress scrubber writes them; clients render them. Registered secret
 * values may not contain the delimiters, so a marker is unambiguous.
 */
export const REDACTION_MARKER_OPEN = '\u27E6'
export const REDACTION_MARKER_CLOSE = '\u27E7'
export const REDACTION_MARKER_PREFIX = `${REDACTION_MARKER_OPEN}REDACTED `

export const sessionInputMediaTypeSchema = z.enum([
  SESSION_INPUT_TEXT_MEDIA_TYPE,
  SESSION_INPUT_JSON_MEDIA_TYPE,
])
export type SessionInputMediaType = z.infer<typeof sessionInputMediaTypeSchema>

export const sessionInputChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/**
 * The published reference a v2 event or a v3 queue item carries. There is
 * deliberately no full `text`/`arguments` field beside it, so a reference
 * cannot be misused as content. `excerptBytes` must equal the UTF-8 length of
 * `excerpt`.
 */
export const sessionInputArtifactRefSchema = z
  .object({
    artifactId: z.string().uuid(),
    checksum: sessionInputChecksumSchema,
    byteSize: z.number().int().positive().safe(),
    mediaType: sessionInputMediaTypeSchema,
    excerpt: z.string(),
    excerptBytes: z.number().int().nonnegative().max(INPUT_EXCERPT_BYTES).safe(),
  })
  .strict()
  .refine((value) => utf8Bytes(value.excerpt) === value.excerptBytes, {
    message: 'An input excerpt must declare its exact UTF-8 byte length',
  })
export type SessionInputArtifactRef = z.infer<typeof sessionInputArtifactRefSchema>

/** The append-time descriptor; the log resolves the owned `artifactId`. */
export const sessionInputArtifactInputSchema = z
  .object({
    checksum: sessionInputChecksumSchema,
    byteSize: z.number().int().positive().safe(),
    mediaType: sessionInputMediaTypeSchema,
    excerpt: z.string(),
  })
  .strict()
export type SessionInputArtifactInput = z.infer<typeof sessionInputArtifactInputSchema>

/**
 * One published queue entry. Inline text is bounded to `INPUT_INLINE_BYTES`
 * scrubbed UTF-8 bytes; the artifact branch carries no `text`, only the
 * existing exact reference/excerpt shape.
 */
export const queueInlineV3Schema = z
  .object({
    id: z.string(),
    kind: z.literal('inline'),
    text: z.string(),
  })
  .strict()
  .refine((value) => utf8Bytes(value.text) <= INPUT_INLINE_BYTES, {
    message: 'Inline queue text must not exceed the published inline byte bound',
    path: ['text'],
  })
export type QueueInlineV3 = z.infer<typeof queueInlineV3Schema>

export const queueArtifactV3Schema = z
  .object({
    id: z.string(),
    kind: z.literal('artifact'),
    artifact: sessionInputArtifactRefSchema,
  })
  .strict()
  .refine((value) => value.artifact.mediaType === SESSION_INPUT_TEXT_MEDIA_TYPE, {
    message: 'Queue artifacts carry scrubbed plain text only',
    path: ['artifact', 'mediaType'],
  })
  .refine((value) => value.artifact.byteSize > INPUT_INLINE_BYTES, {
    message: 'A queue artifact represents input above the inline byte bound',
    path: ['artifact', 'byteSize'],
  })
export type QueueArtifactV3 = z.infer<typeof queueArtifactV3Schema>

export const queueItemV3Schema = z.union([queueInlineV3Schema, queueArtifactV3Schema])
export type QueueItemV3 = z.infer<typeof queueItemV3Schema>

function assertUniqueQueueIds(
  items: readonly { id: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'id'],
        message: 'Queue item ids must be unique within a snapshot',
      })
    }
    seen.add(item.id)
  })
}

export const queueDataV3Schema = z
  .object({ items: z.array(queueItemV3Schema) })
  .strict()
  .superRefine((value, context) => assertUniqueQueueIds(value.items, context))
export type QueueDataV3 = z.infer<typeof queueDataV3Schema>

/**
 * Append-time queue data: artifact entries carry a descriptor, never a
 * caller-selected artifact id. The log resolves the owned id inside the same
 * transaction as the event insert.
 */
export const queueAppendArtifactV3Schema = z
  .object({
    id: z.string(),
    kind: z.literal('artifact'),
    input: sessionInputArtifactInputSchema,
  })
  .strict()
  .refine((value) => value.input.mediaType === SESSION_INPUT_TEXT_MEDIA_TYPE, {
    message: 'Queue artifacts carry scrubbed plain text only',
    path: ['input', 'mediaType'],
  })
  .refine((value) => value.input.byteSize > INPUT_INLINE_BYTES, {
    message: 'A queue artifact represents input above the inline byte bound',
    path: ['input', 'byteSize'],
  })
export type QueueAppendArtifactV3 = z.infer<typeof queueAppendArtifactV3Schema>

export const queueAppendItemV3Schema = z.union([queueInlineV3Schema, queueAppendArtifactV3Schema])
export type QueueAppendItemV3 = z.infer<typeof queueAppendItemV3Schema>

export const queueAppendDataV3Schema = z
  .object({ items: z.array(queueAppendItemV3Schema) })
  .strict()
  .superRefine((value, context) => assertUniqueQueueIds(value.items, context))
export type QueueAppendDataV3 = z.infer<typeof queueAppendDataV3Schema>
