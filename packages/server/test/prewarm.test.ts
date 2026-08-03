import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  legacyInstalledModelDescriptor,
  prewarmModelResponse,
  type LocalModel,
  type PrewarmModelBody,
  type RuntimeSnapshot,
} from '@alamo/contract'
import type { AppContext } from '../src/context.ts'
import { modelsRoutes } from '../src/http/models-routes.ts'
import {
  PREWARM_KEEP_ALIVE,
  executePrewarm,
  type PrewarmDependencies,
} from '../src/runtime/prewarm.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'

const BODY: PrewarmModelBody = {
  operation: 'chat',
  contextLength: 8_192,
  selection: {
    digest: 'sha256:fixture',
    fitLevel: 'green',
    fitBasis: 'estimate',
  },
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function model(overrides: Partial<LocalModel> = {}): LocalModel {
  return {
    name: 'fixture:latest',
    digest: 'sha256:fixture',
    sizeBytes: 4_000_000_000,
    modifiedAt: '2026-08-03T00:00:00.000Z',
    family: 'fixture',
    parameterSize: '7B',
    quantization: 'Q4_K_M',
    contextLength: 32_768,
    contextLimit: {
      state: 'declared',
      value: 32_768,
      source: 'ollama_api_tags',
      observedAt: '2026-08-03T00:00:00.000Z',
      confidence: 'declared',
    },
    capabilities: ['completion'],
    descriptor: legacyInstalledModelDescriptor,
    isCloud: false,
    fit: {
      level: 'green',
      summary: 'fixture fit',
      contextLength: 8_192,
      modelBytes: 4_000_000_000,
      kvCacheBytes: 1_000_000_000,
      requiredBytes: 5_000_000_000,
      usableBytes: 12_000_000_000,
      utilization: 0.42,
      basis: 'estimate',
      measured: null,
    },
    ...overrides,
  }
}

function runtime(models: RuntimeSnapshot['models'] = []): RuntimeSnapshot {
  return {
    observedAt: '2026-08-03T00:00:00.000Z',
    source: {
      state: 'available',
      source: 'ollama_api_ps',
      observedAt: '2026-08-03T00:00:00.000Z',
      errorCode: null,
    },
    models,
  } as RuntimeSnapshot
}

function dependencies(options: {
  governor?: ResourceGovernor
  installed?: LocalModel[]
  snapshot?: RuntimeSnapshot
  enabled?: boolean
  warm?: PrewarmDependencies['ollama'] extends () => infer Client
    ? Client extends { warm: infer Warm }
      ? Warm
      : never
    : never
  timeoutMs?: number
} = {}): PrewarmDependencies {
  return {
    governor: options.governor ?? new ResourceGovernor(),
    settings: { get: () => ({ prewarmEnabled: options.enabled ?? true }) as never },
    models: () => ({ listLocal: async () => options.installed ?? [model()] }),
    runtime: { snapshot: async () => options.snapshot ?? runtime() },
    ollama: () => ({ warm: options.warm ?? (async () => undefined) }),
    now: () => new Date('2026-08-03T00:00:00.000Z'),
    timeoutMs: options.timeoutMs,
  }
}

describe('typed low-priority prewarm command', () => {
  it('preserves an exact custom context above the retired ceiling with the short TTL', async () => {
    const customContext = 1_048_577
    const calls: number[] = []
    const request: PrewarmModelBody = {
      ...BODY,
      contextLength: customContext,
      selection: { ...BODY.selection },
    }
    const result = await executePrewarm(
      dependencies({
        installed: [model({
          contextLength: 2_000_000,
          contextLimit: {
            state: 'declared', value: 2_000_000, source: 'ollama_api_tags',
            observedAt: '2026-08-03T00:00:00.000Z', confidence: 'declared',
          },
          fit: { ...model().fit, contextLength: customContext },
        })],
        warm: async (_name, context, keepAlive) => {
          calls.push(context)
          assert.equal(keepAlive, PREWARM_KEEP_ALIVE)
        },
      }),
      'fixture:latest', request, new AbortController().signal,
    )
    assert.equal(result.status, 'warmed')
    assert.deepEqual(calls, [customContext])
  })

  it('loads only an exact eligible installed variant with the central short TTL and releases', async () => {
    const calls: Array<{ name: string; context: number; keepAlive: string }> = []
    const deps = dependencies({
      warm: async (name, context, keepAlive) => {
        calls.push({ name, context, keepAlive: String(keepAlive) })
      },
    })
    const result = prewarmModelResponse.parse(
      await executePrewarm(deps, 'fixture:latest', BODY, new AbortController().signal),
    )
    assert.deepEqual(calls, [
      { name: 'fixture:latest', context: 8_192, keepAlive: PREWARM_KEEP_ALIVE },
    ])
    assert.equal(result.status, 'warmed')
    assert.equal(result.priority, 'prewarm')
    assert.equal(result.purpose, 'model_prewarm')
    assert.equal(deps.governor.snapshot().activeLease, null)
  })

  it('reuses only exact digest/context residency and skips ambiguous identity', async () => {
    let warmCalls = 0
    const exactRow = {
      name: 'fixture:latest',
      normalizedName: 'fixture:latest',
      digest: 'sha256:fixture',
      contextLength: 8_192,
    } as NonNullable<RuntimeSnapshot['models']>[number]
    const reused = await executePrewarm(
      dependencies({
        snapshot: runtime([exactRow]),
        warm: async () => {
          warmCalls += 1
        },
      }),
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(reused.status, 'reused')
    assert.equal(reused.reason, 'already_resident_exact')

    const ambiguous = await executePrewarm(
      dependencies({
        snapshot: runtime([{ ...exactRow, digest: null }]),
        warm: async () => {
          warmCalls += 1
        },
      }),
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(ambiguous.status, 'skipped')
    assert.equal(ambiguous.reason, 'resident_identity_ambiguous')
    assert.equal(warmCalls, 0)
  })

  it('skips disabled, changed, unknown, unavailable, and normal-work policy states', async () => {
    const fixtures: Array<{
      deps: PrewarmDependencies
      body?: PrewarmModelBody
      reason: string
    }> = [
      { deps: dependencies({ enabled: false }), reason: 'disabled' },
      {
        deps: dependencies(),
        body: { ...BODY, selection: { ...BODY.selection, digest: 'sha256:stale' } },
        reason: 'selection_changed',
      },
      {
        deps: dependencies({
          installed: [model({ fit: { ...model().fit, level: 'unknown' } })],
        }),
        body: { ...BODY, selection: { ...BODY.selection, fitLevel: 'unknown' } },
        reason: 'fit_unknown',
      },
      {
        deps: dependencies({
          installed: [model({ fit: { ...model().fit, level: 'red' } })],
        }),
        body: { ...BODY, selection: { ...BODY.selection, fitLevel: 'red' } },
        reason: 'fit_unavailable',
      },
      {
        deps: dependencies({
          snapshot: { ...runtime(), source: { ...runtime().source, state: 'unavailable' } } as RuntimeSnapshot,
        }),
        reason: 'runtime_unavailable',
      },
    ]

    const normalGovernor = new ResourceGovernor()
    const normalTicket = normalGovernor.enqueue({
      owner: { kind: 'operation', operationId: 'normal-owner' },
      operation: 'model_warm',
      model: { provider: 'ollama', name: 'normal:latest' },
      requestedContext: 4_096,
      priority: 'normal',
      enqueuedAt: '2026-08-03T00:00:00.000Z',
    })
    const normalLease = await normalGovernor.acquire(normalTicket)
    fixtures.push({
      deps: dependencies({ governor: normalGovernor }),
      reason: 'normal_work_present',
    })

    for (const fixture of fixtures) {
      const result = await executePrewarm(
        fixture.deps,
        'fixture:latest',
        fixture.body ?? BODY,
        new AbortController().signal,
      )
      assert.equal(result.reason, fixture.reason)
      assert.notEqual(result.status, 'warmed')
    }
    normalLease.release()
  })

  it('normal enqueue aborts only active prewarm, waits for release, and preserves one permit', async () => {
    const governor = new ResourceGovernor()
    const events: string[] = []
    let warmSignal: AbortSignal | undefined
    const entered = deferred()
    const prewarm = executePrewarm(
      dependencies({
        governor,
        warm: async (_name, _context, _keepAlive, signal) => {
          warmSignal = signal
          events.push('prewarm-enter')
          entered.resolve()
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                events.push('prewarm-abort')
                reject(new DOMException('aborted', 'AbortError'))
              },
              { once: true },
            )
          })
        },
      }),
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    await entered.promise

    const normalTicket = governor.enqueue({
      owner: { kind: 'job', jobId: 'normal-job' },
      operation: 'chat',
      model: { provider: 'ollama', name: 'normal:latest' },
      requestedContext: 8_192,
      priority: 'normal',
      enqueuedAt: '2026-08-03T00:00:00.000Z',
    })
    const normalLeasePromise = governor.acquire(normalTicket).then((lease) => {
      events.push('normal-enter')
      return lease
    })
    const result = await prewarm
    const normalLease = await normalLeasePromise
    assert.equal(warmSignal?.aborted, true)
    assert.equal(result.reason, 'normal_work_started')
    assert.deepEqual(events, ['prewarm-enter', 'prewarm-abort', 'normal-enter'])
    normalLease.release()
    assert.equal(governor.active, false)
  })

  it('bounds disconnect/deadline cleanup and redacts unexpected provider failure', async () => {
    const validationController = new AbortController()
    const validationEntered = deferred()
    const validationDeps = dependencies()
    validationDeps.models = () => ({
      listLocal: async (_contextLength, signal) => {
        validationEntered.resolve()
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return [model()]
      },
    })
    const validationPending = executePrewarm(
      validationDeps,
      'fixture:latest',
      BODY,
      validationController.signal,
    )
    await validationEntered.promise
    validationController.abort()
    const validationResult = await validationPending
    assert.equal(validationResult.status, 'cancelled')
    assert.equal(validationResult.reason, 'request_cancelled')
    assert.equal(validationDeps.governor.active, false)

    for (const fixture of [
      { abortRequest: true, timeoutMs: 1, expected: 'request_cancelled' },
      { abortRequest: false, timeoutMs: 1, expected: 'request_timeout' },
    ]) {
      const requestController = new AbortController()
      const entered = deferred()
      const deps = dependencies({
        timeoutMs: fixture.timeoutMs,
        warm: async (_name, _context, _keepAlive, signal) => {
          entered.resolve()
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          })
        },
      })
      const pending = executePrewarm(deps, 'fixture:latest', BODY, requestController.signal)
      await entered.promise
      if (fixture.abortRequest) requestController.abort()
      const result = await pending
      assert.equal(result.reason, fixture.expected)
      assert.equal(deps.governor.active, false)
    }

    const failure = await executePrewarm(
      dependencies({
        warm: async () => {
          throw new Error('raw body /Users/private token=secret endpoint=/api/chat')
        },
      }),
      'fixture:latest',
      BODY,
      new AbortController().signal,
    )
    assert.equal(failure.reason, 'runtime_unavailable')
    assert.doesNotMatch(JSON.stringify(failure), /Users|secret|endpoint|raw body/u)
  })

  it('validates the HTTP body and returns the typed safe response', async () => {
    const deps = dependencies()
    const app = modelsRoutes({
      governor: deps.governor,
      runtime: deps.runtime,
      settings: deps.settings,
      models: deps.models,
      ollama: deps.ollama,
    } as AppContext)
    const malformed = await app.request('/fixture%3Alatest/prewarm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextLength: 8_192 }),
    })
    assert.equal(malformed.status, 400)

    const response = await app.request('/fixture%3Alatest/prewarm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    assert.equal(response.status, 200)
    assert.equal(prewarmModelResponse.parse(await response.json()).status, 'warmed')
  })
})
