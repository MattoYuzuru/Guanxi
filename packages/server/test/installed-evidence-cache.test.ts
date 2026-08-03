import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import type { HardwareInfo, LocalModel } from '@alamo/contract'
import { ModelService, MODEL_SHOW_MAX_CONCURRENCY } from '../src/models/service.ts'
import { OllamaClient } from '../src/ollama/client.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'
import {
  InstalledEvidenceCacheStore,
  type InstalledEvidenceCacheIdentity,
} from '../src/store/installed-evidence.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
  totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
  freeDiskBytes: null,
}
const START = Date.parse('2026-08-03T00:00:00.000Z')

interface State {
  installed: Array<{ name: string; digest: string; tagsCapabilities?: unknown }>
  version: string
  offline: boolean
  showOffline: boolean
  malformed: boolean
  showCapabilities: unknown
  showCalls: number
  tagsCalls: number
  versionCalls: number
  activeShows: number
  peakShows: number
  showStarted?: () => void
  showHold?: Promise<void>
  changeAfterShow?: () => void
  providerObservedAbort: boolean
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

function client(state: State): OllamaClient {
  return new OllamaClient({
    host: 'http://127.0.0.1:11434',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (state.offline) throw new Error('private endpoint credential /Users/private')
      if (path === '/api/version') {
        state.versionCalls += 1
        return json({ version: state.version })
      }
      if (path === '/api/tags') {
        state.tagsCalls += 1
        return json({ models: state.installed.map((entry) => ({
          name: entry.name, model: entry.name, modified_at: '2026-08-03T00:00:00.000Z',
          size: 4_000, digest: entry.digest,
          details: { family: 'fixture', context_length: 32_768 },
          capabilities: entry.tagsCapabilities ?? ['completion'],
        })) })
      }
      if (path === '/api/ps') return json({ models: [] })
      if (path === '/api/show') {
        if (state.showOffline) throw new Error('private endpoint credential /Users/private')
        state.showCalls += 1
        state.activeShows += 1
        state.peakShows = Math.max(state.peakShows, state.activeShows)
        state.showStarted?.()
        try {
          if (state.showHold) {
            await Promise.race([
              state.showHold,
              new Promise<never>((_resolve, reject) => {
                const abort = () => {
                  state.providerObservedAbort = true
                  reject(new DOMException('Aborted', 'AbortError'))
                }
                if (init?.signal?.aborted) abort()
                else init?.signal?.addEventListener('abort', abort, { once: true })
              }),
            ])
          }
        } finally {
          state.activeShows -= 1
        }
        state.changeAfterShow?.()
        return json({
          capabilities: state.malformed ? { secret: true } : state.showCapabilities,
          model_info: {
            'general.architecture': 'fixture',
            'fixture.block_count': 4,
            'fixture.attention.head_count': 4,
            'fixture.embedding_length': 256,
            private_path: '/Users/private',
          },
          template: 'private template', system: 'private prompt', license: 'private license',
        })
      }
      throw new Error(`unexpected ${path}`)
    },
  })
}

function state(): State {
  return {
    installed: [{ name: 'fixture:latest', digest: 'sha256:a' }],
    version: '0.12.6', offline: false, showOffline: false, malformed: false,
    showCapabilities: ['completion'], showCalls: 0, tagsCalls: 0, versionCalls: 0,
    activeShows: 0, peakShows: 0, providerObservedAbort: false,
  }
}

async function storage(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'alamo-installed-cache-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'alamo.db')
  const db = openDb(path)
  return { db, path }
}

function service(
  state: State,
  db: ReturnType<typeof openDb>,
  now: () => number,
): ModelService {
  return new ModelService(
    client(state),
    new CalibrationStore(db),
    HARDWARE,
    new InstalledEvidenceCacheStore(db),
    now,
  )
}

function capabilityTime(model: LocalModel): string {
  return model.descriptor.capabilities.declarations
    .find((entry) => entry.source === 'ollama_api_show')!.observedAt
}

describe('persistent installed evidence collection', () => {
  it('restarts from a fresh row without /api/show or timestamp refresh', async (test) => {
    const provider = state()
    const { db, path } = await storage(test)
    const first = await service(provider, db, () => START).listLocal(8_192)
    assert.equal(provider.showCalls, 1)
    assert.equal(first[0]!.descriptor.freshness.state, 'fresh')
    const observedAt = capabilityTime(first[0]!)
    db.close()

    const reopened = openDb(path)
    test.after(() => reopened.close())
    const second = await service(provider, reopened, () => START + 60_000).listLocal(8_192)
    assert.equal(provider.showCalls, 1)
    assert.equal(second[0]!.descriptor.freshness.state, 'fresh')
    assert.equal(second[0]!.descriptor.freshness.source, 'persistent_cache')
    assert.equal(capabilityTime(second[0]!), observedAt)
  })

  it('refreshes one expired exact key for overlapping list/detail callers', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    let now = START
    const models = service(provider, db, () => now)
    await models.listLocal(8_192)
    now += 16 * 60_000
    let release!: () => void
    provider.showHold = new Promise<void>((resolve) => { release = resolve })
    const list = models.listLocal(8_192)
    const detail = models.detail('fixture:latest', 8_192)
    while (provider.showCalls < 2) await new Promise((resolve) => setImmediate(resolve))
    release()
    await Promise.all([list, detail])
    assert.equal(provider.showCalls, 2)
    assert.equal(provider.peakShows, 1)
  })

  it('bounds all exact workers at four and shares duplicate keys', async (test) => {
    const provider = state()
    provider.installed = Array.from({ length: 9 }, (_, index) => ({
      name: `fixture-${index}:latest`, digest: `sha256:${index}`,
    }))
    const { db } = await storage(test)
    let release!: () => void
    provider.showHold = new Promise<void>((resolve) => { release = resolve })
    const models = service(provider, db, () => START)
    const first = models.listLocal(8_192)
    const second = models.listLocal(8_192)
    while (provider.showCalls < MODEL_SHOW_MAX_CONCURRENCY) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(provider.peakShows, MODEL_SHOW_MAX_CONCURRENCY)
    release()
    await Promise.all([first, second])
    assert.equal(provider.showCalls, 9)
  })

  it('refuses a write when before/after identity changes and exposes degraded unknown', async (test) => {
    const provider = state()
    provider.changeAfterShow = () => {
      provider.installed[0] = { name: 'fixture:latest', digest: 'sha256:b' }
      provider.changeAfterShow = undefined
    }
    const { db } = await storage(test)
    const rows = await service(provider, db, () => START).listLocal(8_192)
    assert.equal(rows[0]!.descriptor.capabilities.state, 'degraded')
    assert.equal(rows[0]!.descriptor.capabilities.reason, 'artifact_identity_changed')
    assert.equal(rows[0]!.descriptor.freshness.state, 'unknown')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      0,
    )
  })

  it('uses explicit stale/offline fallback only inside the stale window', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    let now = START
    const models = service(provider, db, () => now)
    await models.listLocal(8_192)
    provider.showOffline = true
    now += 16 * 60_000
    const stale = await models.detail('fixture:latest', 8_192)
    assert.equal(stale?.descriptor.freshness.state, 'stale')
    assert.equal(stale?.descriptor.freshness.offline, true)

    now += 8 * 24 * 60 * 60_000
    const expired = await models.detail('fixture:latest', 8_192)
    assert.equal(expired?.descriptor.installation.state, 'installed')
    assert.equal(expired?.descriptor.freshness.state, 'unknown')
    assert.equal(expired?.descriptor.capabilities.state, 'degraded')
    assert.deepEqual(
      expired?.descriptor.capabilities.declarations.map((entry) => entry.source),
      ['ollama_api_tags'],
    )
  })

  it('does not hide malformed current provider data behind an older row', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    let now = START
    const models = service(provider, db, () => now)
    await models.detail('fixture:latest', 8_192)
    now += 16 * 60_000
    provider.malformed = true
    const result = await models.detail('fixture:latest', 8_192)
    assert.equal(result?.descriptor.freshness.state, 'unknown')
    assert.equal(result?.descriptor.capabilities.reason, 'provider_malformed')
  })

  it('does not hide conflicting current declarations behind an older row', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    let now = START
    const models = service(provider, db, () => now)
    await models.detail('fixture:latest', 8_192)
    now += 16 * 60_000
    provider.installed[0] = {
      name: 'fixture:latest', digest: 'sha256:a', tagsCapabilities: ['tools'],
    }
    provider.showCapabilities = ['completion']
    const result = await models.detail('fixture:latest', 8_192)
    assert.equal(result?.descriptor.capabilities.state, 'degraded')
    assert.equal(result?.descriptor.capabilities.reason, 'conflicting_provider_declarations')
    assert.deepEqual(
      result?.descriptor.capabilities.declarations.map((entry) => entry.capabilities),
      [['tools'], ['completion']],
    )
  })

  it('cancels only the last owned waiter and never deletes a valid row', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    let now = START
    const models = service(provider, db, () => now)
    await models.detail('fixture:latest', 8_192)
    now += 16 * 60_000
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => { started = resolve })
    provider.showStarted = started
    provider.showHold = new Promise<void>(() => {})
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = models.detail('fixture:latest', 8_192, firstController.signal)
    const second = models.detail('fixture:latest', 8_192, secondController.signal)
    await providerStarted
    firstController.abort('first-left')
    await assert.rejects(first, { name: 'AbortError' })
    assert.equal(provider.providerObservedAbort, false)
    secondController.abort('last-left')
    await assert.rejects(second, { name: 'AbortError' })
    while (!provider.providerObservedAbort) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      1,
    )
  })

  it('never persists raw provider body or private fields', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    await service(provider, db, () => START).detail('fixture:latest', 8_192)
    const raw = db.prepare(
      'SELECT safe_evidence_json FROM installed_model_evidence_cache',
    ).get() as { safe_evidence_json: string }
    assert.doesNotMatch(
      raw.safe_evidence_json,
      /private|template|system|license|endpoint|credential|Users|workspace|reasoning|prompt/iu,
    )
  })

  it('exact digest/runtime/schema identity never lets A serve B', async (test) => {
    const provider = state()
    const { db } = await storage(test)
    let now = START
    const models = service(provider, db, () => now)
    await models.detail('fixture:latest', 8_192)
    provider.installed[0] = { name: 'fixture:latest', digest: 'sha256:b' }
    provider.showCapabilities = ['tools']
    now += 1_000
    const digestB = await models.detail('fixture:latest', 8_192)
    assert.equal(provider.showCalls, 2)
    assert.deepEqual(digestB?.descriptor.capabilities.declarations.at(-1)?.capabilities, ['tools'])

    provider.version = '0.13.0'
    provider.showCapabilities = ['thinking']
    now += 1_000
    const runtimeB = await models.detail('fixture:latest', 8_192)
    assert.equal(provider.showCalls, 3)
    assert.deepEqual(runtimeB?.descriptor.capabilities.declarations.at(-1)?.capabilities, ['thinking'])

    const identity: InstalledEvidenceCacheIdentity = {
      provider: 'ollama', normalizedModelReference: 'fixture:latest',
      artifactDigest: 'sha256:b', runtimeVersion: '0.13.0', evidenceSchemaVersion: 2 as never,
    }
    assert.equal(new InstalledEvidenceCacheStore(db).read(identity).state, 'miss')
  })
})
