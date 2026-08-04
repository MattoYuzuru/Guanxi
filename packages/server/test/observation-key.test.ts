import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { modelObservationKeySchema, type HardwareInfo, type RunningModel } from '@alamo/contract'
import {
  buildCompleteObservationKey,
  normalizeOllamaModelReference,
  resolveRuntimeObservationKey,
} from '../src/runtime/observation-key.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'private fixture string is excluded',
  cpuCores: 10,
  totalMemoryBytes: 32_000_000_000,
  usableMemoryBytes: 22_400_000_000,
  accelerator: 'metal',
  acceleratorName: 'private fixture device is excluded',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function complete(overrides: Partial<Parameters<typeof buildCompleteObservationKey>[0]> = {}) {
  return buildCompleteObservationKey({
    normalizedModelReference: 'registry.example/team/model:8b',
    artifactDigest: 'sha256:artifact-a',
    contextLength: 8_192,
    runtimeVersion: '0.12.6',
    runtimeHost: 'http://127.0.0.1:11434',
    hardware: HARDWARE,
    ...overrides,
  })
}

function running(overrides: Partial<RunningModel> = {}): RunningModel {
  return {
    name: 'registry.example/team/model:8b',
    digest: 'sha256:artifact-a',
    sizeBytes: 5_000,
    sizeVramBytes: 4_500,
    gpuPercent: null,
    processorLabel: null,
    contextLength: 8_192,
    expiresAt: null,
    source: 'ollama_api_ps',
    observedAt: '2026-08-03T12:00:00.000Z',
    ...overrides,
  }
}

describe('versioned model observation key', () => {
  it('round-trips one complete key and changes for every identity component', () => {
    const canonical = complete()
    const repeated = complete()
    assert.equal(canonical.state, 'complete')
    assert.deepEqual(modelObservationKeySchema.parse(canonical), canonical)
    assert.equal(
      repeated.state === 'complete' ? repeated.id : null,
      canonical.state === 'complete' ? canonical.id : null,
    )

    const changed = [
      complete({ normalizedModelReference: 'other.registry/team/model:8b' }),
      complete({ artifactDigest: 'sha256:artifact-b' }),
      complete({ contextLength: 32_768 }),
      complete({ runtimeVersion: '0.12.7' }),
      complete({ hardware: { ...HARDWARE, totalMemoryBytes: 64_000_000_000 } }),
    ]
    assert.equal(canonical.state, 'complete')
    for (const candidate of changed) {
      assert.equal(candidate.state, 'complete')
      if (canonical.state === 'complete' && candidate.state === 'complete') {
        assert.notEqual(candidate.id, canonical.id)
      }
    }
    if (canonical.state === 'complete') {
      assert.doesNotMatch(JSON.stringify(canonical), /private fixture/u)
    }
  })

  it('normalizes only implicit latest syntax and keeps registry, tag, and digest distinct', () => {
    assert.equal(normalizeOllamaModelReference(' Model '), 'model:latest')
    assert.equal(normalizeOllamaModelReference('registry-a/team/model:8b'), 'registry-a/team/model:8b')
    assert.equal(normalizeOllamaModelReference('registry-b/team/model:8b'), 'registry-b/team/model:8b')
    assert.equal(normalizeOllamaModelReference('team/model:8b'), 'team/model:8b')
    assert.equal(normalizeOllamaModelReference('team/model:32b'), 'team/model:32b')
    assert.equal(normalizeOllamaModelReference('team/model@sha256:abc'), 'team/model@sha256:abc')
    assert.equal(normalizeOllamaModelReference('team/model@sha256:def'), 'team/model@sha256:def')
    assert.equal(normalizeOllamaModelReference('../family/model'), null)
  })

  it('returns typed unavailable reasons without fabricating missing components', () => {
    const row = running()
    const base = {
      running: row,
      runningRows: [row],
      installed: [{ name: row.name, digest: row.digest! }],
      runtimeVersion: '0.12.6',
      runtimeHost: 'http://127.0.0.1:11434',
      hardware: HARDWARE,
    }
    const cases = [
      resolveRuntimeObservationKey({ ...base, runningRows: [row, { ...row }] }),
      resolveRuntimeObservationKey({ ...base, running: { ...row, digest: null } }),
      resolveRuntimeObservationKey({ ...base, running: { ...row, contextLength: null } }),
      resolveRuntimeObservationKey({ ...base, installed: null }),
      resolveRuntimeObservationKey({ ...base, installed: [] }),
      resolveRuntimeObservationKey({ ...base, installed: [...base.installed, ...base.installed] }),
      resolveRuntimeObservationKey({
        ...base,
        installed: [{ name: row.name, digest: 'sha256:changed' }],
      }),
      resolveRuntimeObservationKey({ ...base, runtimeVersion: null }),
      resolveRuntimeObservationKey({ ...base, runtimeHost: 'https://remote.example' }),
      resolveRuntimeObservationKey({
        ...base,
        hardware: {
          ...HARDWARE,
          platform: 'linux',
          arch: 'x64',
          accelerator: 'cuda',
          acceleratorName: 'private NVIDIA fixture is excluded',
          unifiedMemory: false,
        },
      }),
    ]
    assert.deepEqual(
      cases.map((key) => (key.state === 'unavailable' ? key.reason : 'complete')),
      [
        'runtime_reference_ambiguous',
        'runtime_digest_missing',
        'runtime_context_missing',
        'installed_source_unavailable',
        'installed_reference_missing',
        'installed_reference_ambiguous',
        'installed_digest_mismatch',
        'runtime_version_unavailable',
        'hardware_fingerprint_unavailable',
        'hardware_fingerprint_unavailable',
      ],
    )
    for (const key of cases) {
      assert.deepEqual(modelObservationKeySchema.parse(key), key)
      assert.equal('components' in key, false)
    }
    assert.throws(
      () => modelObservationKeySchema.parse({ state: 'complete', version: 2, id: 'model' }),
      /Invalid/u,
    )
  })
})

describe('exact observation calibration store', () => {
  it('preserves legacy rows without measured credit and isolates digest/context/runtime/hardware', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-observation-store-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'alamo.db'))
    test.after(() => db.close())
    const store = new CalibrationStore(db)
    db.prepare(
      `INSERT INTO model_calibration (
         model, context_length, size_bytes, size_vram_bytes, measured_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run('registry.example/team/model:8b', 8_192, 999_999, 999_999, 'legacy')

    const key8k = complete()
    const key32k = complete({ contextLength: 32_768 })
    const otherDigest = complete({ artifactDigest: 'sha256:artifact-b' })
    const otherRuntime = complete({ runtimeVersion: '0.12.7' })
    const otherHardware = complete({
      hardware: { ...HARDWARE, totalMemoryBytes: 64_000_000_000 },
    })
    assert.deepEqual(store.samples(key8k), [])
    assert.equal(store.record({ state: 'unavailable', version: 1, reason: 'legacy_snapshot' }, 1, 1), false)

    assert.equal(store.record(key8k, 5_000, 4_500, '2026-08-03T12:00:00.000Z'), true)
    assert.equal(store.record(key32k, 6_000, 5_500, '2026-08-03T12:01:00.000Z'), true)
    assert.equal(store.record(otherDigest, 7_000, 6_500), true)
    assert.equal(store.record(otherRuntime, 8_000, 7_500), true)
    assert.equal(store.record(otherHardware, 9_000, 8_500), true)

    assert.deepEqual(store.samples(key8k), [
      { contextLength: 8_192, sizeBytes: 5_000 },
      { contextLength: 32_768, sizeBytes: 6_000 },
    ])
    assert.deepEqual(store.samples(otherDigest), [{ contextLength: 8_192, sizeBytes: 7_000 }])
    assert.deepEqual(store.samples(otherRuntime), [{ contextLength: 8_192, sizeBytes: 8_000 }])
    assert.deepEqual(store.samples(otherHardware), [{ contextLength: 8_192, sizeBytes: 9_000 }])

    assert.equal(store.record(key8k, 5_100, 4_600, '2026-08-03T12:02:00.000Z'), true)
    assert.deepEqual(store.exact(key8k), { contextLength: 8_192, sizeBytes: 5_100 })
    assert.equal(
      (
        db.prepare('SELECT COUNT(*) AS count FROM model_calibration_observations').get() as {
          count: number
        }
      ).count,
      5,
    )
  })
})
