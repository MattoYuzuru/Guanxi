/** Current-registry projection of an already bounded input excerpt; no artifact IO. */
import { INPUT_EXCERPT_BYTES } from '@guanxi/contract'
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
