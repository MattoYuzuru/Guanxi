import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '@guanxi/kernel'
import { Budget } from '../src/budget.ts'
import type { RequestQuote } from '../src/request-admission.ts'
import { createTrialGateway } from '../src/k3-gateway.ts'
import { plan } from './helpers.ts'
import { resourceGovernorPlugin } from '../../server/src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../server/src/ollama/plugin.ts'
import { egressScrubberPlugin } from '../../server/src/egress/plugin.ts'
import { connectionsPlugin } from '../../server/src/connections/plugin.ts'
import type { Connections } from '../../server/src/connections/service.ts'
import { piModels } from '../../server/src/connections/pi.ts'

test('actual K3 prepared hook reserves after scrubbing and rejects a second request before provider dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b1-k3-admission-'))
  const kernel = createKernel(), now = new Date('2026-10-21T12:00:00Z'), budget = new Budget(':memory:', () => now)
  let dispatches = 0, quoted = 0, observedOutputLimit: number | undefined, observedRetries: number | undefined
  const key = `fixture_${randomBytes(32).toString('hex')}`, wrappingKey = randomBytes(32)
  const model = piModels('deepseek')[0]!
  try {
    await kernel.plugin(resourceGovernorPlugin)
    await kernel.plugin(ollamaAdapterPlugin, { fetch: async () => { throw new Error('fixture_no_network') } })
    await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
    await kernel.plugin(connectionsPlugin, {
      databasePath: join(directory, 'connections.sqlite'), localHost: () => 'http://127.0.0.1:11434',
      keychain: async () => ({ key: () => Buffer.from(wrappingKey) }),
      transport: async () => { throw new Error('fixture_no_network') },
      pi: { async complete(_model, context, options) {
        dispatches++
        assert.equal(quoted, 1)
        assert.equal(budget.requestRows()[0]!.state, 'reserved', 'durable hold exists before the provider is called')
        observedOutputLimit = options.maxTokens
        observedRetries = options.maxRetries
        assert.equal(JSON.stringify(context).includes(key), false)
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: 'fixture' }], stopReason: 'stop', timestamp: now.getTime(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      } },
    })
    const k3 = kernel.service<Connections>('connections.registry')!
    const connection = k3.create('bench-owner', { name: 'Fixture', kind: 'model_api', provider: 'deepseek', auth: 'api_key' })
    await k3.unlockVault('bench-owner'); k3.saveSecret('bench-owner', connection.id, key)
    const p = plan({ tasks: plan().tasks.slice(0, 1), model: model.id, provider: 'deepseek',
      connection: 'secret://fixture/connection', maxTrialMicrousd: 10, maxTrialTokens: 10,
      maxSteps: 1, armCapMicrousd: 10, dailyTokenCap: 20 })
    budget.reserve(p)
    const quote = (prepared: unknown, digest: string): RequestQuote => {
      quoted++
      assert.equal(JSON.stringify(prepared).includes(key), false, 'K3 scrubbed before pricing/metering')
      const fact = { source: 'fixture:meter-and-price', observedAt: '2026-10-21T11:59:00Z', validUntil: '2026-10-21T12:01:00Z', confidence: 'verified' as const }
      return { provider: 'deepseek', model: model.id, preparedSha256: digest, inputTokenBound: 5, outputTokenLimit: 5,
        meter: { ...fact, format: 'provider-request-upper-bound' },
        price: { ...fact, currency: 'USD', inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 1_000_000, requestMicrousd: 0 } }
    }
    const gateway = createTrialGateway({ budget, k3, accountId: 'bench-owner', connectionId: connection.id,
      model: model.id, provider: 'deepseek', outputTokenLimit: 5,
      trial: { runId: p.id, task: p.tasks[0]!.id, arm: 'control', seed: 0 },
      billing: { quote, usage: () => ({ tokens: 2, costMicrousd: 0, source: 'fixture:usage', observedAt: now.toISOString(), confidence: 'verified' }) } })
    const context = { messages: [{ role: 'user' as const, content: key, timestamp: now.getTime() }] }
    await gateway.complete(context)
    assert.equal(observedOutputLimit, 5)
    assert.equal(observedRetries, 0)
    await assert.rejects(gateway.complete(context), /request_budget_exceeded/)
    assert.equal(dispatches, 1)
    assert.equal(budget.requestRows().length, 1)
  } finally { await kernel.dispose(); wrappingKey.fill(0); budget.close(); await rm(directory, { recursive: true, force: true }) }
})
