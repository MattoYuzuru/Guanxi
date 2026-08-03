import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { openDb } from '../src/store/db.ts'
import {
  CompletionProbeStore,
  completionProbeKey,
} from '../src/store/completion-probe.ts'

const IDENTITY = {
  provider: 'ollama' as const,
  normalizedModelReference: 'registry.example/team/model:q4',
  artifactDigest: 'sha256:artifact-a',
  runtimeVersion: '0.12.6',
  contextLength: 8_192,
}

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'alamo-probe-store-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'alamo.db')
  const db = openDb(path)
  test.after(() => db.close())
  return { db, store: new CompletionProbeStore(db) }
}

describe('completion probe evidence store', () => {
  it('round-trips only normalized exact outcome and timing', async (test) => {
    const { db, store } = await fixture(test)
    const written = store.write({
      identity: IDENTITY,
      outcome: {
        status: 'verified', reason: 'terminal_response',
        source: 'runtime_probe', confidence: 'verified',
      },
      observedAt: '2026-08-03T00:00:00.000Z',
      completedAt: '2026-08-03T00:00:01.000Z',
      durationMs: 1_000,
    })
    assert.deepEqual(store.read(IDENTITY), written)
    const raw = JSON.stringify(
      db.prepare('SELECT * FROM completion_probe_evidence').get(),
    )
    assert.doesNotMatch(
      raw,
      /response_text|generated|prompt|reasoning|template|system|body|endpoint|credential|Users|workspace|secret/iu,
    )
  })

  it('isolates reference, digest, runtime, context and probe version', () => {
    const base = completionProbeKey(IDENTITY)
    assert.notEqual(base, completionProbeKey({ ...IDENTITY, normalizedModelReference: 'other:latest' }))
    assert.notEqual(base, completionProbeKey({ ...IDENTITY, artifactDigest: 'sha256:artifact-b' }))
    assert.notEqual(base, completionProbeKey({ ...IDENTITY, runtimeVersion: '0.13.0' }))
    assert.notEqual(base, completionProbeKey({ ...IDENTITY, contextLength: 16_384 }))
    assert.throws(
      () => completionProbeKey({ ...IDENTITY, probeDefinitionVersion: 2 as never }),
      /incomplete or incompatible/u,
    )
  })

  it('replaces only the latest exact projection and fails closed on incompatible rows', async (test) => {
    const { db, store } = await fixture(test)
    store.write({
      identity: IDENTITY,
      outcome: {
        status: 'degraded', reason: 'provider_error',
        source: 'runtime_probe', confidence: 'degraded',
      },
      observedAt: '2026-08-03T00:00:00.000Z',
      completedAt: '2026-08-03T00:00:01.000Z',
      durationMs: 1_000,
    })
    const latest = store.write({
      identity: IDENTITY,
      outcome: {
        status: 'verified', reason: 'terminal_response',
        source: 'runtime_probe', confidence: 'verified',
      },
      observedAt: '2026-08-03T00:02:00.000Z',
      completedAt: '2026-08-03T00:02:02.000Z',
      durationMs: 2_000,
    })
    assert.equal(store.read(IDENTITY)?.observedAt, latest.observedAt)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM completion_probe_evidence').get() as {
        count: number
      }).count,
      1,
    )
    db.prepare('UPDATE completion_probe_evidence SET runtime_version = ?').run('changed')
    assert.throws(() => store.read(IDENTITY), /key does not match/u)
  })

  it('rejects inconsistent input and persisted timing', async (test) => {
    const { db, store } = await fixture(test)
    const input = {
      identity: IDENTITY,
      outcome: {
        status: 'degraded' as const,
        reason: 'provider_error' as const,
        source: 'runtime_probe' as const,
        confidence: 'degraded' as const,
      },
      observedAt: '2026-08-03T00:00:00.000Z',
      completedAt: '2026-08-03T00:00:01.000Z',
      durationMs: 999,
    }
    assert.throws(() => store.write(input), /timing is invalid/u)
    store.write({ ...input, durationMs: 1_000 })
    db.prepare('UPDATE completion_probe_evidence SET duration_ms = 999').run()
    assert.throws(() => store.read(IDENTITY), /invalid timing/u)
  })
})
