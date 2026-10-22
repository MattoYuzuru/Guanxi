import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RelayStartStatus } from '@guanxi/contract'
import { relayStartsChildReporter, relayStartsChildStarter } from '../../src/leads/children.ts'
import type { ChildLaunch } from '../../src/leads/types.ts'
import type { Attempt } from '../../src/runs/types.ts'
import { brief } from './brief.ts'

const attempt = { id: 'a', run_id: 'child-1' } as Attempt
const launch = (): ChildLaunch => ({ leadRunId: 'lead', childRunId: 'child-1', brief: brief(), attempt, previousAttempts: 0, ownerAccountId: 'o', actorAccountId: 'o', projectId: 'proj' })
const status = (value: RelayStartStatus['status'], runId: string | null = 'relay-run'): RelayStartStatus => ({ key: 'child-1', runId, sessionId: null, status: value,
  error: null, source: 'run-home', observedAt: new Date(0).toISOString(), confidence: 'observed', runtime: null, runtimeAgeMs: null, meter: null, reserves: null })

/** Fake public relay start: `script` is the sequence `status()` walks through after `start()` returns the first entry. */
function world(script: RelayStartStatus['status'][], extra: { statusError?: (n: number) => Error | null } = {}) {
  const calls: string[] = []
  const inputs: unknown[] = []
  let polls = 0
  const starts = {
    start: async (raw: unknown) => { calls.push('start'); inputs.push(raw); return status(script[0]!) },
    status: () => { const error = extra.statusError?.(polls); polls++; calls.push('status'); if (error) throw error; return status(script[Math.min(polls, script.length - 1)]!) },
    stop: async (key: string) => { calls.push(`stop:${key}`); return status('canceled') },
  }
  const runs = {
    complete: (_a: Attempt, outcome: string) => { calls.push(`complete:${outcome}`) },
    signal: (_a: Attempt, key: string) => { calls.push(`signal:${key}`) },
    renew: () => { calls.push('renew'); return { ttlMs: 1, expiresAt: 1 } },
    modelStarted: () => { calls.push('modelStarted') },
  }
  const starter = relayStartsChildStarter(starts as never, { consent: 'full-access', domains: ['example.test'], runs: runs as never, pollMs: 1, sleep: async () => undefined })
  return { calls, inputs, starter, starts }
}

test('the mirror starts the relay run with the owner policy, never the lead\'s, and keyed by the child id', async () => {
  const w = world(['preparing', 'running', 'completed'])
  await w.starter.start(launch()).done
  assert.deepEqual(w.inputs[0], { key: 'child-1', projectId: 'proj', connectionId: 'local-executor', model: 'qwen-fixture',
    consent: 'full-access', domains: ['example.test'], plan: brief().plan, caps: brief().caps })
  assert.deepEqual(w.calls.filter(c => c !== 'status'), ['start', 'renew', 'modelStarted', 'renew', 'complete:completed'])
})

test('the mirror escalates once when the relay run needs input and completes with the run\'s outcome', async () => {
  const w = world(['running', 'input_required', 'input_required', 'running', 'failed'])
  await w.starter.start(launch()).done
  assert.equal(w.calls.filter(c => c === 'signal:relay-input-required').length, 1)
  assert.equal(w.calls.filter(c => c === 'modelStarted').length, 1)
  assert.equal(w.calls.at(-1), 'complete:failed')
  for (const [final, outcome] of [['canceled', 'canceled'], ['interrupted', 'failed']] as const) {
    const other = world(['running', final])
    await other.starter.start(launch()).done
    assert.equal(other.calls.at(-1), `complete:${outcome}`, final)
  }
})

test('a lost or canceled mirror ends quietly, a vanished start fails it and a closed relay is waited out', async () => {
  const canceled = relayStartsChildStarter({ start: async () => status('running'), status: () => status('running'), stop: async () => status('canceled') } as never,
    { consent: 'full-access', runs: { complete: () => undefined, signal: () => undefined, modelStarted: () => undefined,
      renew: () => { throw Object.assign(new Error('x'), { code: 'stale_lease' }) } } as never, pollMs: 1, sleep: async () => undefined })
  await assert.doesNotReject(canceled.start(launch()).done)
  const vanished = world(['running', 'running'], { statusError: () => Object.assign(new Error('x'), { code: 'relay_not_found' }) })
  await assert.rejects(vanished.starter.start(launch()).done, { code: 'relay_not_found' })
  const closed = world(['running', 'running', 'completed'], { statusError: n => (n === 0 ? Object.assign(new Error('x'), { code: 'relay_closed' }) : null) })
  await closed.starter.start(launch()).done
  assert.equal(closed.calls.at(-1), 'complete:completed')
  const refused = relayStartsChildStarter({ start: async () => { throw Object.assign(new Error('x'), { code: 'runtime_meter_unavailable' }) }, status: () => status('running'), stop: async () => status('canceled') } as never,
    { consent: 'full-access', runs: {} as never, sleep: async () => undefined })
  await assert.rejects(refused.start(launch()).done, { code: 'runtime_meter_unavailable' })
})

test('stopping a child that never reached the relay is not an error, any other failure is', async () => {
  const absent = relayStartsChildStarter({ stop: async () => { throw Object.assign(new Error('x'), { code: 'relay_not_found' }) } } as never, { consent: 'full-access', runs: {} as never })
  await assert.doesNotReject(absent.stop('child-1'))
  const broken = relayStartsChildStarter({ stop: async () => { throw Object.assign(new Error('x'), { code: 'cleanup_unconfirmed' }) } } as never, { consent: 'full-access', runs: {} as never })
  await assert.rejects(broken.stop('child-1'), { code: 'cleanup_unconfirmed' })
  const w = world(['running'])
  await w.starter.stop('child-1')
  assert.equal(w.calls.at(-1), 'stop:child-1')
})

test('the reporter finds the relay run through the start key and reads only ledger facts for the current head', () => {
  const ledger = { plan: { items: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }] }, items: { t1: 'done', t2: 'open' }, head: 'h2',
    evidence: [{ item: 't1', head: 'h1', ok: true, output: 'stale' }, { item: 't1', head: 'h2', ok: true, output: 'fresh' }], diffstat: 'ds',
    proposals: ['ask'], cycle: 5, tokens: 77, moneyMicros: 9, unknownCosts: 1 }
  const reporter = relayStartsChildReporter(
    { status: key => { if (key === 'none') throw Object.assign(new Error('x'), { code: 'relay_not_found' }); return status('completed', key === 'preparing' ? null : 'relay-run') } },
    { read: id => { assert.equal(id, 'relay-run'); return ledger as never } })
  const report = reporter.report('child-1')!
  assert.deepEqual(report.gates, [{ item: 't1', ok: true, head: 'h2', output: 'fresh' }])
  assert.deepEqual(report.items, [{ id: 't1', title: 'One', status: 'done' }, { id: 't2', title: 'Two', status: 'open' }])
  assert.deepEqual(report.metrics, { cycles: 5, tokens: 77, moneyMicros: null }, 'unknown costs make money unknown, not zero')
  assert.deepEqual(report.handoff, { ref: 'relay:relay-run', cycle: 5 })
  assert.equal(reporter.report('none'), null)
  assert.equal(reporter.report('preparing'), null, 'a start without a run has no ledger yet')
})
