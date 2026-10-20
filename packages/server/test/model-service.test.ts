import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@guanxi/contract'
import {
  ModelContextLimitExceededError,
  ModelService,
  MODEL_SHOW_CACHE_MAX_ENTRIES,
  MODEL_SHOW_MAX_CONCURRENCY,
} from '../src/models/service.ts'
import { OllamaClient } from '../src/ollama/client.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 10,
  totalMemoryBytes: 32_000_000_000,
  usableMemoryBytes: 22_400_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

const MODEL_INFO = {
  'general.architecture': 'qwen2',
  'qwen2.block_count': 28,
  'qwen2.attention.head_count': 28,
  'qwen2.attention.head_count_kv': 4,
  'qwen2.embedding_length': 3_584,
}

interface ProviderState {
  installed: Array<{ name: string; digest: string; contextLength?: number | null }>
  running: Array<{ name: string; digest?: string; contextLength?: number }>
  version: string
  showCalls: string[]
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function client(state: ProviderState, host = 'http://127.0.0.1:11434'): OllamaClient {
  return new OllamaClient({
    host,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/version') return json({ version: state.version })
      if (path === '/api/tags') {
        return json({
          models: state.installed.map((model) => ({
            name: model.name,
            model: model.name,
            modified_at: '2026-08-03T12:00:00.000Z',
            size: 4_000,
            digest: model.digest,
            details: {
              family: 'fixture',
              parameter_size: '1B',
              quantization_level: 'Q4',
              ...(model.contextLength === null
                ? {}
                : { context_length: model.contextLength ?? 32_768 }),
            },
            capabilities: ['completion'],
          })),
        })
      }
      if (path === '/api/ps') {
        return json({
          models: state.running.map((model) => ({
            name: model.name,
            model: model.name,
            size: 5_000,
            digest: model.digest ?? 'sha256:running-default',
            details: { family: 'fixture' },
            size_vram: 4_500,
            ...(model.contextLength === undefined
              ? {}
              : { context_length: model.contextLength }),
          })),
        })
      }
      if (path === '/api/show') {
        state.showCalls.push(path)
        return json({ model_info: MODEL_INFO, capabilities: ['completion'] })
      }
      throw new Error(`unexpected path ${path}`)
    },
  })
}

function observationCount(db: ReturnType<typeof openDb>): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM model_calibration_observations').get() as {
      count: number
    }
  ).count
}

describe('digest-aware model facts and bounded show cache', () => {
  it('records only exact tags↔ps identity and never gives legacy or cross-digest measured credit', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-service-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    const calibration = new CalibrationStore(db)
    db.prepare(
      `INSERT INTO model_calibration (
         model, context_length, size_bytes, size_vram_bytes, measured_at
       ) VALUES ('fixture:latest', 8192, 999999, 999999, 'legacy')`,
    ).run()
    const state: ProviderState = {
      installed: [{ name: 'fixture:latest', digest: 'sha256:a' }],
      running: [{ name: 'FIXTURE', digest: 'sha256:a', contextLength: 8_192 }],
      version: '0.12.6',
      showCalls: [],
    }
    const service = new ModelService(client(state), calibration, HARDWARE)

    const exact = await service.listLocal(8_192)
    assert.equal(observationCount(db), 1)
    assert.equal(exact[0]?.fit.basis, 'measured')

    state.installed = [{ name: 'fixture:latest', digest: 'sha256:b' }]
    state.running = []
    const changedDigest = await service.listLocal(8_192)
    assert.equal(observationCount(db), 1)
    assert.equal(changedDigest[0]?.fit.basis, 'estimate')

    state.running = [{ name: 'fixture:latest', digest: 'sha256:stale', contextLength: 8_192 }]
    await service.listLocal(8_192)
    assert.equal(observationCount(db), 1)

    state.running = [
      { name: 'fixture:latest', digest: 'sha256:b', contextLength: 8_192 },
      { name: 'FIXTURE', digest: 'sha256:b', contextLength: 8_192 },
    ]
    await service.listLocal(8_192)
    assert.equal(observationCount(db), 1)

    state.running = [{ name: 'fixture:latest', digest: 'sha256:b' }]
    await service.listLocal(8_192)
    assert.equal(observationCount(db), 1)

    state.running = [{ name: 'fixture:latest', digest: 'sha256:b', contextLength: 32_768 }]
    await service.listLocal(32_768)
    assert.equal(observationCount(db), 2)
  })

  it('invalidates /api/show on same-name digest replacement and retains no old digest history', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-show-digest-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    const state: ProviderState = {
      installed: [{ name: 'fixture:latest', digest: 'sha256:a' }],
      running: [],
      version: '0.12.6',
      showCalls: [],
    }
    const service = new ModelService(client(state), new CalibrationStore(db), HARDWARE)

    await service.listLocal(8_192)
    await service.listLocal(8_192)
    assert.equal(state.showCalls.length, 1)
    state.installed[0] = { name: 'fixture:latest', digest: 'sha256:b' }
    await service.listLocal(8_192)
    assert.equal(state.showCalls.length, 2)
    state.installed[0] = { name: 'fixture:latest', digest: 'sha256:a' }
    await service.listLocal(8_192)
    assert.equal(state.showCalls.length, 3)
  })

  it('bounds retained /api/show entries and refuses local hardware identity for remote runtime', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-show-bound-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    const installed = Array.from({ length: MODEL_SHOW_CACHE_MAX_ENTRIES + 1 }, (_, index) => ({
      name: `fixture-${index}:latest`,
      digest: `sha256:${index}`,
    }))
    const state: ProviderState = {
      installed,
      running: [{ name: installed[0]!.name, digest: installed[0]!.digest, contextLength: 8_192 }],
      version: '0.12.6',
      showCalls: [],
    }
    const service = new ModelService(
      client(state, 'https://remote.example'),
      new CalibrationStore(db),
      HARDWARE,
    )

    await service.listLocal(8_192)
    assert.equal(state.showCalls.length, MODEL_SHOW_CACHE_MAX_ENTRIES + 1)
    assert.equal(observationCount(db), 0)
    await service.detail(installed[0]!.name, 8_192)
    // Process LRU evicts the first row, but the compatible fresh durable row
    // survives and avoids another /api/show request.
    assert.equal(state.showCalls.length, MODEL_SHOW_CACHE_MAX_ENTRIES + 1)
  })

  it('redacts failed /api/show payloads and falls back without caching them', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-show-redaction-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    let showCalls = 0
    const ollama = new OllamaClient({
      host: 'http://127.0.0.1:11434',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/version') return json({ version: '0.12.6' })
        if (path === '/api/tags') {
          return json({
            models: [
              {
                name: 'fixture:latest',
                model: 'fixture:latest',
                modified_at: '2026-08-03T12:00:00.000Z',
                size: 4_000,
                digest: 'sha256:a',
                details: { family: 'fixture', context_length: 8_192 },
              },
            ],
          })
        }
        if (path === '/api/ps') return json({ models: [] })
        if (path === '/api/show') {
          showCalls += 1
          return new Response(
            JSON.stringify({ error: 'secret-token /Users/private raw prompt' }),
            { status: 500 },
          )
        }
        throw new Error(`unexpected path ${path}`)
      },
    })
    const service = new ModelService(ollama, new CalibrationStore(db), HARDWARE)

    const first = await service.detail('fixture:latest', 8_192)
    const second = await service.detail('fixture:latest', 8_192)
    assert.equal(showCalls, 2)
    assert.doesNotMatch(JSON.stringify([first, second]), /secret-token|Users\/private|raw prompt/u)
  })

  it('propagates caller cancellation through the digest-aware /api/show wait', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-show-abort-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    let showStarted!: () => void
    const started = new Promise<void>((resolve) => {
      showStarted = resolve
    })
    let providerObservedAbort = false
    const ollama = new OllamaClient({
      host: 'http://127.0.0.1:11434',
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/version') return json({ version: '0.12.6' })
        if (path === '/api/tags') {
          return json({
            models: [
              {
                name: 'fixture:latest',
                model: 'fixture:latest',
                modified_at: '2026-08-03T12:00:00.000Z',
                size: 4_000,
                digest: 'sha256:a',
                details: { family: 'fixture', context_length: 8_192 },
              },
            ],
          })
        }
        if (path !== '/api/show') throw new Error(`unexpected path ${path}`)
        showStarted()
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const onAbort = () => {
            providerObservedAbort = true
            reject(new DOMException('Aborted', 'AbortError'))
          }
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    })
    const service = new ModelService(ollama, new CalibrationStore(db), HARDWARE)
    const controller = new AbortController()
    const pending = service.detail('fixture:latest', 8_192, controller.signal)
    await started
    controller.abort('caller-left')

    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(providerObservedAbort, true)
  })
})

describe('context capability evidence and profile projection', () => {
  it('adds the exact custom context and declared maximum without treating suggestions as a whitelist', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-context-profile-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    const state: ProviderState = {
      installed: [{ name: 'fixture:latest', digest: 'sha256:a', contextLength: 2_000_000 }],
      running: [],
      version: '0.12.6',
      showCalls: [],
    }
    const detail = await new ModelService(client(state), new CalibrationStore(db), HARDWARE)
      .detail('fixture:latest', 1_048_577)
    assert.equal(detail?.contextLimit.state, 'declared')
    assert.deepEqual(
      detail?.fitByContext.filter((fit) => [1_048_577, 2_000_000].includes(fit.contextLength)).map((fit) => fit.contextLength),
      [1_048_577, 2_000_000],
    )
    assert.equal(detail?.fit.contextLength, 1_048_577)
  })

  it('keeps absent/conflicting declarations unknown and rejects a sourced over-maximum request', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-context-limit-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    const state: ProviderState = {
      installed: [{ name: 'fixture:latest', digest: 'sha256:a', contextLength: null }],
      running: [], version: '0.12.6', showCalls: [],
    }
    const service = new ModelService(client(state), new CalibrationStore(db), HARDWARE)
    const unknown = await service.detail('fixture:latest', 1_048_577)
    assert.equal(unknown?.contextLimit.state, 'unknown')
    assert.equal(unknown?.fit.contextLength, 1_048_577)

    state.installed[0] = { name: 'fixture:latest', digest: 'sha256:b', contextLength: 32_768 }
    await assert.rejects(
      service.detail('fixture:latest', 32_769),
      (error) => error instanceof ModelContextLimitExceededError && error.limit.source === 'ollama_api_tags',
    )
  })

  it('uses a declared low maximum for an omitted profile context without rejecting the page', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-context-default-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    const state: ProviderState = {
      installed: [{ name: 'fixture:latest', digest: 'sha256:a', contextLength: 4_096 }],
      running: [], version: '0.12.6', showCalls: [],
    }
    const detail = await new ModelService(client(state), new CalibrationStore(db), HARDWARE)
      .detail('fixture:latest')
    assert.equal(detail?.contextLimit.state, 'declared')
    assert.equal(detail?.fit.contextLength, 4_096)
    assert.deepEqual(detail?.fitByContext.map((fit) => fit.contextLength), [4_096])
  })

  it('bounds simultaneous /api/show calls while preserving all installed rows', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-model-show-concurrency-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'guanxi.db'))
    test.after(() => db.close())
    let active = 0
    let peak = 0
    const installed = Array.from({ length: 12 }, (_, index) => ({
      name: `fixture-${index}:latest`, digest: `sha256:${index}`,
    }))
    const ollama = new OllamaClient({
      host: 'http://127.0.0.1:11434',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/version') return json({ version: '0.12.6' })
        if (path === '/api/ps') return json({ models: [] })
        if (path === '/api/tags') {
          return json({ models: installed.map((entry) => ({
            name: entry.name, model: entry.name, modified_at: '2026-08-03T00:00:00.000Z',
            size: 4_000, digest: entry.digest, details: { family: 'fixture' },
          })) })
        }
        if (path === '/api/show') {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setImmediate(resolve))
          active -= 1
          return json({ model_info: MODEL_INFO })
        }
        throw new Error(`unexpected path ${path}`)
      },
    })
    const models = await new ModelService(ollama, new CalibrationStore(db), HARDWARE)
      .listLocal(1_048_577)
    assert.equal(models.length, installed.length)
    assert.equal(peak, MODEL_SHOW_MAX_CONCURRENCY)
  })
})
