import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  listRunningResponse,
  runtimeSnapshotSchema,
  type RunningModel,
} from '@alamo/contract'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import type { ModelService } from '../src/models/service.ts'
import {
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from '../src/ollama/client.ts'
import {
  ResourceGovernor,
  ResourceGovernorError,
  type AdmissionRequest,
  type ResourceLease,
} from '../src/runtime/resource-governor.ts'
import {
  RuntimeReconciliationService,
  normalizeOllamaModelReference,
} from '../src/runtime/reconciliation.ts'

const OBSERVED_AT = '2026-08-03T12:00:00.000Z'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function request(ownerId: string, model = ownerId): AdmissionRequest {
  return {
    owner: { kind: 'operation', operationId: ownerId },
    operation: 'model_warm',
    model: { provider: 'ollama', name: model },
    requestedContext: 8_192,
    priority: 'normal',
    enqueuedAt: OBSERVED_AT,
  }
}

function running(
  name: string,
  options: Partial<Pick<RunningModel, 'digest' | 'contextLength'>> = {},
): RunningModel {
  return {
    name,
    digest: options.digest ?? `sha256:${name}`,
    sizeBytes: 1_000,
    sizeVramBytes: 750,
    gpuPercent: null,
    processorLabel: null,
    contextLength: options.contextLength ?? 8_192,
    expiresAt: '2026-08-03T12:10:00.000Z',
    source: 'ollama_api_ps',
    observedAt: '2020-01-01T00:00:00.000Z',
  }
}

function reconciliation(
  governor: ResourceGovernor,
  ps: () => Promise<RunningModel[]>,
): RuntimeReconciliationService {
  return new RuntimeReconciliationService({
    governor,
    models: () => ({ ps }) as unknown as ModelService,
    now: () => new Date(OBSERVED_AT),
  })
}

async function activeLease(
  governor: ResourceGovernor,
  model: string,
  ownerId = 'active-owner',
): Promise<ResourceLease> {
  return governor.acquire(governor.enqueue(request(ownerId, model)))
}

describe('runtime reconciliation contract and identity', () => {
  it('normalizes only exact Ollama references and does not fuzzy-match invalid names', () => {
    assert.equal(normalizeOllamaModelReference(' QWEN3 '), 'qwen3:latest')
    assert.equal(normalizeOllamaModelReference('library/QWEN3:8B'), 'library/qwen3:8b')
    assert.equal(
      normalizeOllamaModelReference('registry.invalid:5000/team/model'),
      'registry.invalid:5000/team/model:latest',
    )
    assert.equal(normalizeOllamaModelReference('../private/model'), null)
    assert.equal(normalizeOllamaModelReference('/tmp/private'), null)
    assert.equal(normalizeOllamaModelReference('model secret'), null)
  })

  it('round-trips active/queued admission, matched and unknown rows without digest identity claims', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'Fixture')
    const queued = governor.enqueue(request('queued-owner', 'queued'))
    const service = reconciliation(governor, async () => [
      running('fixture:latest', { digest: 'sha256:observed', contextLength: 8_192 }),
      running('second:latest', { digest: 'sha256:second', contextLength: 4_096 }),
    ])

    const snapshot = runtimeSnapshotSchema.parse(await service.snapshot())
    assert.equal(snapshot.observedAt, OBSERVED_AT)
    assert.equal(snapshot.source.state, 'available')
    assert.equal(snapshot.governor.activeLease?.leaseId, lease.id)
    assert.equal(snapshot.governor.activeLease?.requestedContext, 8_192)
    assert.deepEqual(snapshot.governor.queued.map((entry) => entry.ticketId), [queued.id])
    assert.deepEqual(
      snapshot.models?.map((model) => ({
        name: model.normalizedName,
        owner: model.ownerState,
        decision: model.decisionCode,
        artifact: model.artifactIdentity,
      })),
      [
        {
          name: 'fixture:latest',
          owner: 'active_lease',
          decision: 'matched_active_lease',
          artifact: 'unknown',
        },
        {
          name: 'second:latest',
          owner: 'unknown',
          decision: 'observed_unknown_owner',
          artifact: 'unknown',
        },
      ],
    )
    const matched = snapshot.decisions.find((item) => item.code === 'matched_active_lease')
    assert.equal(matched?.runtimeDigest, 'sha256:observed')
    assert.equal(matched?.requestedContext, 8_192)
    assert.equal(matched?.observedContext, 8_192)
    assert.equal(matched?.artifactIdentity, 'unknown')
    assert.equal(snapshot.models?.every((model) => model.observedAt === OBSERVED_AT), true)

    lease.release()
    assert.equal(governor.cancel(queued), true)
  })

  it('keeps a successful empty sample distinct and leaves an active lease not observed', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'active:latest')
    const snapshot = runtimeSnapshotSchema.parse(
      await reconciliation(governor, async () => []).snapshot(),
    )

    assert.deepEqual(snapshot.models, [])
    assert.deepEqual(
      snapshot.decisions.map((item) => item.code),
      ['active_not_observed', 'empty_sample'],
    )
    assert.equal(snapshot.governor.activeLease?.leaseId, lease.id)
    assert.equal(governor.active, true)
    assert.throws(
      () => governor.assertCanUnload({ provider: 'ollama', name: 'active:latest' }),
      ResourceGovernorError,
    )
    lease.release()
  })
})

describe('runtime reconciliation failures', () => {
  it('keeps queue/lease state on unavailable, timeout and malformed samples without healthy []', async () => {
    const fixtures = [
      {
        error: new OllamaUnavailableError('http://user:secret@private.invalid'),
        state: 'unavailable',
        code: 'ollama_unavailable',
      },
      {
        error: new OllamaTimeoutError('connect', 17),
        state: 'unavailable',
        code: 'ollama_connect_timeout',
      },
      {
        error: new OllamaProtocolError('/api/ps', 'raw provider body private prompt'),
        state: 'incompatible',
        code: 'runtime_protocol',
      },
    ] as const

    for (const fixture of fixtures) {
      const governor = new ResourceGovernor()
      const lease = await activeLease(governor, 'active:latest')
      const queued = governor.enqueue(request('queued-owner', 'queued:latest'))
      const snapshot = runtimeSnapshotSchema.parse(
        await reconciliation(governor, async () => {
          throw fixture.error
        }).snapshot(),
      )

      assert.equal(snapshot.source.state, fixture.state)
      assert.equal(snapshot.source.errorCode, fixture.code)
      assert.equal(snapshot.models, null)
      assert.deepEqual(snapshot.decisions.map((item) => item.code), ['source_failure'])
      assert.equal(snapshot.governor.activeLease?.leaseId, lease.id)
      assert.deepEqual(snapshot.governor.queued.map((item) => item.ticketId), [queued.id])
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /user:secret|private\.invalid|raw provider body|private prompt|\/tmp\/private/u,
      )

      lease.release()
      assert.equal(governor.cancel(queued), true)
    }
  })

  it('redacts arbitrary provider reasons and keeps runtime success separate from compatibility errors', async () => {
    const governor = new ResourceGovernor()
    const privateError = new OllamaUnavailableError(
      'http://user:secret-token@private.invalid/tmp/private',
      new Error('provider body private prompt'),
    )
    const service = reconciliation(governor, async () => {
      throw privateError
    })
    const app = createApp({ runtime: service } as AppContext)

    const runtimeResponse = await app.request('/api/runtime')
    const runtimeBody = await runtimeResponse.text()
    assert.equal(runtimeResponse.status, 200)
    assert.equal(runtimeSnapshotSchema.parse(JSON.parse(runtimeBody)).source.errorCode, 'ollama_unavailable')
    assert.doesNotMatch(runtimeBody, /secret-token|private\.invalid|\/tmp\/private|prompt/u)

    const compatibilityResponse = await app.request('/api/models/running')
    const compatibilityBody = await compatibilityResponse.text()
    assert.equal(compatibilityResponse.status, 503)
    assert.equal((JSON.parse(compatibilityBody) as { code: string }).code, 'ollama_unavailable')
    assert.doesNotMatch(
      compatibilityBody,
      /user:secret-token|private\.invalid|\/tmp\/private|provider body|prompt/u,
    )
  })
})

describe('runtime reconciliation concurrency and lifecycle', () => {
  it('linearizes after provider observation and captures enqueue/acquire/release as one snapshot', async () => {
    const governor = new ResourceGovernor()
    const first = await activeLease(governor, 'first:latest', 'first-owner')
    const provider = deferred<RunningModel[]>()
    const service = reconciliation(governor, () => provider.promise)
    const pendingSnapshot = service.snapshot()

    const secondTicket = governor.enqueue(request('second-owner', 'second'))
    const secondLeasePromise = governor.acquire(secondTicket)
    first.release()
    const second = await secondLeasePromise
    provider.resolve([running('SECOND:latest')])

    const snapshot = runtimeSnapshotSchema.parse(await pendingSnapshot)
    assert.equal(snapshot.governor.activeLease?.leaseId, second.id)
    assert.equal(snapshot.models?.[0]?.decisionCode, 'matched_active_lease')
    assert.equal(snapshot.models?.[0]?.leaseId, second.id)
    assert.equal(snapshot.source.observedAt, snapshot.observedAt)
    assert.equal(snapshot.governor.observedAt, snapshot.observedAt)
    second.release()
  })

  it('single-flights concurrent callers, isolates caller abort and clears live diagnostic state', async () => {
    const governor = new ResourceGovernor()
    const provider = deferred<RunningModel[]>()
    let calls = 0
    const service = reconciliation(governor, async () => {
      calls += 1
      if (calls === 1) return provider.promise
      return []
    })
    const cancelled = new AbortController()
    const first = service.snapshot({ signal: cancelled.signal })
    const second = service.snapshot()
    assert.equal(calls, 1)
    assert.equal(service.sampling, true)

    cancelled.abort('caller-left')
    await assert.rejects(first, { name: 'AbortError' })
    provider.resolve([running('shared:latest')])
    assert.equal((await second).models?.[0]?.name, 'shared:latest')
    assert.equal(calls, 1)
    assert.equal(service.sampling, false)

    const next = await service.snapshot()
    assert.deepEqual(next.models, [])
    assert.equal(calls, 2)
    assert.equal(service.sampling, false)
  })

  it('shares one provider call across both public routes and preserves the running compatibility shape', async () => {
    const governor = new ResourceGovernor()
    const provider = deferred<RunningModel[]>()
    let calls = 0
    const service = reconciliation(governor, async () => {
      calls += 1
      return provider.promise
    })
    const app = createApp({ runtime: service } as AppContext)
    const runtimeRequest = app.request('/api/runtime')
    const runningRequest = app.request('/api/models/running')
    assert.equal(calls, 1)

    provider.resolve([running('shared:latest')])
    const [runtimeResponse, runningResponse] = await Promise.all([
      runtimeRequest,
      runningRequest,
    ])
    assert.equal(runtimeResponse.status, 200)
    assert.equal(runningResponse.status, 200)
    assert.equal(runtimeSnapshotSchema.parse(await runtimeResponse.json()).models?.length, 1)
    const compatibility = listRunningResponse.parse(await runningResponse.json())
    assert.deepEqual(Object.keys(compatibility.models[0]!).sort(), [
      'contextLength',
      'digest',
      'expiresAt',
      'gpuPercent',
      'name',
      'observedAt',
      'processorLabel',
      'sizeBytes',
      'sizeVramBytes',
      'source',
    ])
    assert.equal(calls, 1)
    assert.equal(service.sampling, false)
  })

  it('never auto-unloads an observed unknown-owner row and preserves the active unload guard', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'active:latest')
    let psCalls = 0
    let unloadCalls = 0
    const service = reconciliation(governor, async () => {
      psCalls += 1
      return [running('unknown:latest')]
    })

    const snapshot = await service.snapshot()
    assert.equal(snapshot.models?.[0]?.ownerState, 'unknown')
    assert.equal(snapshot.models?.[0]?.decisionCode, 'observed_unknown_owner')
    assert.equal(snapshot.decisions.some((item) => item.code === 'active_not_observed'), true)
    assert.equal(psCalls, 1)
    assert.equal(unloadCalls, 0)
    assert.throws(
      () => {
        governor.assertCanUnload({ provider: 'ollama', name: 'unknown:latest' })
        unloadCalls += 1
      },
      ResourceGovernorError,
    )
    assert.equal(unloadCalls, 0)
    lease.release()
  })
})

describe('runtime reconciliation composition inventory', () => {
  it('keeps both public projections on one application boundary with no direct route/Web ps call', () => {
    const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
    const webRoot = fileURLToPath(new URL('../../web/src/', import.meta.url))
    const context = readFileSync(`${sourceRoot}/context.ts`, 'utf8')
    const app = readFileSync(`${sourceRoot}/app.ts`, 'utf8')
    const modelsRoute = readFileSync(`${sourceRoot}/http/models-routes.ts`, 'utf8')
    const runtimeRoute = readFileSync(`${sourceRoot}/http/runtime-routes.ts`, 'utf8')
    const webApi = readFileSync(`${webRoot}/lib/api.ts`, 'utf8')
    const webRuntime = readFileSync(`${webRoot}/features/health/RuntimeStatus.tsx`, 'utf8')
    const publicProjectionSources = [modelsRoute, runtimeRoute, webApi, webRuntime].join('\n')

    assert.match(context, /const runtime = new RuntimeReconciliationService\(\{ governor, models \}\)/u)
    assert.match(context, /\bruntime,\n/u)
    assert.match(app, /server\.route\('\/api\/runtime', runtimeRoutes\(app\)\)/u)
    assert.match(modelsRoute, /app\.runtime\.runningModels/u)
    assert.match(runtimeRoute, /app\.runtime\.snapshot/u)
    assert.doesNotMatch(publicProjectionSources, /\.ps\(/u)
    assert.match(webApi, /request\(ROUTES\.modelsRunning\(\), listRunningResponse/u)
    assert.equal(existsSync(`${sourceRoot}/runtime/reconciliation.ts`), true)
  })
})
