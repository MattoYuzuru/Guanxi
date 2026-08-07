import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  modelCapabilityOverrideResponse,
  type ModelCapabilityOverrideMutationBody,
  type ModelCapabilityOverrideOutcome,
} from '@alamo/contract'
import type { AppContext } from '../src/context.ts'
import { modelsRoutes } from '../src/http/models-routes.ts'

const AT = '2026-08-07T00:00:00.000Z'
const BODY: ModelCapabilityOverrideMutationBody = {
  capability: 'tools',
  expectedDigest: 'sha256:fixture',
  expectedRuntimeVersion: '0.12.6',
}
const IDENTITY = {
  provider: 'ollama' as const,
  normalizedModelReference: 'fixture:latest',
  artifactDigest: 'sha256:fixture',
  runtimeVersion: '0.12.6',
}
const APPLIED: ModelCapabilityOverrideOutcome = {
  state: 'applied',
  capability: 'tools',
  identity: IDENTITY,
  overrides: [{
    version: 1,
    source: 'user_override',
    state: 'overridden',
    value: 'present',
    capability: 'tools',
    provider: 'ollama',
    normalizedModelReference: 'fixture:latest',
    artifactDigest: 'sha256:fixture',
    runtimeVersion: '0.12.6',
    createdAt: AT,
    updatedAt: AT,
  }],
}

type Mutate = (
  name: string,
  body: ModelCapabilityOverrideMutationBody,
  signal: AbortSignal,
) => Promise<ModelCapabilityOverrideOutcome>

function appWith(handlers: { apply?: Mutate; clear?: Mutate }) {
  const unexpected: Mutate = async () => {
    throw new Error('this mutation must not be reached')
  }
  const app = new Hono()
  app.route('/api/models', modelsRoutes({
    capabilityOverrides: {
      apply: handlers.apply ?? unexpected,
      clear: handlers.clear ?? unexpected,
    },
    models: () => ({ detail: async () => null }),
    ollama: () => ({ deleteModel: async () => undefined }),
  } as unknown as AppContext))
  return app
}

function request(method: 'POST' | 'DELETE', body: unknown, signal?: AbortSignal): Request {
  return new Request(
    'http://local.test/api/models/fixture%3Alatest/capability-overrides',
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
  )
}

describe('capability override HTTP routes', () => {
  it('routes POST and DELETE to the exact model without the name swallowing the suffix', async () => {
    const seen: Array<{ method: string; name: string }> = []
    const app = appWith({
      apply: async (name, body) => {
        seen.push({ method: 'POST', name })
        assert.deepEqual(body, BODY)
        return APPLIED
      },
      clear: async (name, body) => {
        seen.push({ method: 'DELETE', name })
        assert.deepEqual(body, BODY)
        return { ...APPLIED, state: 'cleared', overrides: [] }
      },
    })

    const applied = await app.request(request('POST', BODY))
    assert.equal(applied.status, 200)
    const appliedBody = modelCapabilityOverrideResponse.parse(await applied.json())
    assert.equal(appliedBody.outcome.state, 'applied')
    assert.equal(appliedBody.outcome.overrides.length, 1)

    const cleared = await app.request(request('DELETE', BODY))
    assert.equal(cleared.status, 200)
    assert.equal(
      modelCapabilityOverrideResponse.parse(await cleared.json()).outcome.state,
      'cleared',
    )

    // The greedy `:name` pattern must not capture `fixture:latest/capability-overrides`.
    assert.deepEqual(seen, [
      { method: 'POST', name: 'fixture:latest' },
      { method: 'DELETE', name: 'fixture:latest' },
    ])
  })

  it('rejects arbitrary and incomplete bodies before any mutation', async () => {
    let calls = 0
    const app = appWith({
      apply: async () => { calls += 1; return APPLIED },
      clear: async () => { calls += 1; return APPLIED },
    })
    const invalid: unknown[] = [
      { ...BODY, note: 'free form' },
      { ...BODY, value: 'absent' },
      { ...BODY, capability: 'audio' },
      { ...BODY, capability: 'anything' },
      { ...BODY, expectedDigest: '' },
      { ...BODY, expectedRuntimeVersion: '' },
      { capability: 'tools' },
      {},
      null,
      'tools',
    ]
    for (const body of invalid) {
      for (const method of ['POST', 'DELETE'] as const) {
        const response = await app.request(request(method, body))
        assert.equal(response.status, 400, `${method} ${JSON.stringify(body)}`)
        const payload = await response.json() as { code: string }
        assert.equal(payload.code, 'validation_failed')
      }
    }
    assert.equal(calls, 0)
  })

  it('propagates caller cancellation through the request signal only', async () => {
    let observed: AbortSignal | undefined
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const app = appWith({
      apply: async (_name, _body, signal) => {
        observed = signal
        entered()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }))
        throw new DOMException('Aborted', 'AbortError')
      },
    })
    const controller = new AbortController()
    const pending = app.request(request('POST', BODY, controller.signal))
    await started
    controller.abort('navigation')
    const response = await pending
    assert.equal(observed?.aborted, true)
    assert.equal(response.status, 409)
  })

  it('redacts an unexpected failure from the response', async () => {
    const app = appWith({
      apply: async () => {
        throw new Error('SQLITE_IOERR /Users/private/.alamo/alamo.db token=secret raw body')
      },
      clear: async () => {
        throw new Error('SQLITE_IOERR /Users/private/.alamo/alamo.db token=secret raw body')
      },
    })
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await app.request(request(method, BODY))
      assert.equal(response.status, 500)
      const text = await response.text()
      assert.match(text, /capability override could not be changed safely/u)
      assert.doesNotMatch(text, /Users|private|alamo\.db|token|secret|raw body|SQLITE/u)
    }
  })

  it('returns a typed conflict with a 200 outcome and no override', async () => {
    const app = appWith({
      apply: async () => ({
        state: 'conflict',
        capability: 'tools',
        reason: 'digest_expectation_mismatch',
        identity: null,
        overrides: [],
      }),
    })
    const response = await app.request(request('POST', BODY))
    assert.equal(response.status, 200)
    const outcome = modelCapabilityOverrideResponse.parse(await response.json()).outcome
    assert.equal(outcome.state, 'conflict')
    assert.equal(outcome.overrides.length, 0)
    assert.equal(outcome.identity, null)
  })

  it('does not let the model DELETE route remove a model through this path', async () => {
    let deleted = 0
    const app = new Hono()
    app.route('/api/models', modelsRoutes({
      capabilityOverrides: {
        apply: async () => APPLIED,
        clear: async () => ({ ...APPLIED, state: 'cleared', overrides: [] }),
      },
      ollama: () => ({
        deleteModel: async () => { deleted += 1 },
      }),
    } as unknown as AppContext))

    const response = await app.request(request('DELETE', BODY))
    assert.equal(response.status, 200)
    assert.equal(
      modelCapabilityOverrideResponse.parse(await response.json()).outcome.state,
      'cleared',
    )
    // The generic model-deletion route must never be reached by this path.
    assert.equal(deleted, 0)
  })
})
