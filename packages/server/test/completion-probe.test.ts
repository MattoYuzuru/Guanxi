import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  CompletionProbeBody,
  LocalModel,
} from '@alamo/contract'
import {
  OllamaError,
  OllamaTimeoutError,
} from '../src/ollama/client.ts'
import {
  COMPLETION_PROBE_KEEP_ALIVE,
  COMPLETION_PROBE_CONNECT_TIMEOUT_MS,
  COMPLETION_PROBE_LOAD_TIMEOUT_MS,
  COMPLETION_PROBE_MAX_RESPONSE_BYTES,
  COMPLETION_PROBE_NUM_PREDICT,
  COMPLETION_PROBE_RESPONSE_TIMEOUT_MS,
  CompletionProbeService,
  type CompletionProbeDependencies,
} from '../src/runtime/completion-probe.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import type {
  CompletionProbeIdentity,
  CompletionProbeRecord,
} from '../src/store/completion-probe.ts'

const AT = '2026-08-03T00:00:00.000Z'
const BODY: CompletionProbeBody = {
  capability: 'completion', expectedDigest: 'sha256:fixture',
  contextLength: 8_192, force: false,
}

function model(overrides: Partial<LocalModel> = {}): LocalModel {
  return {
    name: 'fixture:latest', digest: 'sha256:fixture', sizeBytes: 4_000,
    modifiedAt: AT, family: 'fixture', parameterSize: '1B', quantization: 'Q4',
    contextLength: 32_768,
    contextLimit: {
      state: 'declared', value: 32_768, source: 'ollama_api_tags',
      observedAt: AT, confidence: 'declared',
    },
    capabilities: ['completion'],
    descriptor: {
      reference: { state: 'canonical', provider: 'ollama', original: 'fixture:latest', normalized: 'fixture:latest' },
      artifact: { state: 'exact_digest', digest: 'sha256:fixture' },
      installation: { state: 'installed', source: 'ollama_api_tags', observedAt: AT, confidence: 'observed' },
      capabilities: { state: 'declared', reason: null, observedAt: AT, declarations: [] },
      freshness: { state: 'unknown', source: 'none', observedAt: null, reason: 'identity_unavailable', offline: false },
      runtime: {
        state: 'sourced', runtime: 'ollama', version: '0.12.6',
        source: 'ollama_api_version', observedAt: AT, confidence: 'observed',
      },
      overrides: [],
    },
    isCloud: false,
    fit: {
      level: 'green', summary: 'fixture', contextLength: 8_192,
      modelBytes: 4_000, kvCacheBytes: 1_000, requiredBytes: 5_000,
      usableBytes: 10_000, utilization: 0.5, basis: 'estimate', measured: null,
    },
    ...overrides,
  }
}

function terminal(content = 'OK') {
  return async function* () {
    yield { model: 'fixture:latest', created_at: AT, message: { role: 'assistant' as const, content }, done: true }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class MemoryStore {
  records = new Map<string, CompletionProbeRecord>()
  failWrite = false

  read(identity: CompletionProbeIdentity) {
    return this.records.get(JSON.stringify(identity)) ?? null
  }

  write(input: Omit<CompletionProbeRecord, 'probeKey' | 'identity'> & { identity: CompletionProbeIdentity }) {
    if (this.failWrite) throw new Error('/Users/private raw response secret')
    const record: CompletionProbeRecord = {
      ...input,
      probeKey: `sha256:${'a'.repeat(64)}`,
      identity: { ...input.identity, keyVersion: 1, probeDefinitionVersion: 1 },
    }
    this.records.set(JSON.stringify(input.identity), record)
    return record
  }
}

function dependencies(options: {
  governor?: ResourceGovernor
  models?: LocalModel[]
  installed?: Array<{ name: string; digest: string }>[]
  versions?: string[]
  stream?: CompletionProbeDependencies['ollama'] extends () => infer Client
    ? Client extends { chatStream: infer Stream } ? Stream : never : never
  store?: MemoryStore
  deadlineMs?: number
} = {}): CompletionProbeDependencies & { store: MemoryStore } {
  const installed = options.installed ?? [
    [{ name: 'fixture:latest', digest: 'sha256:fixture' }],
    [{ name: 'fixture:latest', digest: 'sha256:fixture' }],
  ]
  const versions = options.versions ?? ['0.12.6', '0.12.6']
  let identityCall = 0
  const store = options.store ?? new MemoryStore()
  return {
    governor: options.governor ?? new ResourceGovernor(),
    models: () => ({
      listLocal: async () => options.models ?? [model()],
      installedArtifacts: async () => installed[Math.min(identityCall, installed.length - 1)]!,
      runtimeVersion: async () => versions[Math.min(identityCall++, versions.length - 1)]!,
    }),
    ollama: () => ({ chatStream: options.stream ?? terminal() }),
    store,
    now: () => new Date(AT),
    deadlineMs: options.deadlineMs,
  }
}

describe('explicit controlled completion probe', () => {
  it('sends one exact fixed bounded provider request and persists verified only after terminal response', async () => {
    const calls: unknown[] = []
    const deps = dependencies({
      stream: ((request: unknown, _signal: AbortSignal, timeoutPolicy: unknown) => {
        calls.push({ request, timeoutPolicy })
        return terminal()()
      }) as never,
    })
    const result = await new CompletionProbeService(deps).execute(
      'fixture:latest', BODY, new AbortController().signal,
    )
    assert.equal(result.status, 'verified')
    assert.equal(result.historical, false)
    assert.equal(deps.governor.snapshot().activeLease, null)
    assert.equal(deps.store.records.size, 1)
    assert.deepEqual(calls, [{
      request: {
        model: 'fixture:latest',
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        keep_alive: COMPLETION_PROBE_KEEP_ALIVE,
        options: {
          num_ctx: 8_192, num_predict: COMPLETION_PROBE_NUM_PREDICT,
          temperature: 0, seed: 0,
        },
      },
      timeoutPolicy: {
        connectTimeoutMs: COMPLETION_PROBE_CONNECT_TIMEOUT_MS,
        loadTimeoutMs: COMPLETION_PROBE_LOAD_TIMEOUT_MS,
        streamIdleTimeoutMs: COMPLETION_PROBE_RESPONSE_TIMEOUT_MS,
      },
    }])
    assert.doesNotMatch(JSON.stringify([...deps.store.records.values()]), /Reply with|generated|message|response_text/u)
  })

  it('reuses the original exact observation as historical unless force reruns', async () => {
    let calls = 0
    const deps = dependencies({
      stream: (() => { calls += 1; return terminal()() }) as never,
    })
    const service = new CompletionProbeService(deps)
    const first = await service.execute('fixture:latest', BODY, new AbortController().signal)
    const cached = await service.execute('fixture:latest', BODY, new AbortController().signal)
    const forced = await service.execute('fixture:latest', { ...BODY, force: true }, new AbortController().signal)
    assert.equal(first.historical, false)
    assert.equal(cached.historical, true)
    assert.equal(cached.observedAt, first.observedAt)
    assert.equal(forced.historical, false)
    assert.equal(calls, 2)
  })

  it('skips ambiguous/missing/changed expected identity and never calls provider', async () => {
    for (const fixture of [
      dependencies({ installed: [[], []] }),
      dependencies({ installed: [[
        { name: 'fixture:latest', digest: 'sha256:a' },
        { name: 'fixture', digest: 'sha256:b' },
      ]] }),
    ]) {
      let calls = 0
      fixture.ollama = () => ({ chatStream: (() => { calls += 1; return terminal()() }) as never })
      const result = await new CompletionProbeService(fixture).execute(
        'fixture:latest', BODY, new AbortController().signal,
      )
      assert.equal(result.status, 'skipped')
      assert.equal(calls, 0)
      assert.equal(fixture.store.records.size, 0)
    }
  })

  it('downgrades digest/runtime drift after provider and does not persist positive evidence', async () => {
    for (const deps of [
      dependencies({ installed: [
        [{ name: 'fixture:latest', digest: 'sha256:fixture' }],
        [{ name: 'fixture:latest', digest: 'sha256:changed' }],
      ] }),
      dependencies({ versions: ['0.12.6', '0.13.0'] }),
    ]) {
      const result = await new CompletionProbeService(deps).execute(
        'fixture:latest', BODY, new AbortController().signal,
      )
      assert.equal(result.status, 'degraded')
      assert.equal(result.reason, 'identity_changed')
      assert.equal(deps.store.records.size, 0)
    }
  })

  it('refuses sourced over-maximum and cloud/red/unknown fit without a provider load', async () => {
    const fixtures: LocalModel[] = [
      model({ contextLimit: { state: 'declared', value: 4_096, source: 'ollama_api_tags', observedAt: AT, confidence: 'declared' } }),
      model({ isCloud: true }),
      model({ fit: { ...model().fit, level: 'red' } }),
      model({ fit: { ...model().fit, level: 'unknown' } }),
    ]
    for (const installed of fixtures) {
      let calls = 0
      const deps = dependencies({ models: [installed], stream: (() => { calls += 1; return terminal()() }) as never })
      const result = await new CompletionProbeService(deps).execute(
        'fixture:latest', BODY, new AbortController().signal,
      )
      assert.equal(result.status, 'skipped')
      assert.equal(calls, 0)
    }
  })

  it('allows an unknown sourced limit without inventing a context cap', async () => {
    const custom = Number.MAX_SAFE_INTEGER
    const deps = dependencies({ models: [model({
      contextLimit: { state: 'unknown', value: null, source: 'not_reported', observedAt: AT, confidence: 'unknown' },
      fit: { ...model().fit, contextLength: custom },
    })] })
    const result = await new CompletionProbeService(deps).execute(
      'fixture:latest', { ...BODY, contextLength: custom }, new AbortController().signal,
    )
    assert.equal(result.status, 'verified')
    assert.equal(result.basis.state === 'exact' && result.basis.contextLength, custom)
  })

  it('queues behind normal work, exposes model_probe owner, and cleans up after caller cancel', async () => {
    const governor = new ResourceGovernor()
    const activeTicket = governor.enqueue({
      owner: { kind: 'job', jobId: 'active-chat' }, operation: 'chat',
      model: { provider: 'ollama', name: 'active:latest' }, requestedContext: 8_192,
      priority: 'normal', enqueuedAt: AT,
    })
    const activeLease = await governor.acquire(activeTicket)
    const request = new AbortController()
    const pending = new CompletionProbeService(dependencies({ governor })).execute(
      'fixture:latest', BODY, request.signal,
    )
    try {
      let queued: ReturnType<ResourceGovernor['snapshot']>['queued'][number] | undefined
      for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
        await Promise.resolve()
        queued = governor.snapshot().queued.find((item) => item.operation === 'model_probe')
      }
      assert.equal(queued?.owner.kind, 'operation')
      assert.equal(queued?.priority, 'normal')
      request.abort()
      const result = await pending
      assert.equal(result.status, 'cancelled')
      assert.equal(governor.snapshot().queued.length, 0)
    } finally {
      request.abort()
      activeLease.release()
    }
  })

  it('classifies connect/load/response timeout, provider error, malformed, empty and non-terminal streams', async () => {
    const streams = [
      async function* () { throw new OllamaTimeoutError('connect', 1) },
      async function* () { throw new OllamaTimeoutError('load', 1) },
      async function* () { throw new OllamaTimeoutError('stream_idle', 1) },
      async function* () { throw new OllamaError('raw /Users/private token=secret', 500) },
      async function* () { yield { model: 'x', created_at: AT, done: 'future' } as never },
      terminal(''),
      terminal('  \n\t'),
      async function* () { yield { model: 'x', created_at: AT, message: { role: 'assistant' as const, content: 'partial' }, done: false } },
      terminal('x'.repeat(COMPLETION_PROBE_MAX_RESPONSE_BYTES + 1)),
    ]
    const reasons = [
      'connect_timeout', 'load_timeout', 'response_timeout', 'provider_error',
      'runtime_protocol', 'empty_response', 'empty_response', 'runtime_protocol',
      'runtime_protocol',
    ]
    for (const [index, stream] of streams.entries()) {
      const deps = dependencies({ stream: stream as never })
      const result = await new CompletionProbeService(deps).execute(
        'fixture:latest', BODY, new AbortController().signal,
      )
      assert.equal(result.status, 'degraded')
      assert.equal(result.reason, reasons[index])
      assert.doesNotMatch(JSON.stringify(result), /Users|secret|token|raw/u)
    }
  })

  it('bounds deadline/caller cancellation and releases active lease/timers/listeners', async () => {
    for (const timeout of [true, false]) {
      const entered = deferred<void>()
      const controller = new AbortController()
      const deps = dependencies({
        deadlineMs: timeout ? 1 : 60_000,
        stream: (async function* (_request: unknown, signal?: AbortSignal) {
          entered.resolve()
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
        }) as never,
      })
      const pending = new CompletionProbeService(deps).execute('fixture:latest', BODY, controller.signal)
      await entered.promise
      if (!timeout) controller.abort()
      const result = await pending
      assert.equal(result.status, 'cancelled')
      assert.equal(result.reason, timeout ? 'request_timeout' : 'request_cancelled')
      assert.equal(deps.governor.snapshot().activeLease, null)
      assert.equal(deps.governor.snapshot().queued.length, 0)
    }
  })

  it('rejects same-key double activation while one fixed call is active', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const deps = dependencies({
      stream: (async function* () {
        entered.resolve()
        await release.promise
        yield { model: 'fixture:latest', created_at: AT, message: { role: 'assistant' as const, content: 'OK' }, done: true }
      }) as never,
    })
    const service = new CompletionProbeService(deps)
    const first = service.execute('fixture:latest', BODY, new AbortController().signal)
    await entered.promise
    const duplicate = await service.execute('fixture:latest', BODY, new AbortController().signal)
    assert.equal(duplicate.status, 'skipped')
    assert.equal(duplicate.reason, 'probe_in_progress')
    release.resolve()
    assert.equal((await first).status, 'verified')
  })

  it('never returns verified when persistence fails', async () => {
    const store = new MemoryStore()
    store.failWrite = true
    const result = await new CompletionProbeService(dependencies({ store })).execute(
      'fixture:latest', BODY, new AbortController().signal,
    )
    assert.equal(result.status, 'degraded')
    assert.equal(result.reason, 'persistence_failed')
    assert.doesNotMatch(JSON.stringify(result), /Users|secret|raw response/u)
  })
})
