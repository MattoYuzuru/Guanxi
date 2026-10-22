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
import { test } from 'node:test'
import { INPUT_EXCERPT_BYTES } from '@guanxi/contract'
import {
  SessionInputError,
  SessionInputStore,
  utf8Excerpt,
} from '../src/session-log/input-artifacts.ts'
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

