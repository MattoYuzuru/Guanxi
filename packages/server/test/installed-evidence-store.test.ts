import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { openDb } from '../src/store/db.ts'
import {
  INSTALLED_EVIDENCE_SCHEMA_VERSION,
  InstalledEvidenceCacheStore,
  installedEvidenceCacheKey,
  safeInstalledEvidenceSchema,
} from '../src/store/installed-evidence.ts'

const IDENTITY = {
  provider: 'ollama' as const,
  normalizedModelReference: 'registry.example/team/model:q4',
  artifactDigest: 'sha256:artifact-a',
  runtimeVersion: '0.12.6',
}
const OBSERVED_AT = '2026-08-03T00:00:00.000Z'
const VALIDATED_AT = '2026-08-03T00:01:00.000Z'

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-evidence-store-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'guanxi.db')
  const db = openDb(path)
  test.after(() => db.close())
  return { db, path, store: new InstalledEvidenceCacheStore(db) }
}

describe('installed evidence cache store', () => {
  it('round-trips only normalized allowlisted evidence and classifies freshness', async (test) => {
    const { db, store } = await fixture(test)
    const record = store.write({
      identity: IDENTITY,
      evidence: {
        capabilities: ['completion', 'tools'],
        contextLength: 32_768,
        architecture: {
          name: 'qwen2', blockCount: 28, headCount: 28, headCountKv: 4,
          embeddingLength: 3_584,
        },
      },
      observedAt: OBSERVED_AT,
      fetchedAt: OBSERVED_AT,
      validatedAt: VALIDATED_AT,
      freshTtlMs: 1_000,
      staleWindowMs: 2_000,
    })
    assert.equal(store.read(IDENTITY, Date.parse(VALIDATED_AT) + 500).state, 'fresh')
    assert.equal(store.read(IDENTITY, Date.parse(VALIDATED_AT) + 1_500).state, 'stale')
    assert.equal(store.read(IDENTITY, Date.parse(VALIDATED_AT) + 3_500).state, 'expired')
    assert.equal(record.observedAt, OBSERVED_AT)

    const raw = db.prepare(
      'SELECT safe_evidence_json FROM installed_model_evidence_cache',
    ).get() as { safe_evidence_json: string }
    assert.deepEqual(JSON.parse(raw.safe_evidence_json), record.evidence)
    assert.doesNotMatch(
      raw.safe_evidence_json,
      /template|system|license|endpoint|credential|Users|workspace|reasoning|prompt|raw/iu,
    )
  })

  it('changes the exact key for reference, digest, runtime and schema', () => {
    const base = installedEvidenceCacheKey(IDENTITY)
    assert.notEqual(base, installedEvidenceCacheKey({ ...IDENTITY, normalizedModelReference: 'other:latest' }))
    assert.notEqual(base, installedEvidenceCacheKey({ ...IDENTITY, artifactDigest: 'sha256:artifact-b' }))
    assert.notEqual(base, installedEvidenceCacheKey({ ...IDENTITY, runtimeVersion: '0.13.0' }))
    assert.notEqual(base, installedEvidenceCacheKey({ ...IDENTITY, evidenceSchemaVersion: 2 as never }))
  })

  it('invalidates same-reference digest replacement atomically and survives reopen', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-evidence-store-reopen-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const db = openDb(path)
    const store = new InstalledEvidenceCacheStore(db)
    store.write({
      identity: IDENTITY,
      evidence: { capabilities: ['completion'] },
      observedAt: OBSERVED_AT,
      validatedAt: VALIDATED_AT,
    })
    const replacement = { ...IDENTITY, artifactDigest: 'sha256:artifact-b' }
    store.write({
      identity: replacement,
      evidence: { capabilities: ['tools'] },
      observedAt: '2026-08-03T00:02:00.000Z',
      validatedAt: '2026-08-03T00:03:00.000Z',
    })
    assert.equal(store.read(IDENTITY).state, 'miss')
    assert.equal(store.read(replacement, Date.parse('2026-08-03T00:04:00.000Z')).state, 'fresh')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      1,
    )
    db.close()
    const reopened = openDb(path)
    test.after(() => reopened.close())
    const read = new InstalledEvidenceCacheStore(reopened).read(
      replacement,
      Date.parse('2026-08-03T00:04:00.000Z'),
    )
    assert.equal(read.state, 'fresh')
    assert.equal(read.record.observedAt, '2026-08-03T00:02:00.000Z')
  })

  it('rejects non-allowlisted fields and incompatible rows without exposing content', async (test) => {
    const { db, store } = await fixture(test)
    assert.equal(safeInstalledEvidenceSchema.safeParse({ template: 'secret' }).success, false)
    assert.throws(() => store.write({
      identity: IDENTITY,
      evidence: { capabilities: ['completion'], system: 'secret' } as never,
      observedAt: OBSERVED_AT,
      validatedAt: VALIDATED_AT,
    }), /Unrecognized key/u)

    store.write({
      identity: IDENTITY,
      evidence: { capabilities: ['completion'] },
      observedAt: OBSERVED_AT,
      validatedAt: VALIDATED_AT,
    })
    db.prepare(
      'UPDATE installed_model_evidence_cache SET runtime_version = ?',
    ).run(`0.12.6-schema-${INSTALLED_EVIDENCE_SCHEMA_VERSION + 1}`)
    assert.throws(() => store.read(IDENTITY), /key does not match/u)
  })
})
