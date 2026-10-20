import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  completionProbeResponse,
  type CompletionProbeBody,
  type CompletionProbeEvidence,
} from '@guanxi/contract'
import type { AppContext } from '../src/context.ts'
import { modelsRoutes } from '../src/http/models-routes.ts'

const AT = '2026-08-03T00:00:00.000Z'
const BODY: CompletionProbeBody = {
  capability: 'completion',
  expectedDigest: 'sha256:fixture',
  contextLength: 8_192,
  force: false,
}
const VERIFIED: CompletionProbeEvidence = {
  status: 'verified',
  reason: 'terminal_response',
  capability: 'completion',
  source: 'runtime_probe',
  confidence: 'verified',
  observedAt: AT,
  completedAt: AT,
  durationMs: 0,
  basis: {
    state: 'exact',
    keyVersion: 1,
    probeDefinitionVersion: 1,
    provider: 'ollama',
    normalizedModelReference: 'fixture:latest',
    artifactDigest: 'sha256:fixture',
    runtimeVersion: '0.12.6',
    contextLength: 8_192,
    id: `sha256:${'a'.repeat(64)}`,
  },
  historical: false,
}

function appWith(
  execute: (name: string, body: CompletionProbeBody, signal: AbortSignal) => Promise<CompletionProbeEvidence>,
) {
  const app = new Hono()
  app.route('/api/models', modelsRoutes({
    completionProbe: { execute },
  } as unknown as AppContext))
  return app
}

function request(body: unknown, signal?: AbortSignal): Request {
  return new Request('http://local.test/api/models/fixture%3Alatest/probes/completion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

describe('completion probe HTTP route', () => {
  it('rejects arbitrary fields before execution and returns one contract response', async () => {
    let calls = 0
    const app = appWith(async (name, body) => {
      calls += 1
      assert.equal(name, 'fixture:latest')
      assert.deepEqual(body, BODY)
      return VERIFIED
    })
    const invalid = await app.request(request({ ...BODY, prompt: 'private' }))
    assert.equal(invalid.status, 400)
    assert.equal(calls, 0)

    const response = await app.request(request(BODY))
    assert.equal(response.status, 200)
    assert.equal(completionProbeResponse.parse(await response.json()).evidence.status, 'verified')
    assert.equal(calls, 1)
  })

  it('propagates caller cancellation only through the request signal', async () => {
    let observedSignal: AbortSignal | undefined
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const app = appWith(async (_name, _body, signal) => {
      observedSignal = signal
      entered()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { ...VERIFIED, status: 'cancelled', reason: 'request_cancelled', confidence: 'unknown' }
    })
    const controller = new AbortController()
    const pending = app.request(request(BODY, controller.signal))
    await started
    controller.abort('navigation')
    const response = await pending
    assert.equal(observedSignal?.aborted, true)
    assert.equal(completionProbeResponse.parse(await response.json()).evidence.status, 'cancelled')
  })

  it('redacts unexpected service failures from the route response', async () => {
    const app = appWith(async () => {
      throw new Error('/Users/private/workspace fixed prompt token=secret raw body')
    })
    const response = await app.request(request(BODY))
    assert.equal(response.status, 500)
    const text = await response.text()
    assert.match(text, /completion probe could not be completed safely/u)
    assert.doesNotMatch(text, /Users|workspace|prompt|token|secret|raw body/u)
  })
})
