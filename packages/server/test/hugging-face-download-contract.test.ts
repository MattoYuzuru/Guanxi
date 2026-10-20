import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  huggingFaceDownloadBody,
  huggingFaceDownloadProvenanceSchema,
  huggingFaceDownloadStreamEventSchema,
} from '@guanxi/contract'

const BODY = {
  identity: {
    provider: 'hugging_face', owner: 'Owner', name: 'Model',
    repositoryId: 'Owner/Model', comparisonKey: 'owner/model',
  },
  revision: {
    state: 'exact_commit', commit: 'a'.repeat(40), source: 'hugging_face_api_model',
  },
  filePath: 'quant/model.gguf',
  contextLength: 8_192,
} as const

const PROVENANCE = {
  version: 1,
  identity: BODY.identity,
  revision: BODY.revision,
  remotePath: BODY.filePath,
  license: {
    state: 'declared', value: 'apache-2.0',
    source: 'hugging_face_model_tags', confidence: 'declared',
  },
  gated: { state: 'open', mode: null },
  sourceUrlPolicy: 'hugging_face_exact_revision_explicit_hosts_v1',
  expectedSizeBytes: 8,
  observedSizeBytes: 8,
  checksum: {
    algorithm: 'sha256', expectedDigest: 'b'.repeat(64),
    observedDigest: 'b'.repeat(64), relation: 'matched_provider_claim',
  },
  format: { kind: 'gguf', magic: 'GGUF', version: 3, inspection: 'bounded_header_only' },
  artifact: { state: 'managed_staging', id: '11111111-1111-4111-8111-111111111111' },
  observedAt: '2026-08-09T12:00:00.000Z',
  terminalState: 'completed',
} as const

describe('P2-L exact GGUF download contract', () => {
  it('reuses the strict exact-selection tuple and rejects unknown or mutable targets', () => {
    assert.deepEqual(huggingFaceDownloadBody.parse(BODY), BODY)
    assert.equal(huggingFaceDownloadBody.safeParse({ ...BODY, extra: true }).success, false)
    assert.equal(huggingFaceDownloadBody.safeParse({
      ...BODY, revision: { ...BODY.revision, commit: 'main' },
    }).success, false)
    assert.equal(huggingFaceDownloadBody.safeParse({ ...BODY, filePath: '../x.gguf' }).success, false)
  })

  it('accepts only coherent completed provenance', () => {
    assert.deepEqual(huggingFaceDownloadProvenanceSchema.parse(PROVENANCE), PROVENANCE)
    for (const invalid of [
      { ...PROVENANCE, observedSizeBytes: 7 },
      {
        ...PROVENANCE,
        checksum: { ...PROVENANCE.checksum, observedDigest: 'c'.repeat(64) },
      },
      {
        ...PROVENANCE,
        checksum: {
          ...PROVENANCE.checksum, expectedDigest: null,
          relation: 'matched_provider_claim',
        },
      },
      { ...PROVENANCE, terminalState: 'installed' },
    ]) {
      assert.equal(huggingFaceDownloadProvenanceSchema.safeParse(invalid).success, false)
    }
  })

  it('keeps unknown progress total explicit and refuses simulated precision', () => {
    const unknown = {
      type: 'progress', seq: 1,
      data: { version: 1, state: 'downloading', completedBytes: 42, totalBytes: null },
    }
    assert.deepEqual(huggingFaceDownloadStreamEventSchema.parse(unknown), unknown)
    assert.equal(huggingFaceDownloadStreamEventSchema.safeParse({
      ...unknown,
      data: { ...unknown.data, totalBytes: 10 },
    }).success, false)
    assert.equal(huggingFaceDownloadStreamEventSchema.safeParse({
      ...unknown,
      data: { ...unknown.data, percent: 99 },
    }).success, false)
  })

  it('publishes every terminal state as a strict typed frame', () => {
    const terminals = [
      { type: 'completed', data: { version: 1, state: 'completed', provenance: PROVENANCE } },
      { type: 'cancelled', data: { version: 1, state: 'cancelled', reason: 'user_requested' } },
      { type: 'refused', data: { version: 1, state: 'refused', reason: 'redirect_not_allowed' } },
      { type: 'failed', data: { version: 1, state: 'failed', reason: 'checksum_mismatch' } },
    ]
    for (const [seq, terminal] of terminals.entries()) {
      const frame = { ...terminal, seq }
      assert.deepEqual(huggingFaceDownloadStreamEventSchema.parse(frame), frame)
      assert.equal(huggingFaceDownloadStreamEventSchema.safeParse({
        ...frame, data: { ...frame.data, secretPath: '/private/staging/file' },
      }).success, false)
    }
  })
})
