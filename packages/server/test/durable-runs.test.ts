import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RUN_A2A_STATE, runStateSchema } from '@guanxi/contract'
import { RunError } from '../src/runs/types.ts'
import { RunStore } from '../src/runs/store.ts'
import { bootServerKernel, LEGACY_SERVER_PROFILE } from '../src/runtime/kernel.ts'
import { runFixture, RUN_TIME, RUN_DEADLINE } from './fixtures/durable-runs.ts'

function delegated(f: ReturnType<typeof runFixture>, options = {}) {
  const lead = f.store.create({ id: 'lead' })
  const attempt = f.store.start(lead.id)
  f.store.modelStarted(attempt)
  const promise = f.store.delegate(attempt, { key: 'delegation', deadline: RUN_DEADLINE, ...options })
  return { lead, attempt, promise }
}
function count(f: ReturnType<typeof runFixture>, action: string, runId = 'lead'): number {
  return f.log.read('lead', { audience: 'person' }).events.filter((e) =>
    e.type === 'run.lifecycle' && e.data.action === action && e.data.runId === runId).length
}
function code(expected: RunError['code']) { return (error: unknown) => error instanceof RunError && error.code === expected }

test('all run states have the ADR-0019 A2A mapping', () => {
  assert.deepEqual(Object.keys(RUN_A2A_STATE), runStateSchema.options)
  assert.equal(RUN_A2A_STATE.waiting_children, 'working')
  assert.equal(RUN_A2A_STATE.wrapping_up, 'working')
  assert.equal(RUN_A2A_STATE.input_required, 'input-required')
  assert.equal(RUN_A2A_STATE.interrupted, 'failed')
})

test('deadline wakes a lead whose child never starts; wrap-up cancels after its report', (t) => {
  const f = runFixture(); let cleanup = () => {}; t.after(() => { cleanup(); f.close() })
  const { promise } = delegated(f)
  f.setTime(RUN_DEADLINE)
  // A home returning after sleep obtains its lease again; timers persisted while down.
  f.store.close()
  const store = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, alwaysOn: true, clock: () => RUN_DEADLINE })
  cleanup = () => store.close()
  store.heartbeat(); store.reconcile(); store.tick()
  assert.equal(store.promises('lead')[0]!.outcome, 'deadline')
  assert.equal(store.wakes('lead').length, 1)
  assert.equal(store.get(promise.child_id).state, 'wrapping_up')
  const report = store.start(promise.child_id)
  assert.equal(store.get(promise.child_id).state, 'wrapping_up')
  store.complete(report, 'completed')
  assert.equal(store.get(promise.child_id).state, 'canceled')
  assert.equal(store.get(promise.child_id).cancel_count, 1)
  const delivery = store.deliver('lead', 1)!
  assert.equal(store.wakes('lead')[0]!.acknowledged_at, null)
  store.modelStarted(delivery); store.modelStarted(delivery)
  assert.equal(store.wakes('lead').filter((w) => w.acknowledged_at !== null).length, 1)
  assert.equal(count(f, 'resolved'), 1)
  assert.equal(count(f, 'acknowledged'), 1)
})

test('expired completion is 409 stale_lease and produces zero resolutions or wakes', (t) => {
  const f = runFixture(); t.after(f.close)
  const { promise } = delegated(f)
  const child = f.store.start(promise.child_id)
  f.store.renew(child, 10)
  f.setTime(RUN_TIME + 11)
  assert.throws(() => f.store.complete(child, 'completed'), code('stale_lease'))
  assert.equal(new RunError('stale_lease').status, 409)
  assert.equal(f.store.wakes('lead').length, 0)
  assert.equal(count(f, 'resolved'), 0)
  assert.equal(f.store.promises('lead')[0]!.outcome, null)
  f.store.reconcile()
  const replacement = f.store.start(promise.child_id)
  assert.ok(replacement.token > child.token)
  assert.throws(() => f.store.complete(child, 'completed'), code('stale_lease'))
  f.store.complete(replacement, 'completed')
  assert.equal(f.store.wakes('lead').length, 1)
})

test('escalation then completion produces exactly two wakes and one resolution', (t) => {
  const f = runFixture(); t.after(f.close)
  const { promise } = delegated(f)
  const child = f.store.start(promise.child_id)
  f.store.signal(child, 'question'); f.store.signal(child, 'question')
  assert.equal(f.store.promises('lead')[0]!.outcome, null)
  assert.equal(count(f, 'signal', promise.child_id), 1)
  const first = f.store.deliver('lead', 1)!
  assert.equal(f.store.deliver('lead', 1)!.id, first.id)
  f.store.modelStarted(first)
  f.store.hibernate(first)
  f.store.complete(child, 'completed')
  const second = f.store.deliver('lead', 2)!
  f.store.modelStarted(second)
  assert.equal(f.store.wakes('lead').length, 2)
  assert.equal(f.store.wakes('lead').filter((w) => w.acknowledged_at !== null).length, 2)
  assert.equal(count(f, 'resolved'), 1)
  assert.equal(count(f, 'acknowledged'), 2)
  assert.notEqual(first.id, second.id)
})

test('completion and deadline first-commit-wins in either order', (t) => {
  for (const winner of ['completion', 'deadline']) {
    const f = runFixture(); t.after(f.close)
    const { promise } = delegated(f)
    const child = f.store.start(promise.child_id)
    if (winner === 'completion') f.store.complete(child, 'completed')
    f.setTime(RUN_TIME + 1)
    // Set the timer due without expiring execution/home leases.
    f.db.prepare('UPDATE timers SET due_at=?').run(RUN_TIME + 1)
    f.store.tick()
    if (winner === 'deadline') f.store.complete(child, 'completed')
    assert.equal(count(f, 'resolved'), 1)
    assert.equal(f.store.wakes('lead').length, 1)
    assert.equal(f.store.promises('lead')[0]!.outcome, winner === 'completion' ? 'completed' : 'deadline')
  }
})

test('retained worktree survives eight hours of hibernation with zero token or executor growth', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-r1-resources-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const f = runFixture(join(root, 'node.db')); let cleanup = () => {}; t.after(() => { cleanup(); f.close() })
  const lead = f.store.create({ id: 'lead' })
  const attempt = f.store.start(lead.id); f.store.modelStarted(attempt)
  const worktree = join(root, 'worktree'); mkdirSync(worktree); writeFileSync(join(worktree, 'kept'), 'fixture')
  f.store.retain(attempt, { key: 'worktree', kind: 'worktree', retainUntil: RUN_TIME + 1 })
  f.store.recordCost(attempt, { key: 'before_sleep', inputTokens: 4, outputTokens: 2, costMicrounits: null, currency: 'unknown' })
  f.store.delegate(attempt, { key: 'long', deadline: RUN_TIME + 12 * 3_600_000 })
  const before = f.store.costs(lead.id)
  f.store.close()
  const store = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, alwaysOn: true, clock: () => RUN_TIME + 8 * 3_600_000 })
  cleanup = () => store.close(); store.heartbeat(); store.reconcile()
  for (const key of store.reapResources()) { if (key === 'resource:worktree') rmSync(worktree, { recursive: true }) }
  assert.equal(existsSync(worktree), true)
  assert.equal(readFileSync(join(worktree, 'kept'), 'utf8'), 'fixture')
  assert.equal(store.get(lead.id).state, 'waiting_children')
  assert.equal(store.attempts(lead.id).length, 1)
  assert.deepEqual(store.costs(lead.id), before)
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE key='run:lead/exec' AND released=0").get() as { n: number }).n, 0)
  assert.equal((f.db.prepare("SELECT holder FROM leases WHERE key='resource:worktree'").get() as { holder: string }).holder, lead.id)
  store.cancel(lead.id)
  assert.deepEqual(store.reapResources(), ['resource:worktree'])
  assert.deepEqual(store.reapResources(), [])
})

test('cancel hibernating lead cascades to children and grandchildren exactly once, across retries', (t) => {
  const f = runFixture(); t.after(f.close)
  const { promise } = delegated(f)
  const child = f.store.start(promise.child_id)
  const grandchild = f.store.delegate(child, { key: 'grandchild', deadline: RUN_DEADLINE })
  f.store.cancel('lead'); f.store.cancel('lead'); f.store.tick(); f.store.reconcile()
  for (const id of ['lead', promise.child_id, grandchild.child_id]) {
    assert.equal(f.store.get(id).state, 'canceled')
    assert.equal(f.store.get(id).cancel_count, 1)
    assert.equal(count(f, 'canceled', id), 1)
  }
  assert.equal(f.store.wakes('lead').length, 0)
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE state='pending'").get() as { n: number }).n, 0)
})

test('detach policies stop propagation; detached completion wakes nobody', (t) => {
  for (const mode of ['deadline', 'cancel']) {
    const f = runFixture(); t.after(f.close)
    const { promise } = delegated(f, { deadlinePolicy: 'detach', cancelPolicy: 'detach' })
    const child = f.store.start(promise.child_id)
    if (mode === 'cancel') f.store.cancel('lead')
    else { f.db.prepare('UPDATE timers SET due_at=?').run(RUN_TIME); f.store.tick() }
    assert.equal(f.store.get(promise.child_id).state, 'working')
    f.store.complete(child, 'completed')
    assert.equal(f.store.wakes('lead').length, mode === 'cancel' ? 0 : 1)
    assert.equal(f.store.promises('lead')[0]!.detached, 1)
  }
})

test('restart table preserves wait/input/report, interrupts local work and redelivers only unacknowledged wakes', (t) => {
  const f = runFixture(); t.after(f.close)
  const { promise } = delegated(f)
  const input = f.store.create({ id: 'input' }); const ia = f.store.start(input.id); f.store.inputRequired(ia)
  const report = f.store.create({ id: 'report' }); const ra = f.store.start(report.id); f.store.wrappingUp(ra)
  const working = f.store.create({ id: 'working' }); f.store.start(working.id)
  f.store.reconcile()
  assert.equal(f.store.get('lead').state, 'waiting_children')
  assert.equal(f.store.get('input').state, 'input_required')
  assert.equal(f.store.get('report').state, 'wrapping_up')
  assert.equal(f.store.get('working').state, 'interrupted')
  assert.equal(f.store.attempts('working')[0]!.state, 'lost')
  const child = f.store.start(promise.child_id); f.store.complete(child, 'completed')
  const delivered = f.store.deliver('lead', 1)!
  f.store.reconcile()
  const retried = f.store.deliver('lead', 1)!
  assert.notEqual(retried.id, delivered.id)
  assert.ok(retried.token > delivered.token)
  assert.throws(() => f.store.modelStarted(delivered), code('stale_lease'))
  f.store.modelStarted(retried); f.store.reconcile()
  assert.equal(f.store.deliver('lead', 1), null)
  assert.equal(count(f, 'acknowledged'), 1)
})

test('single writer fails closed on takeover and expired owner, no plain restart epoch bump', (t) => {
  const f = runFixture(); let cleanup = () => {}; t.after(() => { cleanup(); f.close() })
  assert.throws(() => new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => RUN_TIME }).heartbeat(), code('writer_busy'))
  f.setTime(RUN_TIME + 30_001)
  assert.throws(() => f.store.create(), code('stale_lease'))
  assert.throws(() => new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => RUN_TIME + 60_000 }).heartbeat(), code('writer_busy'))
  const next = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => RUN_TIME + 91_001 })
  next.heartbeat()
  cleanup = () => next.close()
  assert.throws(() => f.store.create(), code('stale_lease'))
  assert.equal((f.db.prepare("SELECT epoch FROM leases WHERE key='durable-runs/home'").get() as { epoch: number }).epoch, 1)
})

test('cost ledger deduplicates exact observations, rejects conflicts, keeps unknown costs and currencies separate', (t) => {
  const f = runFixture(); t.after(f.close)
  const run = f.store.create(); const a = f.store.start(run.id)
  const cost = { key: 'call', inputTokens: 10, outputTokens: 20, costMicrounits: 30, currency: 'USD' as const }
  f.store.recordCost(a, cost); f.store.recordCost(a, cost)
  assert.throws(() => f.store.recordCost(a, { ...cost, outputTokens: 21 }), code('idempotency_conflict'))
  f.store.recordCost(a, { ...cost, key: 'unknown', costMicrounits: null })
  f.store.recordCost(a, { ...cost, key: 'euros', currency: 'EUR' })
  assert.deepEqual(f.store.costs(run.id), [
    { currency: 'EUR', inputTokens: 10, outputTokens: 20, costMicrounits: 30 },
    { currency: 'USD', inputTokens: 20, outputTokens: 40, costMicrounits: null },
  ])
})

test('readiness and refused trace writes roll back the entire delegation; no secret reaches run tables', (t) => {
  const f = runFixture(); t.after(f.close)
  const lead = f.store.create({ id: 'lead' }); const a = f.store.start(lead.id)
  f.scrubber.register('secret://fixture', 'sensitive-fixture')
  assert.throws(() => f.store.delegate(a, { key: 'sensitive-fixture', deadline: RUN_DEADLINE }), code('invalid_input'))
  f.scrubber.expect('vault')
  assert.throws(() => f.store.delegate(a, { key: 'safe', deadline: RUN_DEADLINE }))
  assert.equal(f.store.promises('lead').length, 0)
  assert.equal(f.store.get('lead').state, 'working')
  for (const table of ['durable_runs', 'run_attempts', 'promises', 'outbox', 'run_costs', 'session_events']) {
    assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()).includes('sensitive-fixture'), false)
  }
  f.scrubber.ready('vault')
  f.store.delegate(a, { key: 'safe', deadline: RUN_DEADLINE })
  assert.equal(f.store.promises('lead').length, 1)
})

test('delegation requires an explicitly always-on home', (t) => {
  const f = runFixture(':memory:', { alwaysOn: false }); t.after(f.close)
  const lead = f.store.create(); const a = f.store.start(lead.id)
  assert.throws(() => f.store.delegate(a, { key: 'child', deadline: RUN_DEADLINE }), code('no_always_on_home'))
  assert.equal(f.store.get(lead.id).state, 'working')
  assert.equal(f.store.promises(lead.id).length, 0)
})

test('kernel boots R1 with K2, ticks deadlines, exposes health and releases its writer on unload', async (t) => {
  const f = runFixture(); f.store.close(); f.log.close(); t.after(() => { f.db.close(); f.scrubber.close() })
  const kernel = await bootServerKernel(undefined, { db: f.db, sessionLog: { clock: () => new Date(RUN_TIME) },
    runs: { alwaysOn: true, clock: () => RUN_TIME, tickMs: 5 } })
  kernel.scrubber.ready('vault')
  const store = kernel.durableRuns!.store
  const run = store.create(); const a = store.start(run.id)
  store.delegate(a, { key: 'due', deadline: RUN_TIME })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(store.wakes(run.id).length, 1)
  assert.ok(store.wakes(run.id)[0]!.attempt_id)
  assert.equal(store.wakes(run.id)[0]!.acknowledged_at, null)
  assert.deepEqual(kernel.durableRuns!.health(), { failure: null })
  await kernel.node.dispose()
  assert.throws(() => store.create(), code('closed'))
  assert.equal((f.db.prepare("SELECT released FROM leases WHERE key='durable-runs/home'").get() as { released: number }).released, 1)
})


test('kernel waits for scrubber readiness without losing its home or exposing run events', async (t) => {
  const f = runFixture(); f.store.close(); f.log.close()
  t.after(() => { f.db.close(); f.scrubber.close() })
  const kernel = await bootServerKernel([LEGACY_SERVER_PROFILE, {
    name: 'test:waiting-vault', patch: [{ id: 'egress-scrubber', config: { expectedSources: ['vault'] } }],
  }], { db: f.db, runs: { tickMs: 5 } })
  try {
    assert.equal(kernel.durableRuns!.health().failure, 'egress_not_ready')
    assert.throws(() => kernel.durableRuns!.store.create(), code('egress_not_ready'))
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM durable_runs').get() as { n: number }).n, 0)
    kernel.scrubber.ready('vault')
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(kernel.durableRuns!.health().failure, null)
    assert.equal(kernel.durableRuns!.store.create().state, 'submitted')
  } finally { await kernel.node.dispose() }
})


test('review R1: committed run transitions wake an already-waiting K2 subscriber', async (t) => {
  const f = runFixture(); t.after(f.close)
  const run = f.store.create({ id: 'live-run-session' })
  const cursor = f.log.read(run.session_id, { audience: 'person' }).lastSeq
  const controller = new AbortController()
  const iterator = f.log.subscribe(run.session_id, cursor, 'person', controller.signal)
  const next = iterator.next()
  assert.equal(f.log.subscriberCount(run.session_id), 1)
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    f.store.start(run.id)
    const result = await next
    assert.equal(result.done, false, 'a committed run event must notify the whole session id')
    assert.equal(result.value!.type, 'run.lifecycle')
    if (result.value!.type === 'run.lifecycle') assert.equal(result.value!.data.action, 'attempt')
    assert.equal(f.db.isTransaction, false, 'the subscriber sees the event after commit')
  } finally {
    clearTimeout(timeout); controller.abort(); await iterator.return(undefined)
  }
})

test('review R2: a completion arriving during the escalation handler stays deliverable and cannot be suppressed by success', (t) => {
  const f = runFixture(); t.after(f.close)
  const { promise } = delegated(f)
  const child = f.store.start(promise.child_id)
  f.store.signal(child, 'escalation')
  const first = f.store.deliver('lead', 1)!
  f.store.modelStarted(first)
  f.store.complete(child, 'completed')
  assert.equal(f.store.deliver('lead', 2), null, 'one handler holds the execution slot')
  assert.throws(() => f.store.complete(first, 'completed'), code('invalid_transition'), 'success must not discard an unacknowledged wake')
  f.store.hibernate(first)
  assert.equal(f.store.get('lead').state, 'submitted', 'no pending promise, but another wake is runnable')
  const second = f.store.deliver('lead', 2)!
  f.store.modelStarted(second)
  f.store.complete(second, 'completed')
  assert.equal(f.store.wakes('lead').length, 2)
  assert.equal(f.store.wakes('lead').filter((w) => w.acknowledged_at !== null).length, 2)
  assert.equal(f.store.wakes('lead').filter((w) => w.suppressed_at !== null).length, 0)
  assert.equal(count(f, 'resolved'), 1)
  assert.equal(count(f, 'acknowledged'), 2)
})

test('review R3: lowering successor TTL cannot shorten the predecessor home safety bound', (t) => {
  const f = runFixture(); let next: RunStore | null = null
  t.after(() => { next?.close(); f.close() })
  const run = f.store.create(); const oldAttempt = f.store.start(run.id)
  assert.throws(() => new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber,
    clock: () => RUN_TIME + 31_002, maxAttemptTtlMs: 1 }).heartbeat(), code('writer_busy'))
  assert.throws(() => new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber,
    clock: () => RUN_TIME + 90_999, maxAttemptTtlMs: 1 }).heartbeat(), code('writer_busy'))
  next = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber,
    clock: () => RUN_TIME + 91_001, maxAttemptTtlMs: 1 })
  next.heartbeat(); next.reconcile()
  const newAttempt = next.start(run.id)
  assert.ok(newAttempt.token > oldAttempt.token)
  assert.throws(() => f.store.complete(oldAttempt, 'completed'), code('stale_lease'))
})

test('review E2: a refused K2 append after child insertion rolls back all delegation mutations', (t) => {
  let armed = false
  const f = runFixture(':memory:', { logFault: (point, detail) => {
    if (armed && detail.type === 'run.lifecycle' && point === 'event_inserted') throw new Error('fixture_trace_refused')
  } }); t.after(f.close)
  const run = f.store.create({ id: 'lead' }); const a = f.store.start(run.id)
  const before = f.log.read('lead', { audience: 'person' }).events
  armed = true
  assert.throws(() => f.store.delegate(a, { key: 'refused-trace', deadline: RUN_DEADLINE }), /fixture_trace_refused/)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM durable_runs').get() as { n: number }).n, 1)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM promises').get() as { n: number }).n, 0)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM timers').get() as { n: number }).n, 0)
  assert.deepEqual(f.log.read('lead', { audience: 'person' }).events, before)
  assert.equal(f.store.get(run.id).state, 'working')
  armed = false
  f.store.delegate(a, { key: 'refused-trace', deadline: RUN_DEADLINE })
  assert.equal(f.store.promises(run.id).length, 1)
})

test('K3 integration: readiness opening cannot reconcile away a newly admitted live attempt', async (t) => {
  const f = runFixture()
  const inherited = f.store.create({ id: 'inherited-before-ready' })
  f.store.start(inherited.id)
  f.store.close(); f.log.close()
  t.after(() => { f.db.close(); f.scrubber.close() })
  const kernel = await bootServerKernel([LEGACY_SERVER_PROFILE, {
    name: 'test:readiness-race', patch: [{ id: 'egress-scrubber', config: { expectedSources: ['vault'] } }],
  }], { db: f.db, runs: { tickMs: 5 } })
  try {
    kernel.scrubber.ready('vault')
    const run = kernel.durableRuns!.store.create()
    const attempt = kernel.durableRuns!.store.start(run.id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(kernel.durableRuns!.health().failure, null, 'startup pump completed')
    assert.equal(kernel.durableRuns!.store.get(inherited.id).state, 'interrupted')
    assert.equal(kernel.durableRuns!.store.attempts(inherited.id)[0]!.state, 'lost')
    assert.equal(kernel.durableRuns!.store.get(run.id).state, 'working')
    assert.equal(kernel.durableRuns!.store.attempts(run.id)[0]!.state, 'delivered')
    kernel.durableRuns!.store.modelStarted(attempt)
  } finally { await kernel.node.dispose() }
})
