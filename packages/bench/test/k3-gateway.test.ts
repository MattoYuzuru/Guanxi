import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Budget } from '../src/budget.ts'
import { createTrialGateway, type BillingAdapter, type TrialGatewayConfig } from '../src/k3-gateway.ts'
import { type RequestQuote } from '../src/request-admission.ts'
import { plan } from './helpers.ts'

const now = new Date('2026-10-21T12:00:00Z')
const context = { messages: [{ role: 'user' as const, content: 'fixture', timestamp: now.getTime() }] }
function setup() {
  const budget = new Budget(':memory:', () => now)
  budget.reserve(plan({ tasks: plan().tasks.slice(0, 1), provider: 'fixture', model: 'fixture-metered',
    maxTrialMicrousd: 20, maxTrialTokens: 20, maxSteps: 2, armCapMicrousd: 20, dailyTokenCap: 40,
    connection: 'secret://fixture/connection' }))
  let calls = 0, connectionProvider = 'fixture'
  const optionsSeen: { maxTokens: number | undefined; singleAttempt: boolean | undefined; runId: string }[] = []
  const result = { role: 'assistant' as const, api: 'openai-completions' as const, provider: 'fixture', model: 'fixture-metered',
    content: [{ type: 'text' as const, text: 'fixture reply' }], stopReason: 'stop' as const, timestamp: now.getTime(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  const k3 = {
    snapshot: () => ({ connections: [{ id: 'connection', kind: 'model_api', auth: 'api_key', provider: connectionProvider }] }) as ReturnType<TrialGatewayConfig['k3']['snapshot']>,
    async complete(account, connection, prepared, call) {
      assert.equal(account, 'owner'); assert.equal(connection, 'connection')
      assert.equal(call.model, 'fixture-metered')
      optionsSeen.push({ maxTokens: call.options?.maxTokens, singleAttempt: call.singleAttempt, runId: call.runId })
      call.onPrepared!(prepared)
      assert.equal(budget.requestRows().find(row => row.request_id === call.requestId)!.state, 'reserved')
      calls++
      return result
    },
  } satisfies TrialGatewayConfig['k3']
  const billing: BillingAdapter = {
    quote(_prepared, digest, outputTokenLimit): RequestQuote {
      const fact = { source: 'fixture:verified-billing-v1', confidence: 'verified' as const,
        observedAt: '2026-10-21T11:59:00Z', validUntil: '2026-10-21T12:01:00Z' }
      return { provider: 'fixture', model: 'fixture-metered', preparedSha256: digest, inputTokenBound: 5, outputTokenLimit,
        meter: { ...fact, format: 'provider-request-upper-bound' },
        price: { ...fact, currency: 'USD', inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 1_000_000, requestMicrousd: 0 } }
    },
    usage: () => ({ tokens: 2, costMicrousd: 2, source: 'fixture:verified-usage-v1', confidence: 'verified', observedAt: now.toISOString() }),
  }
  const config: TrialGatewayConfig = { budget, k3, accountId: 'owner', connectionId: 'connection', provider: 'fixture', model: 'fixture-metered',
    outputTokenLimit: 5, trial: { runId: 'test', task: 'task-0', arm: 'control', seed: 0 }, billing }
  return { budget, config, result, optionsSeen, calls: () => calls, changeProvider: () => { connectionProvider = 'changed' } }
}

test('both immutable trial gateways pin K3 dispatch parameters and settle independently within equal envelopes', async () => {
  const f = setup()
  try {
    const gateways = [createTrialGateway(f.config), createTrialGateway({ ...f.config, trial: { ...f.config.trial, arm: 'candidate' } })]
    f.config.model = 'mutated'; f.config.connectionId = 'mutated'; f.config.outputTokenLimit = 99; f.config.trial.task = 'mutated'
    const ids = new Set<string>()
    for (const gateway of gateways) {
      for (let i = 0; i < 2; i++) ids.add((await gateway.complete(context)).requestId)
      await assert.rejects(gateway.complete(context), /request_budget_exceeded/)
    }
    assert.equal(ids.size, 4); assert.equal(f.calls(), 4)
    assert.equal(f.optionsSeen.every(options => options.runId === 'test'), true)
    assert.equal(f.optionsSeen.length, 6)
    assert.equal(f.optionsSeen.every(options => options.maxTokens === 5 && options.singleAttempt === true), true)
    assert.deepEqual(f.budget.requestRows().map(row => row.state), ['settled', 'settled', 'settled', 'settled'])
    assert.equal(f.budget.rows()[0]!.dollars, 40)
  } finally { f.budget.close() }
})

test('unknown or invalid usage never treats K3 catalog/default zeros as verified billing', async () => {
  for (const observed of [null, { tokens: 0, costMicrousd: 0 },
    { tokens: 0, costMicrousd: 0, source: 'fixture:medium', confidence: 'medium', observedAt: now.toISOString() },
    { tokens: 0, costMicrousd: 0, source: 'fixture:future', confidence: 'verified', observedAt: '2026-10-21T13:00:00Z' }]) {
    const f = setup()
    try {
      f.config.billing.usage = () => observed as ReturnType<BillingAdapter['usage']>
      const gateway = createTrialGateway(f.config)
      await assert.rejects(gateway.complete(context), /gateway_usage_unknown|gateway_usage_invalid/)
      assert.equal(f.calls(), 1); assert.equal(f.budget.requestRows()[0]!.state, 'unknown')
      assert.equal(f.budget.requestRows()[0]!.cost, 10)
      await assert.rejects(gateway.complete(context), /request_trial_halted/)
      assert.equal(f.calls(), 1)
    } finally { f.budget.close() }
  }
})

test('provider failure after admission keeps the hold and halts without retrying or exposing the failure text', async () => {
  const f = setup()
  try {
    const original = f.config.k3.complete
    f.config.k3.complete = async (...args) => { await original(...args); throw new Error('fixture-private-provider-text') }
    const gateway = createTrialGateway(f.config)
    await assert.rejects(gateway.complete(context), error => error instanceof Error && error.message === 'gateway_model_failed')
    assert.equal(f.budget.requestRows()[0]!.state, 'unknown')
    await assert.rejects(gateway.complete(context), /request_trial_halted/)
    assert.equal(f.calls(), 1)
  } finally { f.budget.close() }
})

test('verified out-of-bound usage retains a breached hold and halts the trial', async () => {
  const f = setup()
  try {
    f.config.billing.usage = () => ({ tokens: 11, costMicrousd: 11, source: 'fixture:verified', confidence: 'verified', observedAt: now.toISOString() })
    const gateway = createTrialGateway(f.config)
    await assert.rejects(gateway.complete(context), /request_bound_violated/)
    assert.equal(f.budget.requestRows()[0]!.state, 'breached')
    await assert.rejects(gateway.complete(context), /request_trial_halted/)
    assert.equal(f.calls(), 1)
  } finally { f.budget.close() }
})

test('unknown quotes and changed connections refuse before provider dispatch or request debit', async () => {
  for (const kind of ['unknown', 'adapter-error', 'connection', 'snapshot-error']) {
    const f = setup()
    try {
      if (kind === 'unknown') f.config.billing.quote = () => null
      if (kind === 'adapter-error') f.config.billing.quote = () => { throw new Error('fixture-private-meter-text') }
      const gateway = createTrialGateway(f.config)
      if (kind === 'connection') f.changeProvider()
      if (kind === 'snapshot-error') f.config.k3.snapshot = () => { throw new Error('fixture-private-metadata-text') }
      await assert.rejects(gateway.complete(context), /request_quote_unknown|gateway_quote_failed|gateway_connection_mismatch/)
      assert.equal(f.calls(), 0); assert.equal(f.budget.requestRows().length, 0)
    } finally { f.budget.close() }
  }
})

test('abort before dispatch adds no hold; abort during dispatch retains unknown usage', async () => {
  for (const during of [false, true]) {
    const f = setup(), controller = new AbortController()
    try {
      if (during) {
        const original = f.config.k3.complete
        f.config.k3.complete = async (...args) => { const result = await original(...args); controller.abort(); return result }
      } else controller.abort(new Error('fixture-private-abort-text'))
      await assert.rejects(createTrialGateway(f.config).complete(context, controller.signal),
        error => error instanceof Error && error.message === (during ? 'gateway_model_failed' : 'gateway_cancelled'))
      assert.equal(f.calls(), during ? 1 : 0)
      assert.equal(f.budget.requestRows().length, during ? 1 : 0)
      if (during) assert.equal(f.budget.requestRows()[0]!.state, 'unknown')
    } finally { f.budget.close() }
  }
})

test('a mismatched response or missing prepared hook never returns an accepted completion', async () => {
  for (const kind of ['response', 'hook']) {
    const f = setup()
    try {
      if (kind === 'response') f.result.provider = 'different'
      else f.config.k3.complete = async () => f.result
      await assert.rejects(createTrialGateway(f.config).complete(context), /gateway_model_failed|gateway_prepared_hook_missing/)
      if (kind === 'response') assert.equal(f.budget.requestRows()[0]!.state, 'unknown')
      else assert.equal(f.budget.requestRows().length, 0)
    } finally { f.budget.close() }
  }
})


test('pre-dispatch attempt fence uses the R1 run id while the budget keeps the experiment id', async () => {
  const f = setup()
  try {
    const fences: string[] = []
    f.config.k3RunId = 'r1-run'
    f.config.attemptFence = { assert: () => { fences.push('assert') } }
    const gateway = createTrialGateway(f.config)
    await gateway.complete(context)
    assert.equal(f.calls(), 1)
    assert.deepEqual(fences, ['assert', 'assert'])
    assert.equal(f.optionsSeen[0]!.runId, 'r1-run')
    assert.equal(f.budget.requestRows()[0]!.run_id, 'test')
    assert.equal(f.budget.requestRows()[0]!.state, 'settled')
  } finally { f.budget.close() }
})

test('a stale attempt fence refuses before provider dispatch and again inside the prepared hook', async () => {
  for (const failAt of [1, 2]) {
    const f = setup()
    try {
      let fences = 0
      f.config.attemptFence = { assert: () => { fences++; if (fences === failAt) throw new Error('fixture-private-stale-lease') } }
      await assert.rejects(createTrialGateway(f.config).complete(context), { message: 'gateway_attempt_fenced' })
      assert.equal(f.calls(), 0)
      assert.equal(f.budget.requestRows().length, 0)
    } finally { f.budget.close() }
  }
})
