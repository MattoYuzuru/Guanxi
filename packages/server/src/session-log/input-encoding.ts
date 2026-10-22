/**
 * Restartable bounded UTF-8 encoding for immutable string session inputs.
 *
 * `SessionInputStore.write()` hashes a string and then hands a fresh iterator
 * to the pinned helper. Both passes use this module, so the digest and the
 * transported bytes are produced by the same encoder. A yielded chunk is at
 * most the existing 64 KiB transport chunk; a full chunk owns its backing
 * buffer and the final partial chunk is the last view of a buffer the iterator
 * never reuses. `writeStdin()` only waits for `drain` when a write returns
 * false, so a yielded buffer must never be mutated after it is exposed.
 *
 * First-pass hashing necessarily encodes bounded chunks before the storage
 * handshake. Only the transport iterator is deferred until the helper identity
 * is verified. This module does not bound reads, replay, scrubbing, base64
 * transport, byte-input snapshot copies or queue events.
 */
import { createHash } from 'node:crypto'
import {
  REDACTION_MARKER_CLOSE,
  REDACTION_MARKER_OPEN,
  REDACTION_MARKER_PREFIX,
} from '@guanxi/contract'

/** The pinned helper's transport chunk bound, mirrored here without changing it. */
export const TRANSPORT_CHUNK_BYTES = 64 * 1024

export class InputEncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputEncodingError'
  }
}

interface CodePoint {
  codePoint: number
  units: number
}

function nextCodePoint(text: string, index: number): CodePoint {
  const first = text.charCodeAt(index)
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = text.charCodeAt(index + 1)
    if (second >= 0xdc00 && second <= 0xdfff) {
      return {
        codePoint: 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
        units: 2,
      }
    }
    // A lone surrogate is encoded as U+FFFD by Node's UTF-8 encoder.
    return { codePoint: 0xfffd, units: 1 }
  }
  if (first >= 0xdc00 && first <= 0xdfff) {
    return { codePoint: 0xfffd, units: 1 }
  }
  return { codePoint: first, units: 1 }
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

function encodeCodePoint(codePoint: number, target: Uint8Array): number {
  if (codePoint < 0x80) {
    target[0] = codePoint
    return 1
  }
  if (codePoint < 0x800) {
    target[0] = 0xc0 | (codePoint >> 6)
    target[1] = 0x80 | (codePoint & 0x3f)
    return 2
  }
  if (codePoint < 0x10000) {
    target[0] = 0xe0 | (codePoint >> 12)
    target[1] = 0x80 | ((codePoint >> 6) & 0x3f)
    target[2] = 0x80 | (codePoint & 0x3f)
    return 3
  }
  target[0] = 0xf0 | (codePoint >> 18)
  target[1] = 0x80 | ((codePoint >> 12) & 0x3f)
  target[2] = 0x80 | ((codePoint >> 6) & 0x3f)
  target[3] = 0x80 | (codePoint & 0x3f)
  return 4
}

/**
 * A fresh, restartable UTF-8 chunk sequence. Each call starts again at the
 * beginning of the immutable string; no yielded bytes are retained here.
 */
export async function* utf8Chunks(
  text: string,
  chunkBytes = TRANSPORT_CHUNK_BYTES,
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > TRANSPORT_CHUNK_BYTES) {
    throw new InputEncodingError('UTF-8 chunk size is invalid')
  }
  if (text.length === 0) return
  // A small first buffer avoids allocating a full transport chunk for every
  // short input; a longer input grows to the fixed bound after the first flush.
  let buffer = Buffer.allocUnsafeSlow(Math.min(chunkBytes, Math.max(1, text.length)))
  let used = 0
  const encoded = new Uint8Array(4)
  for (let index = 0; index < text.length;) {
    const point = nextCodePoint(text, index)
    index += point.units
    const length = encodeCodePoint(point.codePoint, encoded)
    for (let byte = 0; byte < length; byte += 1) {
      if (used === buffer.byteLength) {
        const full = buffer
        used = 0
        yield full
        buffer = Buffer.allocUnsafeSlow(chunkBytes)
      }
      buffer[used] = encoded[byte]!
      used += 1
    }
  }
  if (used > 0) yield buffer.subarray(0, used)
}

/** Exact SHA-256 and byte count from bounded chunks; no full encoded copy. */
export async function hashUtf8Text(
  text: string,
  chunkBytes = TRANSPORT_CHUNK_BYTES,
): Promise<{ digest: string; byteSize: number }> {
  const hash = createHash('sha256')
  let byteSize = 0
  for await (const chunk of utf8Chunks(text, chunkBytes)) {
    if (!Number.isSafeInteger(byteSize + chunk.byteLength)) {
      throw new InputEncodingError('UTF-8 input size is unsafe')
    }
    byteSize += chunk.byteLength
    hash.update(chunk)
  }
  return { digest: hash.digest('hex'), byteSize }
}

/**
 * A UTF-8-safe prefix of at most `maxBytes` bytes. It scans only until the
 * bound is exceeded, returns the original string when the whole value fits
 * (including lone surrogates), and drops a partially included known redaction
 * marker whole. The bound is a representation request, not an input limit.
 */
export function boundedUtf8Excerpt(text: string, maxBytes: number): string {
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const point = nextCodePoint(text, index)
    const length = utf8Length(point.codePoint)
    if (length > maxBytes - bytes) return truncatedPrefix(text, maxBytes)
    bytes += length
    index += point.units
  }
  return text
}

/**
 * Start of a known redaction marker that the bound cuts inside, or -1.
 *
 * The clipped prefix can end after only `⟦` or part of `REDACTED `, where the
 * prefix alone cannot distinguish a marker from ordinary decorative text. The
 * immutable original supplies a constant-length prefix lookahead; a complete
 * prefix already inside the bound needs no lookahead. Only the known marker
 * prefix qualifies, and the close search stays inside the bounded prefix.
 */
function unclosedMarkerStart(text: string, clipped: string): number {
  let start = clipped.lastIndexOf(REDACTION_MARKER_PREFIX)
  const open = clipped.lastIndexOf(REDACTION_MARKER_OPEN)
  if (
    open >= 0
    && open + REDACTION_MARKER_PREFIX.length > clipped.length
    && text.startsWith(REDACTION_MARKER_PREFIX, open)
  ) {
    start = Math.max(start, open)
  }
  if (start >= 0 && clipped.indexOf(REDACTION_MARKER_CLOSE, start) < 0) return start
  return -1
}

function truncatedPrefix(text: string, maxBytes: number): string {
  const parts: string[] = []
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const point = nextCodePoint(text, index)
    const length = utf8Length(point.codePoint)
    if (length > maxBytes - bytes) break
    parts.push(String.fromCodePoint(point.codePoint))
    bytes += length
    index += point.units
  }
  const clipped = parts.join('')
  const markerStart = unclosedMarkerStart(text, clipped)
  return markerStart >= 0 ? clipped.slice(0, markerStart) : clipped
}
