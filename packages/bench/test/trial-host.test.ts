import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connections } from '../../server/src/connections/service.ts'
import { runFixture } from '../../server/test/fixtures/durable-runs.ts'
import { Budget } from '../src/budget.ts'
import type { BillingAdapter } from '../src/k3-gateway.ts'
import type { RequestQuote } from '../src/request-admission.ts'
import type { RetentionPolicy } from '../src/k2-retention.ts'
import { createTrialBinding } from '../src/trial-binding.ts'
import { createBoundTrialHost } from '../src/trial-host.ts'
import { plan } from './helpers.ts'

type CompletionResult = Awaited<ReturnType<Connections['complete']>>
const now = new Date('2026-10-21T12:00:00Z')
const context = { messages: [{ role: 'user' as const, content: 'fixture', timestamp: now.getTime() }] }
const policy: RetentionPolicy = {
  maximumRetainedBytes: 8_192, maximumReasoningTextBytes: 2_048,
  maximumSignatureBytes: 2_048, maximumAssistantTextBytes: 2_048,
  maximumToolCalls: 4, maximumToolArgumentBytes: 1_024,
}

test('production host factory separates experiment ledger from R1 run, fences renew and retains the authoritative projection', async () => {
  const f = runFixture()
  const budget = new Budget(':memory:', () => now)
  try {
    budget.reserve(plan({ id: 'fixture-experiment', tasks: plan().tasks.slice(0, 1),
      provider: 'fixture', model: 'fixture-metered', maxTrialMicrousd: 20, maxTrialTokens: 20,
      maxSteps: 2, armCapMicrousd: 20, dailyTokenCap: 40, connection: 'secret://fixture/connection' }))
    const run = f.store.create({ id: 'r1-run', sessionId: 'r1-session' })
    const attempt = f.store.start(run.id)
    f.store.modelStarted(attempt)
    const binding = createTrialBinding({
      experimentId: 'fixture-experiment', taskId: 'task-0', armId: 'control', seed: 0,
      runId: run.id, attemptId: attempt.id, sessionId: run.session_id,
      accountId: 'owner', connectionId: 'connection', provider: 'fixture',
      model: 'fixture-metered', modelApi: 'openai-completions', outputTokenLimit: 5,
      toolSource: 'builtin', attempt,
    })
    const result: CompletionResult = {
      role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture-metered',
      content: [{ type: 'thinking', thinking: 'host private reasoning', thinkingSignature: 'host-private-signature' },
        { type: 'text', text: 'host public reply' },
        { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } }],
      stopReason: 'toolUse', timestamp: now.getTime(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    const runIds: string[] = []
    const k3 = {
      snapshot: () => ({ connections: [{ id: 'connection', kind: 'model_api', auth: 'api_key', provider: 'fixture' }] }) as
        ReturnType<NonNullable<unknown> & (() => never)>,
      async complete(_account: string, _connection: string, prepared: typeof context, call: {
        runId: string; requestId: string; onPrepared?: (value: unknown) => void
      }) {
        runIds.push(call.runId)
        call.onPrepared?.(prepared)
        return result
      },
    }
    const fact = { source: 'fixture:verified-billing-v1', confidence: 'verified' as const,
      observedAt: '2026-10-21T11:59:00Z', validUntil: '2026-10-21T12:01:00Z' }
    const billing: BillingAdapter = {
      quote(_prepared, digest, outputTokenLimit): RequestQuote {
        return { provider: 'fixture', model: 'fixture-metered', preparedSha256: digest,
          inputTokenBound: 5, outputTokenLimit,
          meter: { ...fact, format: 'provider-request-upper-bound' },
          price: { ...fact, currency: 'USD', inputMicrousdPerMillion: 1_000_000,
            outputMicrousdPerMillion: 1_000_000, requestMicrousd: 0 } }
      },
      usage: () => ({ tokens: 2, costMicrousd: 2, source: 'fixture:verified-usage-v1',
        confidence: 'verified', observedAt: now.toISOString() }),
    }
    let renews = 0
    const runs = {
      get: f.store.get.bind(f.store),
      append: f.store.append.bind(f.store),
      renew: (value: typeof attempt) => { renews++; f.store.renew(value) },
    }
    const bound = createBoundTrialHost({
      binding, attempt, budget, k3: k3 as never, billing, runs, session: f.log,
      scrubber: f.scrubber, retentionPolicy: policy,
    })
    const completed = await bound.host.gateway.complete(context)
    assert.deepEqual(runIds, ['r1-run'])
    assert.equal(renews, 2, 'the pre-dispatch and prepared-hook fences renew the same R1 attempt')
    assert.equal(budget.requestRows()[0]!.run_id, 'fixture-experiment')
    assert.equal(budget.requestRows()[0]!.state, 'settled')
    const projection = await bound.host.retainAndProject(completed.requestId, completed.result)
    assert.deepEqual(projection, { text: 'host public reply', stopReason: 'toolUse',
      toolCalls: [{ id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } }] })
    const events = f.log.readAll(run.session_id, 'person')
    assert.equal(events.some(event => event.type === 'reasoning'), true)
    assert.equal(events.some(event => event.type === 'assistant.message' &&
      (event.data as { text: string }).text === projection.text), true)
    assert.equal(events.some(event => event.type === 'tool.call' &&
      (event.data as { toolCallId: string }).toolCallId === 'tool-1'), true)
    assert.throws(() => createBoundTrialHost({
      binding: { ...binding, sessionId: 'foreign-session' }, attempt, budget, k3: k3 as never, billing,
      runs, session: f.log, scrubber: f.scrubber, retentionPolicy: policy,
    }), /binding_session_mismatch/)
  } finally { budget.close(); f.close() }
})
