/** Current-registry projection of already bounded input excerpts; no artifact IO. */
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  queueDataV3Schema,
  type QueueArtifactV3,
  type QueueDataV3,
} from '@guanxi/contract'
import { REDACTION_MARKER_CLOSE, REDACTION_MARKER_OPEN, REDACTION_MARKER_PREFIX, type EgressScrubber } from '../egress/types.ts'

function boundedExcerpt(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= INPUT_EXCERPT_BYTES) return text
  let end = INPUT_EXCERPT_BYTES
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  let clipped = bytes.subarray(0, end).toString('utf8')
  // A marker's opening delimiter can precede the cut even when its prefix
  // or closing delimiter does not fit. Drop that whole marker and its tail.
  const open = clipped.lastIndexOf(REDACTION_MARKER_OPEN)
  if (open >= 0 && clipped.indexOf(REDACTION_MARKER_CLOSE, open) < 0) clipped = clipped.slice(0, open)
  return clipped
}

export function projectInputExcerpt(data: unknown, scrubber: EgressScrubber): unknown {
  if (data === null || typeof data !== 'object') return scrubber.scrub(data)
  const original = data as Record<string, unknown>
  const artifact = original.artifact
  if (artifact === null || typeof artifact !== 'object') return scrubber.scrub(data)
  const input = artifact as Record<string, unknown>
  if (typeof input.excerpt !== 'string') return scrubber.scrub(data)
  // Capture this BEFORE replacement: a new marker may expand the excerpt's
  // length past byteSize, but cannot establish that the original was complete.
  const storedBytes = typeof input.excerptBytes === 'number' ? input.excerptBytes : Buffer.byteLength(input.excerpt, 'utf8')
  // A marker already stored at append may have expanded a short excerpt past
  // the full artifact's byteSize. Without the original bytes that comparison
  // cannot prove completeness, so protect this ambiguous boundary as well.
  const truncated = input.excerpt.includes(REDACTION_MARKER_PREFIX) ||
    (typeof input.byteSize === 'number' &&
      (input.byteSize > storedBytes || input.byteSize > Buffer.byteLength(input.excerpt, 'utf8')))
  const protectedText = truncated
    ? scrubber.scrubTruncatedPrefix?.(input.excerpt) ?? ''
    : scrubber.scrub(input.excerpt)
  const excerpt = boundedExcerpt(protectedText)
  return scrubber.scrub({ ...original, artifact: { ...input, excerpt, excerptBytes: Buffer.byteLength(excerpt, 'utf8') } })
}

/** Content-free failure of a v3 queue projection; never carries payload text. */
export class QueueProjectionError extends Error {
  readonly code = 'queue_projection_invalid' as const

  constructor() {
    super('The stored queue snapshot cannot be projected safely')
    this.name = 'QueueProjectionError'
  }
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function unchanged(value: string, original: string): boolean {
  return value === original
}

/**
 * Projects one published v3 queue snapshot with the current registry.
 *
 * - An inline value may expand past its write-time bound after a late secret
 *   registration. The locked policy is a content-free refusal, never
 *   truncation of executable text; the stored payload stays untouched.
 * - Each artifact excerpt is projected independently, so one item's marker
 *   cannot change another item's excerpt bytes.
 * - Required opaque fields (queue id, artifact id/checksum/size/media type)
 *   must survive scrubbing byte-for-byte. A late registration that would
 *   rewrite one fails closed instead of fabricating a usable reference.
 *
 * This function is pure with respect to storage: it never reads a blob.
 */
export function projectQueueV3Data(data: unknown, scrubber: EgressScrubber): QueueDataV3 {
  const parsed = queueDataV3Schema.safeParse(data)
  if (!parsed.success) throw new QueueProjectionError()
  const items = parsed.data.items.map((item) => {
    if (!unchanged(scrubber.scrub(item.id), item.id)) throw new QueueProjectionError()
    if (item.kind === 'inline') {
      const text = scrubber.scrub(item.text)
      if (utf8Length(text) > INPUT_INLINE_BYTES) throw new QueueProjectionError()
      return { id: item.id, kind: 'inline' as const, text }
    }
    const projected = projectInputExcerpt(
      { id: item.id, kind: 'artifact' as const, artifact: item.artifact },
      scrubber,
    ) as QueueArtifactV3
    const before = item.artifact
    const after = projected.artifact
    if (
      after.artifactId !== before.artifactId
      || after.checksum !== before.checksum
      || after.byteSize !== before.byteSize
      || after.mediaType !== before.mediaType
    ) {
      throw new QueueProjectionError()
    }
    return projected
  })
  const projected = queueDataV3Schema.safeParse({ items })
  if (!projected.success) throw new QueueProjectionError()
  return projected.data
}
