import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relayChildReporter, relayChildStarter } from '../../src/leads/children.ts'
import type { ChildLaunch } from '../../src/leads/types.ts'
import type { Attempt } from '../../src/runs/types.ts'
import { brief } from './brief.ts'

const attempt = { id: 'a', run_id: 'child' } as Attempt
const launch = (previousAttempts = 0): ChildLaunch => ({ leadRunId: 'lead', childRunId: 'child', brief: brief(), attempt, previousAttempts,
  ownerAccountId: 'o', actorAccountId: 'o', projectId: 'p' })
function relay(options: { hasLedger?: boolean } = {}) {
  const calls: string[] = []
  return { calls, relay: {
    init: (_a: Attempt, plan: unknown, caps: unknown) => { calls.push(`init:${JSON.stringify(plan) === JSON.stringify(brief().plan)}:${JSON.stringify(caps) === JSON.stringify(brief().caps)}`) },
    recover: () => { calls.push('recover') },
    read: () => { if (options.hasLedger === false) throw new Error('relay_not_found'); return {} as never },
    execute: async (_a: Attempt, input: unknown) => { calls.push(`execute:${(input as { model: string }).model}`); return {} as never },
    stop: (id: string) => { calls.push(`stop:${id}`) },
  } }
}

test('the relay starter initializes a fresh child from the validated brief and executes with the host input', async () => {
  const { calls, relay: fake } = relay()
  const starter = relayChildStarter(fake as never, { prepare: async l => ({ model: l.brief.executor.model }) as never })
  await starter.start(launch()).done
  assert.deepEqual(calls, ['init:true:true', 'execute:qwen-fixture'])
  starter.stop('child')
  assert.equal(calls.at(-1), 'stop:child')
})

test('a restarted child recovers its ledger, or initializes when the kill left none', async () => {
  const withLedger = relay()
  await relayChildStarter(withLedger.relay as never, { prepare: async () => ({ model: 'm' }) as never }).start(launch(1)).done
  assert.deepEqual(withLedger.calls, ['recover', 'execute:m'])
  const without = relay({ hasLedger: false })
  await relayChildStarter(without.relay as never, { prepare: async () => ({ model: 'm' }) as never }).start(launch(1)).done
  assert.deepEqual(without.calls, ['init:true:true', 'execute:m'])
})

test('a host that cannot prepare a workspace fails the child instead of hanging the lead', async () => {
  const { calls, relay: fake } = relay()
  const starter = relayChildStarter(fake as never, { prepare: async () => { throw Object.assign(new Error('x'), { code: 'relay_workspace_unavailable' }) } })
  await assert.rejects(starter.start(launch()).done, { code: 'relay_workspace_unavailable' })
  assert.ok(!calls.some(call => call.startsWith('execute')))
})

test('the reporter reads only ledger facts for the current head and reports unknown money honestly', () => {
  const ledger = { plan: { items: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }] }, items: { t1: 'done', t2: 'open' }, head: 'h2',
    evidence: [{ item: 't1', head: 'h1', ok: true, output: 'stale' }, { item: 't1', head: 'h2', ok: true, output: 'fresh' }], diffstat: 'ds',
    proposals: ['ask'], cycle: 5, tokens: 77, moneyMicros: 9, unknownCosts: 1 }
  const reporter = relayChildReporter({ read: id => { if (id === 'none') throw new Error('relay_not_found'); return ledger as never } })
  const report = reporter.report('child')!
  assert.deepEqual(report.gates, [{ item: 't1', ok: true, head: 'h2', output: 'fresh' }])
  assert.deepEqual(report.items, [{ id: 't1', title: 'One', status: 'done' }, { id: 't2', title: 'Two', status: 'open' }])
  assert.deepEqual(report.metrics, { cycles: 5, tokens: 77, moneyMicros: null })
  assert.deepEqual(report.handoff, { ref: 'relay:child', cycle: 5 })
  assert.equal(reporter.report('none'), null)
})
