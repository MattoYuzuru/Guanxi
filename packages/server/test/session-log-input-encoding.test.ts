/**
 * Bounded UTF-8 string input encoding: allocation and excerpt semantics.
 *
 * These tests treat a whole `Buffer.from(text, 'utf8')` as the TEST-ONLY
 * oracle. The production path must not allocate or encode the complete string
 * for hashing, transport or excerpt construction. The final assertion set also
 * covers the bounded chunk iterator after it exists; this first block is
 * deliberately written against the old public API so a whole-input guard or
 * excerpt split fails before the implementation lands.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { INPUT_EXCERPT_BYTES } from '@guanxi/contract'
import {
  SessionInputError,
  SessionInputStore,
  utf8Excerpt,
} from '../src/session-log/input-artifacts.ts'
import { hashUtf8Text, utf8Chunks } from '../src/session-log/input-encoding.ts'
import type { Db } from '../src/store/db.ts'

const MEDIA_TEXT = 'text/plain; charset=utf-8' as const
const TRANSPORT_CHUNK_BYTES = 64 * 1024

interface BufferObservation {
  stringBytes: number[]
  encodedStringBytes: number[]
  allocationBytes: number[]
}

/**
 * Records `Buffer.from(string)` sizes, `TextEncoder.encode` input sizes and
 * every Buffer allocation made while `run` is active. Test-only instrumentation
 * around the real production call; no production seam is added for this
 * observation.
 */
async function observeBufferAllocations<T>(
  run: () => Promise<T> | T,
): Promise<{ result: T; observation: BufferObservation }> {
  const originalFrom = Buffer.from
  const originalAlloc = Buffer.alloc
  const originalAllocUnsafe = Buffer.allocUnsafe
  const originalAllocUnsafeSlow = Buffer.allocUnsafeSlow
  const originalEncode = TextEncoder.prototype.encode
  const observation: BufferObservation = { stringBytes: [], encodedStringBytes: [], allocationBytes: [] }
  const record = (value: Uint8Array): void => {
    observation.allocationBytes.push(value.byteLength)
  }
  Buffer.from = ((value: unknown, ...args: unknown[]) => {
    if (typeof value === 'string') {
      observation.stringBytes.push(Buffer.byteLength(value, args[0] as BufferEncoding | undefined))
    }
    const result = (originalFrom as unknown as (value: unknown, ...rest: unknown[]) => Uint8Array)(value, ...args)
    record(result)
    return result
  }) as typeof Buffer.from
  Buffer.alloc = ((size: number, ...args: unknown[]) => {
    const result = (originalAlloc as unknown as (size: number, ...rest: unknown[]) => Buffer)(size, ...args)
    record(result)
    return result
  }) as typeof Buffer.alloc
  Buffer.allocUnsafe = ((size: number) => {
    const result = originalAllocUnsafe(size)
    record(result)
    return result
  }) as typeof Buffer.allocUnsafe
  Buffer.allocUnsafeSlow = ((size: number) => {
    const result = originalAllocUnsafeSlow(size)
    record(result)
    return result
  }) as typeof Buffer.allocUnsafeSlow
  TextEncoder.prototype.encode = function (this: InstanceType<typeof TextEncoder>, input?: string): ReturnType<typeof TextEncoder.prototype.encode> {
    if (typeof input === 'string') observation.encodedStringBytes.push(Buffer.byteLength(input, 'utf8'))
    const result = originalEncode.call(this, input)
    record(result)
    return result
  }
  try {
    return { result: await run(), observation }
  } finally {
    Buffer.from = originalFrom
    Buffer.alloc = originalAlloc
    Buffer.allocUnsafe = originalAllocUnsafe
    Buffer.allocUnsafeSlow = originalAllocUnsafeSlow
    TextEncoder.prototype.encode = originalEncode
  }
}

test('a large string write does not allocate or encode a whole-input buffer', async () => {
  const store = new SessionInputStore({ dataDir: '/unused', db: {} as Db })
  const stop = new Error('stop-before-storage')
  ;(store as unknown as { sessionDirectory: () => Promise<never> }).sessionDirectory = async () => {
    throw stop
  }
  const text = 'a'.repeat(1024 * 1024)
  const { observation } = await observeBufferAllocations(async () => {
    await assert.rejects(
      store.write('session', text, MEDIA_TEXT),
      (error: unknown) => error === stop,
    )
  })
  assert.deepEqual(
    observation.stringBytes.filter((size) => size > TRANSPORT_CHUNK_BYTES),
    [],
    'no whole-string Buffer.from call',
  )
  assert.deepEqual(
    observation.encodedStringBytes.filter((size) => size > TRANSPORT_CHUNK_BYTES),
    [],
    'no whole-string TextEncoder.encode call',
  )
  assert.deepEqual(
    observation.allocationBytes.filter((size) => size > TRANSPORT_CHUNK_BYTES),
    [],
    'no whole-input buffer allocation',
  )
})

test('excerpt construction does not allocate a whole-input buffer', async () => {
  const text = 'a'.repeat(1024 * 1024)
  const { result, observation } = await observeBufferAllocations(() => utf8Excerpt(text))
  assert.equal(Buffer.byteLength(result), INPUT_EXCERPT_BYTES)
  assert.deepEqual(
    observation.stringBytes.filter((size) => size > INPUT_EXCERPT_BYTES),
    [],
    'no whole-string Buffer.from call',
  )
  assert.deepEqual(
    observation.encodedStringBytes.filter((size) => size > INPUT_EXCERPT_BYTES),
    [],
    'no whole-string TextEncoder.encode call',
  )
  assert.deepEqual(
    observation.allocationBytes.filter((size) => size > INPUT_EXCERPT_BYTES),
    [],
    'no whole-input buffer allocation',
  )
})

test('truncated excerpts keep redaction markers whole', () => {
  const marker = '\u27E6REDACTED secret://fixture/a\u27E7'
  const text = 'a'.repeat(20) + marker + 'b'.repeat(20)
  assert.equal(utf8Excerpt(text, 30), 'a'.repeat(20))

  const two = 'a'.repeat(10) + marker + 'b'.repeat(10) + marker + 'c'.repeat(10)
  const beforeSecond = Buffer.byteLength('a'.repeat(10) + marker + 'b'.repeat(10))
  assert.equal(utf8Excerpt(two, beforeSecond + 5), 'a'.repeat(10) + marker + 'b'.repeat(10))

  const complete = 'x'.repeat(5) + marker + 'y'.repeat(5)
  assert.equal(utf8Excerpt(complete, Buffer.byteLength(complete)), complete)
  const unmatched = 'x\u27E6y'
  assert.equal(utf8Excerpt(unmatched, 100), unmatched)
})

test('excerpt preserves complete lone surrogates and matches the UTF-8 prefix oracle', () => {
  assert.equal(utf8Excerpt('\ud800', 3), '\ud800')
  assert.equal(utf8Excerpt('\ud800', 2), '')
  assert.equal(utf8Excerpt('\ud800', 4), '\ud800')
  assert.equal(utf8Excerpt('\udc00X', 3), '\ufffd')
  assert.equal(utf8Excerpt('\udc00X', 4), '\udc00X')
  assert.equal(utf8Excerpt('', 0), '')
  assert.equal(utf8Excerpt('x', 0), '')
})

test('excerpt rejects malformed bounds with a content-free invalid_input error', () => {
  for (const bound of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => utf8Excerpt('private-value', bound),
      (error: unknown) => error instanceof SessionInputError
        && error.code === 'invalid_input'
        && error.message.includes('private-value') === false,
    )
  }
  assert.equal(utf8Excerpt('private-value', 0), '')
})

test('excerpt controls keep the existing UTF-8-safe prefix for ordinary text', () => {
  const text = 'a'.repeat(8191) + 'ЁЁ'
  assert.equal(utf8Excerpt(text), 'a'.repeat(8191))
  assert.equal(utf8Excerpt('short'), 'short')
})

interface ChunkCase {
  name: string
  text: string
  chunkBytes: number
}

function chunkCases(): ChunkCase[] {
  const small = 16
  const transport = TRANSPORT_CHUNK_BYTES
  return [
    { name: 'empty', text: '', chunkBytes: transport },
    { name: 'one ASCII byte', text: 'a', chunkBytes: transport },
    { name: 'one two-byte BMP code point', text: 'é', chunkBytes: transport },
    { name: 'one three-byte BMP code point', text: '€', chunkBytes: transport },
    { name: 'one supplementary code point', text: '😀', chunkBytes: transport },
    { name: 'lone high surrogate', text: '\ud83d', chunkBytes: transport },
    { name: 'lone low surrogate', text: '\ude00', chunkBytes: transport },
    { name: 'high surrogate before ASCII', text: '\ud83dX', chunkBytes: transport },
    { name: 'ASCII before lone low surrogate', text: 'X\ude00', chunkBytes: transport },
    { name: 'pair straddles a small chunk', text: 'a'.repeat(small - 1) + '😀', chunkBytes: small },
    { name: 'pair starts at the small chunk edge', text: 'a'.repeat(small - 2) + '😀b', chunkBytes: small },
    { name: 'small exact chunk', text: 'a'.repeat(small), chunkBytes: small },
    { name: 'small chunk plus one', text: 'a'.repeat(small + 1), chunkBytes: small },
    { name: 'multiple multi-byte chunks', text: '😀'.repeat(37) + 'é'.repeat(41), chunkBytes: small },
    { name: 'transport boundary pair', text: 'a'.repeat(transport - 1) + '😀', chunkBytes: transport },
    { name: 'transport boundary three-byte code point', text: 'a'.repeat(transport - 2) + '€', chunkBytes: transport },
    { name: 'transport exact chunk', text: 'a'.repeat(transport), chunkBytes: transport },
    { name: 'transport chunk plus one', text: 'a'.repeat(transport + 1), chunkBytes: transport },
    { name: '16 KiB threshold exact', text: 'a'.repeat(16 * 1024), chunkBytes: transport },
    { name: '16 KiB threshold plus one', text: 'a'.repeat(16 * 1024 + 1), chunkBytes: transport },
    { name: 'mixed supplementary and BMP', text: 'x😀é€'.repeat(10_000), chunkBytes: transport },
  ]
}

/**
 * TEST-ONLY whole-buffer UTF-8 safe prefix: encode the complete value, then
 * drop only an incomplete trailing code point. It deliberately has no
 * redaction-marker rule, so ordinary delimiters are checked against the prior
 * prefix semantics instead of mirroring production's marker parsing.
 */
function wholeBufferUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function marker(): string {
  return '\u27E6REDACTED secret://fixture/abcdef\u27E7'
}

test('bounded UTF-8 chunks match an independent whole-buffer oracle', async () => {
  for (const item of chunkCases()) {
    const oracle = Buffer.from(item.text, 'utf8')
    const chunks: Buffer[] = []
    for await (const chunk of utf8Chunks(item.text, item.chunkBytes)) {
      assert.ok(chunk.byteLength <= item.chunkBytes, `${item.name}: chunk exceeds its bound`)
      chunks.push(Buffer.from(chunk))
    }
    assert.deepEqual(Buffer.concat(chunks), oracle, item.name)
  }
})

test('yielded chunks own distinct backing bytes and are not mutated after the next pull', async () => {
  const text = 'a'.repeat(TRANSPORT_CHUNK_BYTES - 1) + '😀' + 'b'.repeat(TRANSPORT_CHUNK_BYTES)
  const iterator = utf8Chunks(text)[Symbol.asyncIterator]()
  const backings = new Set<ArrayBufferLike>()
  let previous: { chunk: Uint8Array; snapshot: Buffer } | null = null
  let count = 0
  for (;;) {
    const { value, done } = await iterator.next()
    if (done) break
    count += 1
    if (previous !== null) {
      assert.deepEqual(Buffer.from(previous.chunk), previous.snapshot, 'a later pull mutated an earlier chunk')
    }
    assert.equal(backings.has(value.buffer), false, 'two chunks share one backing buffer')
    backings.add(value.buffer)
    assert.ok(value.byteLength <= TRANSPORT_CHUNK_BYTES)
    previous = { chunk: value, snapshot: Buffer.from(value) }
  }
  if (previous !== null) assert.deepEqual(Buffer.from(previous.chunk), previous.snapshot)
  assert.ok(count >= 2, 'the fixture spans multiple chunks')
})

test('hashUtf8Text matches the whole-buffer SHA-256 and byte size for every chunk boundary', async () => {
  for (const item of chunkCases()) {
    const oracle = Buffer.from(item.text, 'utf8')
    const result = await hashUtf8Text(item.text, item.chunkBytes)
    assert.equal(result.byteSize, oracle.byteLength, `${item.name}: byte size`)
    assert.equal(result.digest, createHash('sha256').update(oracle).digest('hex'), `${item.name}: digest`)
  }
})

test('excerpts match the UTF-8 prefix oracle across ASCII, BMP, supplementary and surrogate cases', () => {
  const texts = [
    '',
    'a',
    'é€😀',
    '\ud83d',
    '\ude00',
    'X\ude00Y\ud83dZ',
    'a'.repeat(8191) + 'ЁЁ',
    '😀'.repeat(3000),
    'x\u27E6y',
  ]
  const bounds = [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 63, 64, 255, 1024,
    8191, 8192, 8193, 16383, 16384, 16385, 64 * 1024]
  for (const text of texts) {
    for (const bound of bounds) {
      const result = utf8Excerpt(text, bound)
      assert.equal(result, wholeBufferUtf8Prefix(text, bound), `text ${JSON.stringify(text)} bound ${bound}`)
      assert.ok(Buffer.byteLength(result) <= bound, `text ${JSON.stringify(text)} bound ${bound}: excerpt bound`)
    }
  }
})

test('excerpt marker boundaries clip the whole marker, including a cut close delimiter', () => {
  const patch = marker()
  const prefix = 'a'.repeat(10)
  const suffix = 'b'.repeat(10)
  const text = prefix + patch + suffix
  const markerStart = Buffer.byteLength(prefix)
  const markerEnd = markerStart + Buffer.byteLength(patch)
  for (const bound of [markerStart, markerStart + 1, markerStart + 2, markerStart + 3,
    markerStart + 12, markerEnd - 1, markerEnd, markerEnd + 1, markerEnd + 5]) {
    const result = utf8Excerpt(text, bound)
    if (bound < markerEnd) {
      assert.equal(result, prefix, `bound ${bound}`)
    } else {
      assert.equal(result, prefix + patch + suffix.slice(0, bound - markerEnd), `bound ${bound}`)
    }
  }
})

test('plain decorative brackets keep the prior whole-buffer UTF-8 prefix', () => {
  const texts = [
    'A\u27E6ordinary decoration and more',
    'A\u27E6REDACTE decoration',
    'A\u27E6REDACTED',
    'A\u27E6redacted secret://fixture/a\u27E7',
  ]
  const bounds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 31, 64]
  for (const text of texts) {
    for (const bound of bounds) {
      assert.equal(
        utf8Excerpt(text, bound),
        wholeBufferUtf8Prefix(text, bound),
        `text ${JSON.stringify(text)} bound ${bound}`,
      )
    }
    assert.equal(utf8Excerpt(text, Buffer.byteLength(text)), text)
    assert.equal(utf8Excerpt(text, Buffer.byteLength(text) + 10), text)
  }
  const large = 'A\u27E6' + 'x'.repeat(9000)
  assert.equal(utf8Excerpt(large), wholeBufferUtf8Prefix(large, INPUT_EXCERPT_BYTES))

  // A complete known marker must not make a later ordinary bracket look split.
  const patch = marker()
  const mixed = 'a'.repeat(10) + patch + '\u27E6ordinary'
  const mixedBound = Buffer.byteLength('a'.repeat(10) + patch + '\u27E6ord')
  assert.equal(utf8Excerpt(mixed, mixedBound), 'a'.repeat(10) + patch + '\u27E6ord')
})

test('known marker cuts at opening, partial-prefix and interior bounds clip whole', () => {
  const before = 'a'.repeat(10)
  const openBytes = Buffer.byteLength('\u27E6')
  const prefixBytes = Buffer.byteLength('\u27E6REDACTED ')
  const closeBytes = Buffer.byteLength('\u27E7')
  const patch = marker()
  const markerBytes = Buffer.byteLength(patch)
  const text = before + patch + 'tail'
  const markerStart = Buffer.byteLength(before)
  const cases: Array<[number, string]> = [
    [markerStart, before],
    [markerStart + 1, before],
    [markerStart + openBytes, before],
    [markerStart + openBytes + 1, before],
    [markerStart + openBytes + 4, before],
    [markerStart + prefixBytes - 1, before],
    [markerStart + prefixBytes, before],
    [markerStart + prefixBytes + 1, before],
    [markerStart + markerBytes - closeBytes - 1, before],
    [markerStart + markerBytes - 1, before],
    [markerStart + markerBytes, before + patch],
    [markerStart + markerBytes + 1, before + patch + 't'],
  ]
  for (const [bound, expected] of cases) {
    assert.equal(utf8Excerpt(text, bound), expected, `bound ${bound}`)
  }
  assert.equal(utf8Excerpt(patch + 'tail', openBytes), '')
  assert.equal(utf8Excerpt(patch + 'tail', Buffer.byteLength('\u27E6RED')), '')
})

test('complete decorative, marker-like and marker values remain unchanged', () => {
  const patch = marker()
  for (const text of [
    'A\u27E6ordinary',
    'A\u27E6REDACTE decoration',
    'A\u27E6REDACTED',
    'A\u27E6REDACTED more',
    patch,
    'A' + patch + 'tail',
    '\ud800',
  ]) {
    assert.equal(utf8Excerpt(text, Buffer.byteLength(text)), text)
    assert.equal(utf8Excerpt(text, Buffer.byteLength(text) + 10), text)
  }
})
