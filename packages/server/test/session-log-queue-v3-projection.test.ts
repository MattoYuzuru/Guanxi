/**
 * Pure current-registry projection of queue v3 snapshots. No database, blob,
 * helper or provider is touched: `projectQueueV3Data` is a display/read
 * boundary only.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  queueDataV3Schema,
  type QueueDataV3,
} from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { QueueProjectionError, projectQueueV3Data } from '../src/session-log/excerpt.ts'

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const CHECKSUM = `sha256:${'b'.repeat(64)}`
const SECRET = 's3cr3t!!'

function artifact(excerpt: string, byteSize = INPUT_INLINE_BYTES + 4096) {
  return {
    artifactId: ARTIFACT_ID,
    checksum: CHECKSUM,
    byteSize,
    mediaType: 'text/plain; charset=utf-8' as const,
    excerpt,
    excerptBytes: Buffer.byteLength(excerpt, 'utf8'),
  }
}

describe('queue v3 current-registry projection', () => {
  it('redacts an inline value without changing its queue id or mutating input', () => {
    const scrubber = new SecretScrubber()
    scrubber.register('secret://queue/late', SECRET)
    const data: QueueDataV3 = {
      items: [{ id: 'inline-item', kind: 'inline', text: `before ${SECRET} after` }],
    }
    const before = structuredClone(data)
    const projected = projectQueueV3Data(data, scrubber)
    assert.deepEqual(data, before, 'stored input is immutable')
    assert.equal(projected.items[0]?.id, 'inline-item')
    assert.equal(projected.items[0]?.kind, 'inline')
    assert.equal(JSON.stringify(projected).includes(SECRET), false)
    assert.match(JSON.stringify(projected), /REDACTED secret:\/\/queue\/late/u)
  })

  it('refuses an inline value expanded past 16 KiB by late registration instead of truncating it', () => {
    const scrubber = new SecretScrubber()
    const data: QueueDataV3 = {
      items: [{ id: 'expanding', kind: 'inline', text: SECRET.repeat(INPUT_INLINE_BYTES / SECRET.length) }],
    }
    assert.equal(Buffer.byteLength((data.items[0] as { text: string }).text, 'utf8'), INPUT_INLINE_BYTES)
    assert.equal(queueDataV3Schema.safeParse(data).success, true)
    const before = structuredClone(data)
    scrubber.register('secret://queue/expand', SECRET)
    assert.throws(() => projectQueueV3Data(data, scrubber), QueueProjectionError)
    assert.deepEqual(data, before, 'the stored value is preserved for a later registry state')
  })

  it('projects plural artifact excerpts independently and recomputes exact excerpt bytes', () => {
    const scrubber = new SecretScrubber()
    const first = `${SECRET} first excerpt ${'a'.repeat(64)}`
    const second = `second excerpt ${SECRET} ${'z'.repeat(64)}`
    const data: QueueDataV3 = {
      items: [
        { id: 'first', kind: 'artifact', artifact: artifact(first) },
        { id: 'second', kind: 'artifact', artifact: artifact(second) },
      ],
    }
    scrubber.register('secret://queue/plural', SECRET)
    const projected = projectQueueV3Data(data, scrubber)
    const [one, two] = projected.items
    if (one?.kind !== 'artifact' || two?.kind !== 'artifact') throw new Error('expected artifacts')
    assert.equal(Buffer.byteLength(one.artifact.excerpt, 'utf8'), one.artifact.excerptBytes)
    assert.equal(Buffer.byteLength(two.artifact.excerpt, 'utf8'), two.artifact.excerptBytes)
    assert.ok(one.artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
    assert.ok(two.artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
    const text = JSON.stringify(projected)
    assert.equal(text.includes(SECRET), false)
    assert.equal(text.includes('FULL-TAIL-NOT-IN-THE-EXCERPT'), false)
    assert.deepEqual(projected.items.map((item) => item.id), ['first', 'second'])
  })

  it('fails closed when late registration would rewrite a queue item id or artifact reference', () => {
    const idScrubber = new SecretScrubber()
    const idData: QueueDataV3 = { items: [{ id: SECRET, kind: 'inline', text: 'x' }] }
    idScrubber.register('secret://queue/id', SECRET)
    assert.throws(() => projectQueueV3Data(idData, idScrubber), QueueProjectionError)

    const referenceScrubber = new SecretScrubber()
    const referenceData: QueueDataV3 = {
      items: [{ id: 'artifact', kind: 'artifact', artifact: artifact('preview') }],
    }
    referenceScrubber.register('secret://queue/reference', ARTIFACT_ID)
    assert.throws(() => projectQueueV3Data(referenceData, referenceScrubber), QueueProjectionError)
  })

  it('drops a marker that expands across the excerpt cut instead of splitting it', () => {
    const scrubber = new SecretScrubber()
    // The stored excerpt ends with a terminal proper prefix of the secret; a
    // late registration expands that prefix into a marker that crosses the cut.
    const excerpt = `${'m'.repeat(INPUT_EXCERPT_BYTES - 4)}${SECRET.slice(0, 4)}`
    assert.equal(Buffer.byteLength(excerpt, 'utf8'), INPUT_EXCERPT_BYTES)
    const data: QueueDataV3 = {
      items: [{ id: 'edge', kind: 'artifact', artifact: artifact(excerpt) }],
    }
    scrubber.register('secret://queue/edge', SECRET)
    const projected = projectQueueV3Data(data, scrubber)
    const item = projected.items[0]
    if (item?.kind !== 'artifact') throw new Error('expected artifact')
    assert.ok(item.artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
    assert.equal(Buffer.byteLength(item.artifact.excerpt, 'utf8'), item.artifact.excerptBytes)
    assert.equal(item.artifact.excerpt.includes(SECRET), false)
    assert.equal(item.artifact.excerpt.includes('⟦'), false)
  })
})
