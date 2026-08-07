import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ModelCapabilityOverrideService } from '../src/models/capability-override.ts'
import { ModelService } from '../src/models/service.ts'
import type { OllamaClient } from '../src/ollama/client.ts'
import type { OllamaTagsEntry } from '../src/ollama/types.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { ModelCapabilityOverrideStore } from '../src/store/capability-override.ts'
import { openDb, type Db } from '../src/store/db.ts'

const AT = '2026-08-07T00:00:00.000Z'
const DIGEST = 'sha256:fixture'
const RUNTIME = '0.12.6'
const BODY = {
  capability: 'tools' as const,
  expectedDigest: DIGEST,
  expectedRuntimeVersion: RUNTIME,
}

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'Fixture Metal',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function tagsEntry(patch: Partial<OllamaTagsEntry> = {}): OllamaTagsEntry {
  return {
    name: 'fixture:latest',
    digest: DIGEST,
    size: 4_000,
    modified_at: AT,
    details: { family: 'fixture', parameter_size: '1B', quantization_level: 'Q4' },
    capabilities: ['completion'],
    ...patch,
  } as OllamaTagsEntry
}

async function database(test: { after: (fn: () => unknown) => void }, label: string): Promise<Db> {
  const root = await mkdtemp(join(tmpdir(), `alamo-override-service-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'alamo.db'))
  test.after(() => db.close())
  return db
}

/**
 * Every Ollama method except `/api/tags` and `/api/version` throws: a capability
 * assertion must never pull, load, unload, chat or probe.
 */
function forbiddenOllama(overrides: Partial<Record<string, unknown>>): OllamaClient {
  const forbid = (name: string) => () => {
    throw new Error(`${name} must not be called by a capability override`)
  }
  return {
    host: 'http://127.0.0.1:11434',
    tags: forbid('tags'),
    version: forbid('version'),
    show: forbid('show'),
    ps: forbid('ps'),
    pull: forbid('pull'),
    chatStream: forbid('chatStream'),
    warm: forbid('warm'),
    unload: forbid('unload'),
    deleteModel: forbid('deleteModel'),
    ...overrides,
  } as unknown as OllamaClient
}

function serviceWith(
  db: Db,
  options: {
    tags?: () => Promise<{ name: string; digest: string }[]>
    version?: () => Promise<string>
    now?: () => Date
    store?: ModelCapabilityOverrideStore
  } = {},
) {
  const calls = { tags: 0, version: 0 }
  const store = options.store ?? new ModelCapabilityOverrideStore(db)
  const models = () => ({
    installedArtifacts: async () => {
      calls.tags += 1
      return (options.tags ?? (async () => [{ name: 'fixture:latest', digest: DIGEST }]))()
    },
    runtimeVersion: async () => {
      calls.version += 1
      return (options.version ?? (async () => RUNTIME))()
    },
  })
  const service = new ModelCapabilityOverrideService({
    models: models as unknown as ModelCapabilityOverrideService['dependencies']['models'],
    store,
    ...(options.now ? { now: options.now } : {}),
  })
  return { service, store, calls }
}

function rowCount(db: Db): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM model_capability_user_overrides').get() as {
      count: number
    }
  ).count
}

describe('capability override server ownership', () => {
  it('applies once, is idempotent and clears only the exact assertion', async (test) => {
    const db = await database(test, 'happy')
    const { service } = serviceWith(db, { now: () => new Date(AT) })
    const signal = new AbortController().signal

    const applied = await service.apply('fixture:latest', BODY, signal)
    assert.equal(applied.state, 'applied')
    assert.equal(rowCount(db), 1)
    assert.equal(applied.overrides.length, 1)
    assert.equal(applied.overrides[0]!.capability, 'tools')
    assert.equal(applied.overrides[0]!.source, 'user_override')
    assert.equal(applied.overrides[0]!.state, 'overridden')
    assert.equal(applied.overrides[0]!.value, 'present')
    assert.deepEqual(applied.identity, {
      provider: 'ollama',
      normalizedModelReference: 'fixture:latest',
      artifactDigest: DIGEST,
      runtimeVersion: RUNTIME,
    })

    const repeated = await service.apply(
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(repeated.state, 'applied')
    assert.equal(rowCount(db), 1)
    assert.equal(repeated.overrides.length, 1)
    assert.equal(repeated.overrides[0]!.createdAt, applied.overrides[0]!.createdAt)
    assert.equal(repeated.overrides[0]!.updatedAt, applied.overrides[0]!.updatedAt)

    const cleared = await service.clear('fixture:latest', BODY, new AbortController().signal)
    assert.equal(cleared.state, 'cleared')
    assert.equal(rowCount(db), 0)
    assert.equal(cleared.overrides.length, 0)

    const again = await service.clear('fixture:latest', BODY, new AbortController().signal)
    assert.equal(again.state, 'absent')
    assert.equal(rowCount(db), 0)
  })

  it('never runs any model work for a mutation', async (test) => {
    const db = await database(test, 'boundary')
    const calibration = new CalibrationStore(db)
    let versionCalls = 0
    let tagsCalls = 0
    const client = forbiddenOllama({
      tags: async () => {
        tagsCalls += 1
        return { models: [tagsEntry()] }
      },
      version: async () => {
        versionCalls += 1
        return RUNTIME
      },
    })
    // The real ModelService boundary against a client that forbids model work.
    const real = new ModelCapabilityOverrideService({
      models: () => new ModelService(client, calibration, HARDWARE),
      store: new ModelCapabilityOverrideStore(db),
    })

    const applied = await real.apply('fixture:latest', BODY, new AbortController().signal)
    assert.equal(applied.state, 'applied')
    // Exactly the two read-only identity endpoints, nothing else.
    assert.equal(tagsCalls, 1)
    assert.equal(versionCalls, 1)

    const cleared = await real.clear('fixture:latest', BODY, new AbortController().signal)
    assert.equal(cleared.state, 'cleared')
    assert.equal(tagsCalls, 2)
    assert.equal(versionCalls, 2)
  })

  it('rejects an ambiguous, missing or digest-less installed identity', async (test) => {
    const db = await database(test, 'identity')
    const cases: Array<{
      label: string
      tags: () => Promise<{ name: string; digest: string }[]>
      reason: string
    }> = [
      {
        label: 'two rows for the same canonical reference',
        tags: async () => [
          { name: 'fixture:latest', digest: DIGEST },
          { name: 'Fixture:Latest', digest: 'sha256:other' },
        ],
        reason: 'installed_reference_ambiguous',
      },
      {
        label: 'model absent from the current sample',
        tags: async () => [{ name: 'other:latest', digest: DIGEST }],
        reason: 'model_not_installed',
      },
      {
        label: 'digest not reported',
        tags: async () => [{ name: 'fixture:latest', digest: '   ' }],
        reason: 'installed_digest_missing',
      },
    ]
    for (const testCase of cases) {
      const { service } = serviceWith(db, { tags: testCase.tags })
      const applied = await service.apply(
        'fixture:latest',
        BODY,
        new AbortController().signal,
      )
      assert.equal(applied.state, 'conflict', testCase.label)
      assert.equal(
        applied.state === 'conflict' ? applied.reason : null,
        testCase.reason,
        testCase.label,
      )
      assert.equal(applied.overrides.length, 0, testCase.label)
      assert.equal(rowCount(db), 0, testCase.label)

      const cleared = await service.clear(
        'fixture:latest',
        BODY,
        new AbortController().signal,
      )
      assert.equal(cleared.state, 'conflict', testCase.label)
      assert.equal(rowCount(db), 0, testCase.label)
    }
  })

  it('rejects an invalid reference before any provider access', async (test) => {
    const db = await database(test, 'reference')
    const { service, calls } = serviceWith(db)
    for (const name of ['', '  ', '/fixture', 'fixture/', 'fix ture', 'fixture\\latest']) {
      const outcome = await service.apply(name, BODY, new AbortController().signal)
      assert.equal(outcome.state, 'conflict', name)
      assert.equal(
        outcome.state === 'conflict' ? outcome.reason : null,
        'invalid_model_reference',
        name,
      )
    }
    assert.equal(calls.tags, 0)
    assert.equal(calls.version, 0)
    assert.equal(rowCount(db), 0)
  })

  it('never writes or removes when /api/tags or /api/version is unavailable', async (test) => {
    const db = await database(test, 'unavailable')
    const seeded = new ModelCapabilityOverrideStore(db)
    seeded.write({
      identity: {
        provider: 'ollama',
        normalizedModelReference: 'fixture:latest',
        artifactDigest: DIGEST,
        runtimeVersion: RUNTIME,
      },
      capability: 'tools',
      now: AT,
    })
    assert.equal(rowCount(db), 1)

    const failures: Array<[string, Parameters<typeof serviceWith>[1], string]> = [
      [
        'tags unavailable',
        { tags: async () => { throw new Error('http://127.0.0.1:11434 refused') } },
        'provider_unavailable',
      ],
      [
        'tags malformed',
        { tags: async () => { throw new TypeError('models is not iterable') } },
        'provider_unavailable',
      ],
      [
        'version unavailable',
        { version: async () => { throw new Error('/api/version refused') } },
        'runtime_version_unavailable',
      ],
      ['version blank', { version: async () => '   ' }, 'runtime_version_unavailable'],
    ]
    for (const [label, options, reason] of failures) {
      const { service } = serviceWith(db, options)
      for (const mutate of ['apply', 'clear'] as const) {
        const outcome = await service[mutate](
          'fixture:latest',
          { ...BODY, capability: 'vision' },
          new AbortController().signal,
        )
        assert.equal(outcome.state, 'conflict', `${label}/${mutate}`)
        assert.equal(
          outcome.state === 'conflict' ? outcome.reason : null,
          reason,
          `${label}/${mutate}`,
        )
      }
      // The seeded row is neither replaced nor removed by a failed observation.
      assert.equal(rowCount(db), 1, label)
    }
    assert.equal(seeded.list({
      provider: 'ollama',
      normalizedModelReference: 'fixture:latest',
      artifactDigest: DIGEST,
      runtimeVersion: RUNTIME,
    }).length, 1)
  })

  it('rejects a stale client expectation instead of writing by name', async (test) => {
    const db = await database(test, 'stale')
    // The identity drifted after the client rendered it: same name, new digest.
    const drifted = serviceWith(db, {
      tags: async () => [{ name: 'fixture:latest', digest: 'sha256:replaced' }],
    })
    const digestConflict = await drifted.service.apply(
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(digestConflict.state, 'conflict')
    assert.equal(
      digestConflict.state === 'conflict' ? digestConflict.reason : null,
      'digest_expectation_mismatch',
    )
    assert.equal(rowCount(db), 0)

    const restarted = serviceWith(db, { version: async () => '0.12.7' })
    const runtimeConflict = await restarted.service.apply(
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(runtimeConflict.state, 'conflict')
    assert.equal(
      runtimeConflict.state === 'conflict' ? runtimeConflict.reason : null,
      'runtime_expectation_mismatch',
    )
    assert.equal(rowCount(db), 0)

    // Clearing with a stale expectation must not remove the current row either.
    const { service } = serviceWith(db)
    await service.apply('fixture:latest', BODY, new AbortController().signal)
    assert.equal(rowCount(db), 1)
    const staleClear = await drifted.service.clear(
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(staleClear.state, 'conflict')
    assert.equal(rowCount(db), 1)
  })

  it('re-observes the exact identity at the mutation point', async (test) => {
    const db = await database(test, 'toctou')
    let sample = 0
    const { service } = serviceWith(db, {
      tags: async () => {
        sample += 1
        // The first observation matches the caller; the artifact is replaced before
        // the second mutation, and the stale expectation is then rejected.
        return [{ name: 'fixture:latest', digest: sample === 1 ? DIGEST : 'sha256:replaced' }]
      },
    })
    const first = await service.apply('fixture:latest', BODY, new AbortController().signal)
    assert.equal(first.state, 'applied')
    assert.equal(rowCount(db), 1)

    const second = await service.apply('fixture:latest', BODY, new AbortController().signal)
    assert.equal(second.state, 'conflict')
    assert.equal(
      second.state === 'conflict' ? second.reason : null,
      'digest_expectation_mismatch',
    )
    // The previous row survives as non-active data for its own exact identity.
    assert.equal(rowCount(db), 1)
    assert.equal(sample, 2)
  })

  it('reports a persistence failure as a conflict without a partial claim', async (test) => {
    const db = await database(test, 'persistence')
    const { service } = serviceWith(db, {
      store: {
        list: () => { throw new Error('SQLITE_IOERR /Users/private/.alamo/alamo.db') },
        write: () => { throw new Error('SQLITE_IOERR /Users/private/.alamo/alamo.db') },
        clear: () => { throw new Error('SQLITE_IOERR /Users/private/.alamo/alamo.db') },
      } as unknown as ModelCapabilityOverrideStore,
    })
    for (const mutate of ['apply', 'clear'] as const) {
      const outcome = await service[mutate](
        'fixture:latest',
        BODY,
        new AbortController().signal,
      )
      assert.equal(outcome.state, 'conflict')
      assert.equal(
        outcome.state === 'conflict' ? outcome.reason : null,
        'persistence_failed',
      )
      assert.equal(outcome.overrides.length, 0)
      // The safe outcome carries no path and no raw driver text.
      assert.doesNotMatch(JSON.stringify(outcome), /Users|private|alamo\.db|SQLITE/u)
    }
  })

  it('propagates caller cancellation without a partial write', async (test) => {
    const db = await database(test, 'abort')
    const before = new AbortController()
    before.abort('client-disconnected')
    const { service, calls } = serviceWith(db)
    await assert.rejects(() => service.apply('fixture:latest', BODY, before.signal))
    assert.equal(calls.tags, 0)
    assert.equal(rowCount(db), 0)

    const during = new AbortController()
    const mid = serviceWith(db, {
      tags: async () => {
        during.abort('client-disconnected')
        return [{ name: 'fixture:latest', digest: DIGEST }]
      },
    })
    await assert.rejects(() => mid.service.apply('fixture:latest', BODY, during.signal))
    assert.equal(rowCount(db), 0)
  })

  it('normalizes the caller reference to the same canonical identity', async (test) => {
    const db = await database(test, 'normalize')
    const { service } = serviceWith(db, {
      tags: async () => [{ name: 'fixture:latest', digest: DIGEST }],
    })
    const first = await service.apply('Fixture', BODY, new AbortController().signal)
    assert.equal(first.state, 'applied')
    assert.equal(first.state === 'applied' ? first.identity.normalizedModelReference : null,
      'fixture:latest')
    const second = await service.apply(
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(second.state, 'applied')
    // One canonical identity, so an implicit `:latest` cannot create a second row.
    assert.equal(rowCount(db), 1)
  })
})

describe('capability override descriptor projection', () => {
  async function descriptorFor(
    test: { after: (fn: () => unknown) => void },
    label: string,
    options: {
      entries: OllamaTagsEntry[]
      version?: () => Promise<string>
      seed?: Array<{ reference: string; digest: string; runtime: string; capability: 'tools' | 'vision' }>
      show?: () => Promise<Record<string, unknown>>
    },
  ) {
    const db = await database(test, label)
    const store = new ModelCapabilityOverrideStore(db)
    for (const seed of options.seed ?? []) {
      store.write({
        identity: {
          provider: 'ollama',
          normalizedModelReference: seed.reference,
          artifactDigest: seed.digest,
          runtimeVersion: seed.runtime,
        },
        capability: seed.capability,
        now: AT,
      })
    }
    const client = {
      host: 'http://127.0.0.1:11434',
      tags: async () => ({ models: options.entries }),
      version: options.version ?? (async () => RUNTIME),
      show: options.show ?? (async () => ({ capabilities: ['completion'] })),
      ps: async () => ({ models: [] }),
    } as unknown as OllamaClient
    const models = new ModelService(
      client,
      new CalibrationStore(db),
      HARDWARE,
      undefined,
      undefined,
      store,
    )
    return { db, models, store }
  }

  it('adds only exact compatible overrides and never rewrites provider evidence', async (test) => {
    const { models } = await descriptorFor(test, 'exact', {
      entries: [tagsEntry()],
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    const listed = await models.listLocal(8_192)
    assert.equal(listed.length, 1)
    const descriptor = listed[0]!.descriptor
    assert.equal(descriptor.overrides.length, 1)
    assert.equal(descriptor.overrides[0]!.capability, 'tools')
    assert.equal(descriptor.overrides[0]!.source, 'user_override')
    assert.equal(descriptor.overrides[0]!.state, 'overridden')
    // Provider evidence keeps its own declared state and declaration set.
    assert.equal(descriptor.capabilities.state, 'declared')
    assert.equal(descriptor.capabilities.declarations.length, 2)
    for (const declaration of descriptor.capabilities.declarations) {
      assert.equal(declaration.confidence, 'declared')
      assert.deepEqual(declaration.capabilities, ['completion'])
    }
    // The legacy capability projection is untouched: the assertion is not merged in.
    assert.deepEqual(listed[0]!.capabilities, ['completion'])

    const detail = await models.detail('fixture:latest', 8_192)
    assert.equal(detail?.descriptor.overrides.length, 1)
    assert.deepEqual(detail?.capabilities, ['completion'])
  })

  it('does not inherit an assertion across digest, runtime or model', async (test) => {
    const { models } = await descriptorFor(test, 'inheritance', {
      entries: [tagsEntry({ digest: 'sha256:replaced' })],
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    const replaced = await models.listLocal(8_192)
    assert.equal(replaced[0]!.descriptor.overrides.length, 0)

    const restarted = await descriptorFor(test, 'runtime-change', {
      entries: [tagsEntry()],
      version: async () => '0.12.7',
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    const afterRestart = await restarted.models.listLocal(8_192)
    assert.equal(afterRestart[0]!.descriptor.overrides.length, 0)
    assert.equal(afterRestart[0]!.descriptor.runtime.state, 'sourced')

    const neighbour = await descriptorFor(test, 'neighbour', {
      entries: [tagsEntry(), tagsEntry({ name: 'other:latest', digest: 'sha256:other' })],
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    const both = await neighbour.models.listLocal(8_192)
    assert.equal(both.length, 2)
    assert.equal(both.find((m) => m.name === 'fixture:latest')!.descriptor.overrides.length, 1)
    assert.equal(both.find((m) => m.name === 'other:latest')!.descriptor.overrides.length, 0)
  })

  it('projects nothing for an ambiguous reference or an unavailable runtime', async (test) => {
    const ambiguous = await descriptorFor(test, 'ambiguous', {
      entries: [tagsEntry(), tagsEntry({ name: 'Fixture:Latest', digest: 'sha256:second' })],
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    for (const model of await ambiguous.models.listLocal(8_192)) {
      assert.equal(model.descriptor.overrides.length, 0)
    }

    const noRuntime = await descriptorFor(test, 'no-runtime', {
      entries: [tagsEntry()],
      version: async () => { throw new Error('/api/version refused') },
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    const listed = await noRuntime.models.listLocal(8_192)
    assert.equal(listed[0]!.descriptor.overrides.length, 0)
    assert.equal(listed[0]!.descriptor.runtime.state, 'unknown')

    const noDigest = await descriptorFor(test, 'no-digest', {
      entries: [tagsEntry({ digest: '' })],
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    assert.equal((await noDigest.models.listLocal(8_192))[0]!.descriptor.overrides.length, 0)
  })

  it('keeps an assertion visible while the provider declaration stays degraded', async (test) => {
    const { models } = await descriptorFor(test, 'degraded', {
      entries: [tagsEntry()],
      // /api/show disagrees with /api/tags, so provider evidence is degraded.
      show: async () => ({ capabilities: ['tools'] }),
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'vision' },
      ],
    })
    const descriptor = (await models.listLocal(8_192))[0]!.descriptor
    assert.equal(descriptor.capabilities.state, 'degraded')
    assert.equal(descriptor.capabilities.reason, 'conflicting_provider_declarations')
    // The positive assertion does not repair or hide the provider conflict.
    assert.equal(descriptor.overrides.length, 1)
    assert.equal(descriptor.overrides[0]!.capability, 'vision')
  })

  it('does not mask a provider failure with a stored assertion', async (test) => {
    const { models } = await descriptorFor(test, 'provider-failure', {
      entries: [tagsEntry({ capabilities: undefined })],
      show: async () => { throw new Error('http://127.0.0.1:11434 refused') },
      seed: [
        { reference: 'fixture:latest', digest: DIGEST, runtime: RUNTIME, capability: 'tools' },
      ],
    })
    const descriptor = (await models.listLocal(8_192))[0]!.descriptor
    assert.equal(descriptor.capabilities.state, 'unknown')
    assert.equal(descriptor.capabilities.reason, 'provider_unavailable')
    assert.equal(descriptor.capabilities.declarations.length, 0)
    assert.equal(descriptor.overrides.length, 1)
  })

  it('leaves an absent assertion as unknown and never as unsupported', async (test) => {
    const { models } = await descriptorFor(test, 'absent', { entries: [tagsEntry()] })
    const descriptor = (await models.listLocal(8_192))[0]!.descriptor
    assert.equal(descriptor.overrides.length, 0)
    // No negative state exists anywhere in the projection.
    assert.doesNotMatch(JSON.stringify(descriptor), /unsupported|absent|not_present/u)
  })
})
