import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RelayStartStatus } from '@guanxi/contract'
import { relayStartsChildReporter, relayStartsChildStarter, type RelayStartsChildOptions } from '../../src/leads/children.ts'
import type { ChildLaunch } from '../../src/leads/types.ts'
import type { Attempt } from '../../src/runs/types.ts'
import { brief } from './brief.ts'

const attempt = { id: 'a', run_id: 'child-1' } as Attempt
const launch = (): ChildLaunch => ({ leadRunId: 'lead', childRunId: 'child-1', brief: brief(), attempt, previousAttempts: 0, ownerAccountId: 'o', actorAccountId: 'o', projectId: 'proj' })
const status = (value: RelayStartStatus['status'], runId: string | null = 'relay-run', sessionId: string | null = null): RelayStartStatus => ({ key: 'child-1', runId, sessionId, status: value,
  error: null, source: 'run-home', observedAt: new Date(0).toISOString(), confidence: 'observed', runtime: null, runtimeAgeMs: null, meter: null, reserves: null })
const coded = (code: string) => Object.assign(new Error(code), { code })

interface World { stopError?: () => Error | null; script: RelayStartStatus['status'][]; statusError?: (n: number) => Error | null; mirror?: () => string; startDelay?: number; startError?: Error; renewError?: () => Error | null }
/** Fake public relay start: `script[0]` is what `start()` returns, then `status()` walks the rest. */
function world(w: World, over: Partial<RelayStartsChildOptions> = {}) {
  const calls: string[] = []
  const inputs: unknown[] = []
  let polls = 0
  const starts = {
    start: async (raw: unknown) => { calls.push('start'); inputs.push(raw); if (w.startDelay) await new Promise(resolve => setTimeout(resolve, w.startDelay)); if (w.startError) throw w.startError; return status(w.script[0]!) },
    status: () => { const error = w.statusError?.(polls); polls++; calls.push('status'); if (polls > 400) throw new Error('runaway mirror: it never settled'); if (error) throw error; return status(w.script[Math.min(polls, w.script.length - 1)]!) },
    stop: async (key: string) => { calls.push(`stop:${key}`); const error = w.stopError?.(); if (error) throw error; return status('canceled') },
  }
  const runs = {
    complete: (_a: Attempt, outcome: string) => { calls.push(`complete:${outcome}`) },
    renew: () => { calls.push('renew'); const error = w.renewError?.(); if (error) throw error; return { ttlMs: 1, expiresAt: 1 } },
    get: () => ({ state: w.mirror?.() ?? 'working' }),
  }
  const starter = relayStartsChildStarter(starts as never, { consent: 'full-access', domains: ['example.test'], runs: runs as never, pollMs: 2, sleep: () => new Promise<void>(resolve => setImmediate(resolve)), ...over })
  return { calls, inputs, starter, quiet: () => calls.filter(call => call !== 'status' && call !== 'renew') }
}

test('the mirror starts the relay run with the owner policy, never the lead\'s, and keyed by the child id', async () => {
  const w = world({ script: ['preparing', 'running', 'completed'] })
  await w.starter.start(launch()).done
  assert.deepEqual(w.inputs[0], { key: 'child-1', projectId: 'proj', connectionId: 'local-executor', model: 'qwen-fixture',
    consent: 'full-access', domains: ['example.test'], plan: brief().plan, caps: brief().caps })
  assert.deepEqual(w.quiet(), ['start', 'complete:completed'], 'the mirror never records a model start: the relay run owns the work')
})

test('every settled relay status ends the mirror: finished runs complete it, everything else fails it exactly once', async () => {
  const expected = { completed: 'completed', canceled: 'canceled', failed: 'failed', interrupted: 'failed', wrapping_up: 'failed', input_required: 'failed' } as const
  for (const [final, outcome] of Object.entries(expected)) {
    const w = world({ script: ['running', final as RelayStartStatus['status']] })
    await w.starter.start(launch()).done
    assert.equal(w.calls.filter(call => call.startsWith('complete:')).length, 1, final)
    assert.equal(w.calls.at(-1), `complete:${outcome}`, final)
  }
  // A cap or a wall limit leaves the relay row `wrapping_up` for good: waiting for more would hang the lead.
  const capped = world({ script: ['running', 'running', 'wrapping_up'] })
  await capped.starter.start(launch()).done
  assert.equal(capped.calls.at(-1), 'complete:failed')
})

test('the R1 deadline wrap-up of the mirror stops the relay run once and the mirror then ends as canceled', async () => {
  let mirrorState = 'working'
  const w = world({ script: ['running', 'running', 'running', 'canceled'], mirror: () => mirrorState }, {
    sleep: async () => { mirrorState = 'wrapping_up'; await new Promise<void>(resolve => setImmediate(resolve)) } })
  await w.starter.start(launch()).done
  assert.equal(w.calls.filter(call => call === 'stop:child-1').length, 1, 'stopped once however long the wrap-up lasts')
  assert.equal(w.calls.at(-1), 'complete:canceled')
})

test('a refused deadline stop is retried until it goes through; an unreadable status stops the relay run before the mirror fails', async () => {
  let mirrorState = 'working'
  let refusals = 2
  const retried = world({ script: ['running', 'running', 'running', 'running', 'canceled'], mirror: () => mirrorState, stopError: () => (refusals-- > 0 ? coded('egress_not_ready') : null) },
    { sleep: async () => { mirrorState = 'wrapping_up'; await new Promise<void>(resolve => setImmediate(resolve)) } })
  await retried.starter.start(launch()).done
  assert.equal(retried.calls.filter(call => call === 'stop:child-1').length, 3, 'two refusals and then the stop that counted')
  assert.equal(retried.calls.at(-1), 'complete:canceled')
  const unreadable = world({ script: ['running', 'running'], statusError: () => new Error('unreadable') }, { maxStatusErrors: 1 })
  await assert.rejects(unreadable.starter.start(launch()).done, /unreadable/)
  assert.ok(unreadable.calls.includes('stop:child-1'), 'a Full-access run is never left unobserved and unstopped')
  const shutdown = world({ script: ['running'], startError: coded('relay_stopped'), mirror: () => 'working', statusError: () => coded('relay_closed') })
  await assert.doesNotReject(shutdown.starter.start(launch()).done)
  assert.ok(!shutdown.calls.some(call => call.startsWith('complete:')), 'a node shutdown during preparation is not a failure')
})

test('a lost lease, a start stopped by cancel and a closing relay end the mirror quietly; a vanished or unreadable start fails it', async () => {
  const handle = world({ script: ['running'], renewError: () => coded('stale_lease') })
  await assert.doesNotReject(handle.starter.start(launch()).done)
  assert.ok(!handle.calls.some(call => call.startsWith('complete:')), 'nothing is reported for a lost mirror')
  const canceled = world({ script: ['running'], startError: coded('relay_stopped'), mirror: () => 'canceled' })
  await assert.doesNotReject(canceled.starter.start(launch()).done)
  const refused = world({ script: ['running'], startError: coded('relay_stopped'), mirror: () => 'working' })
  await assert.rejects(refused.starter.start(launch()).done, { code: 'relay_stopped' }, 'a stop nobody asked for is a failure')
  const closing = world({ script: ['running', 'running'], statusError: () => coded('relay_closed') })
  await assert.doesNotReject(closing.starter.start(launch()).done)
  assert.ok(!closing.calls.some(call => call.startsWith('complete:')))
  const vanished = world({ script: ['running', 'running'], statusError: () => coded('relay_not_found') })
  await assert.rejects(vanished.starter.start(launch()).done, { code: 'relay_not_found' })
  const flaky = world({ script: ['running', 'running', 'completed'], statusError: n => (n === 0 || n === 1 ? new Error('transient') : null) })
  await flaky.starter.start(launch()).done
  assert.equal(flaky.calls.at(-1), 'complete:completed')
  const broken = world({ script: ['running', 'running'], statusError: () => new Error('unreadable') }, { maxStatusErrors: 2 })
  await assert.rejects(broken.starter.start(launch()).done, /unreadable/)
  const unavailable = world({ script: ['running'], startError: coded('runtime_meter_unavailable') })
  await assert.rejects(unavailable.starter.start(launch()).done, { code: 'runtime_meter_unavailable' })
})

test('the mirror\'s lease is renewed while the relay run is still preparing', async () => {
  const w = world({ script: ['running', 'completed'], startDelay: 60 })
  await w.starter.start(launch()).done
  const renewsBeforeStatus = w.calls.slice(0, w.calls.indexOf('status')).filter(call => call === 'renew').length
  assert.ok(renewsBeforeStatus >= 3, `${renewsBeforeStatus} renewals during a 60 ms preparation at a 2 ms interval`)
})

test('an unsafe poll interval is refused when the adapter is built', () => {
  for (const pollMs of [0, -1, 1.5, 30_001]) assert.throws(() => world({ script: ['running'] }, { pollMs }), { code: 'invalid_input' }, String(pollMs))
})

test('stopping a child that never reached the relay is not an error, any other failure is', async () => {
  const absent = relayStartsChildStarter({ stop: async () => { throw coded('relay_not_found') } } as never, { consent: 'full-access', runs: {} as never })
  await assert.doesNotReject(absent.stop('child-1'))
  const broken = relayStartsChildStarter({ stop: async () => { throw coded('cleanup_unconfirmed') } } as never, { consent: 'full-access', runs: {} as never })
  await assert.rejects(broken.stop('child-1'), { code: 'cleanup_unconfirmed' })
  const w = world({ script: ['running'] })
  await w.starter.stop('child-1')
  assert.equal(w.calls.at(-1), 'stop:child-1')
})

test('the reporter finds the relay run through the start key, reads only ledger facts for the current head and names the relay status', () => {
  const ledger = { plan: { items: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }] }, items: { t1: 'done', t2: 'open' }, head: 'h2',
    evidence: [{ item: 't1', head: 'h1', ok: true, output: 'stale' }, { item: 't1', head: 'h2', ok: true, output: 'fresh' }], diffstat: 'ds',
    proposals: ['ask'], cycle: 5, tokens: 77, moneyMicros: 9, unknownCosts: 1 }
  const reporter = relayStartsChildReporter(
    { status: key => { if (key === 'none') throw coded('relay_not_found'); return status('wrapping_up', key === 'preparing' ? null : 'relay-run') } },
    { read: id => { assert.equal(id, 'relay-run'); return ledger as never } })
  const report = reporter.report('child-1')!
  assert.deepEqual(report.gates, [{ item: 't1', ok: true, head: 'h2', output: 'fresh' }])
  assert.deepEqual(report.items, [{ id: 't1', title: 'One', status: 'done' }, { id: 't2', title: 'Two', status: 'open' }])
  assert.deepEqual(report.metrics, { cycles: 5, tokens: 77, moneyMicros: null }, 'unknown costs make money unknown, not zero')
  assert.deepEqual(report.handoff, { ref: 'relay:relay-run', cycle: 5 })
  assert.equal(report.narrative, 'relay run status: wrapping_up')
  assert.equal(reporter.report('none'), null)
  assert.equal(reporter.report('preparing'), null, 'a start without a run has no ledger yet')
})

test('the report holds one gate result per item for the current head: the newest, in plan order, and a failure is not hidden by an older pass', () => {
  const ledger = { plan: { items: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }, { id: 't3', title: 'Three' }] }, items: { t1: 'done', t2: 'done', t3: 'verification_requested' }, head: 'h2',
    // The relay verifies, then re-verifies every item when the plan closes: its evidence is an append-only log of gate runs. The first
    // evidence of t2 precedes the first of t1, so plan order and arrival order differ; t3 passed once and then failed; t1 has a stale head.
    evidence: [{ item: 't2', head: 'h2', ok: true, output: 'first t2' }, { item: 't1', head: 'h1', ok: true, output: 'old head t1' }, { item: 't1', head: 'h2', ok: true, output: 'first t1' },
      { item: 't3', head: 'h2', ok: true, output: 'pass t3' }, { item: 't2', head: 'h2', ok: false, output: 'flaky t2' }, { item: 't1', head: 'h2', ok: true, output: 'final t1' },
      { item: 't2', head: 'h2', ok: true, output: 'final t2' }, { item: 't3', head: 'h2', ok: false, output: 'fail t3' }],
    diffstat: '', proposals: [], cycle: 2, tokens: 1, moneyMicros: 0, unknownCosts: 0 }
  const report = relayStartsChildReporter({ status: () => status('completed') }, { read: () => ledger as never }).report('child-1')!
  assert.deepEqual(report.gates, [{ item: 't1', ok: true, head: 'h2', output: 'final t1' }, { item: 't2', ok: true, head: 'h2', output: 'final t2' }, { item: 't3', ok: false, head: 'h2', output: 'fail t3' }])
})

const stopLedger = { plan: { items: [{ id: 't1', title: 'One' }] }, items: { t1: 'open' }, head: 'h1', evidence: [], diffstat: '', proposals: [], cycle: 1,
  tokens: 0, moneyMicros: 0, unknownCosts: 0 }
const note = (value: Record<string, unknown>, jobId = 'relay-run') => ({ type: 'agent.note', jobId, data: { text: JSON.stringify(value) } })
const error = (code: string, message = 'PRIVATE relay message', jobId = 'relay-run') => ({ type: 'error', jobId, data: { code, message } })

test('the report carries the relay stop reason from the fixed codes in its own session log', () => {
  const events = [error('provider_failed'), error('model_failed'),
    note({ relay: 'call_failed_reason', purpose: 'work', reason: 'runtime_meter_unavailable', message: 'PRIVATE note text' })]
  const reporter = relayStartsChildReporter(
    { status: () => status('input_required', 'relay-run', 'relay-session') },
    { read: () => stopLedger as never },
    { readAll: (id, audience) => { assert.equal(id, 'relay-session'); assert.equal(audience, 'person'); return events as never } })
  const report = reporter.report('child-1')!
  assert.equal(report.narrative, 'relay run status: input_required; stopped: model_failed (work call: runtime_meter_unavailable)')
  assert.equal(report.narrative.includes('PRIVATE'), false, 'free text is never copied')
  // The last fixed code is the stop reason: an earlier failure is not repeated.
  assert.equal(report.narrative.includes('provider_failed'), false)
})

test('a child run\'s error code is not reported as the relay\'s', () => {
  const reporter = relayStartsChildReporter(
    { status: () => status('input_required', 'relay-run', 'relay-session') },
    { read: () => stopLedger as never },
    { readAll: () => [error('model_failed'), error('child_failed', 'PRIVATE child message', 'rc-child'),
      note({ relay: 'call_failed_reason', purpose: 'work', reason: 'runtime_meter_unavailable' }),
      note({ relay: 'call_failed_reason', purpose: 'work', reason: 'child_reason' }, 'rc-child')] as never })
  const report = reporter.report('child-1')!
  assert.equal(report.narrative, 'relay run status: input_required; stopped: model_failed (work call: runtime_meter_unavailable)')
  assert.equal(report.narrative.includes('child_failed'), false)
  assert.equal(report.narrative.includes('child_reason'), false)
})

test('wrapping_up is a working state, not a stop: no stop facts are attached', () => {
  const reporter = relayStartsChildReporter(
    { status: () => status('wrapping_up', 'relay-run', 'relay-session') },
    { read: () => stopLedger as never },
    { readAll: () => [error('model_failed'), note({ relay: 'call_failed_reason', purpose: 'work', reason: 'runtime_meter_unavailable' })] as never })
  assert.equal(reporter.report('child-1')!.narrative, 'relay run status: wrapping_up')
})

test('a call_failed_reason note whose purpose or reason is not a fixed code is not copied', () => {
  for (const invalid of [{ relay: 'call_failed_reason', purpose: 'work/main', reason: 'runtime_meter_unavailable' },
    { relay: 'call_failed_reason', purpose: 'work', reason: 'runtime meter unavailable' }]) {
    const reporter = relayStartsChildReporter(
      { status: () => status('input_required', 'relay-run', 'relay-session') },
      { read: () => stopLedger as never },
      { readAll: () => [error('model_failed'), note(invalid)] as never })
    assert.equal(reporter.report('child-1')!.narrative, 'relay run status: input_required; stopped: model_failed', JSON.stringify(invalid))
  }
  const unknown = relayStartsChildReporter(
    { status: () => status('input_required', 'relay-run', 'relay-session') },
    { read: () => stopLedger as never },
    { readAll: () => [note({ relay: 'call_failed_reason', purpose: 'work/main', reason: 'runtime/meter' })] as never })
  assert.equal(unknown.report('child-1')!.narrative, 'relay run status: input_required', 'nothing known keeps the old narrative')
})
