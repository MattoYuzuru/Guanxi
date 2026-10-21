import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { start } from '../src/index.ts'
import { SessionLogError } from '../src/session-log/log.ts'
import { RunStore } from '../src/runs/store.ts'
import { bootServerKernel } from '../src/runtime/kernel.ts'
import { runFixture, reconcileAllForTest, RUN_TIME } from './fixtures/durable-runs.ts'

// Adapted from the cross-family crash-boot and clockback probes.
test('H1: immediate start after SIGKILL serves requests while R1 reports writer_busy', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-r1-boot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const child = spawnSync(process.execPath, [new URL('./fixtures/durable-run-boot-worker.ts', import.meta.url).pathname, root], { encoding: 'utf8' })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.match(child.stdout, /started/)
  const app = await start({ dataDir: root, port: 0, webDir: '/nonexistent' })
  try {
    assert.equal((await fetch(`${app.url}/api/settings`)).status, 200)
    assert.deepEqual(app.kernel.durableRuns!.health(), { failure: 'writer_busy' })
    assert.throws(() => app.kernel.durableRuns!.store.create(), { code: 'writer_busy' })
  } finally { await app.close() }
})

test('H1: pump claims the bounded predecessor lease and loses inherited attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = runFixture()
  f.store.start(f.store.create({ id: 'inherited' }).id)
  // Simulate the predecessor clock being a day ahead; it never releases its home.
  f.db.prepare("UPDATE leases SET expires_at=expires_at+86400000,regrant_after=regrant_after+86400000").run()
  f.log.close()
  let now = RUN_TIME
  const kernel = await bootServerKernel(undefined, { db: f.db, runs: { clock: () => now, tickMs: 10 } })
  try {
    kernel.scrubber.ready('vault')
    assert.equal(kernel.durableRuns!.health().failure, 'writer_busy')
    now += 90_999; t.mock.timers.tick(10)
    assert.equal(kernel.durableRuns!.health().failure, 'writer_busy')
    now += 1; t.mock.timers.tick(10)
    assert.equal(kernel.durableRuns!.health().failure, null)
    assert.equal(kernel.durableRuns!.store.attempts('inherited')[0]!.state, 'lost')
    assert.equal(kernel.durableRuns!.store.get('inherited').state, 'interrupted')
    assert.throws(() => f.store.create(), { code: 'stale_lease' })
  } finally { await kernel.node.dispose(); f.close() }
})

test('H2: pump recovers after ten minutes asleep and fires the deadline due in the gap', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = runFixture(); f.store.close(); f.log.close()
  let now = RUN_TIME
  const kernel = await bootServerKernel(undefined, { db: f.db, runs: { alwaysOn: true, clock: () => now, tickMs: 10 } })
  try {
    kernel.scrubber.ready('vault'); t.mock.timers.tick(10)
    const store = kernel.durableRuns!.store
    const a = store.start(store.create({ id: 'lead' }).id)
    const p = store.delegate(a, { key: 'child', deadline: now + 100_000 })
    store.start(p.child_id)
    const before = f.db.prepare("SELECT holder,token FROM leases WHERE key='durable-runs/home'").get()
    now += 600_000; t.mock.timers.tick(10)
    assert.equal(kernel.durableRuns!.health().failure, null)
    assert.deepEqual(f.db.prepare("SELECT holder,token FROM leases WHERE key='durable-runs/home'").get(), before)
    assert.equal(store.attempts(p.child_id)[0]!.state, 'lost')
    assert.equal(store.promises('lead')[0]!.outcome, 'deadline')
    assert.equal(store.wakes('lead').length, 1)
    assert.equal(store.create().state, 'submitted')
  } finally { await kernel.node.dispose(); f.close() }
})

test('M1: a refused run trace cannot block other timers, expired attempts, reconciliation or wakes', () => {
  for (const operation of ['tick-timers', 'tick-attempts', 'reconcile', 'dispatch']) {
    const f = runFixture()
    try {
      for (const id of ['alpha-customer-7781', 'beta']) {
        const a = f.store.start(f.store.create({ id }).id)
        if (operation === 'tick-timers' || operation === 'dispatch') {
          const p = f.store.delegate(a, { key: 'child', deadline: RUN_TIME + 10 })
          if (operation === 'dispatch') f.store.complete(f.store.start(p.child_id), 'completed')
        }
      }
      f.scrubber.register('secret://late', 'alpha-customer-7781')
      if (operation === 'tick-timers') f.setTime(RUN_TIME + 20)
      if (operation === 'tick-attempts') f.setTime(RUN_TIME + 61_000)
      assert.doesNotThrow(() => operation === 'dispatch' ? f.store.dispatch(() => true) : operation === 'reconcile' ? reconcileAllForTest(f.store) : f.store.tick(), operation)
      if (operation === 'tick-timers') assert.equal(f.store.wakes('beta').length, 1)
      else if (operation === 'dispatch') assert.ok(f.store.wakes('beta')[0]!.attempt_id)
      else assert.equal(f.store.attempts('beta')[0]!.state, 'lost')
      assert.equal(f.store.failures()[0]!.runId, 'alpha-customer-7781')
      assert.match(f.store.failures()[0]!.code, /invalid_(input|event)/)
    } finally { f.close() }
  }
})

test('M2: an hour without an executor creates no wake attempts or trace churn', () => {
  const f = runFixture()
  try {
    const a = f.store.start(f.store.create({ id: 'lead' }).id)
    f.store.delegate(a, { key: 'child', deadline: RUN_TIME + 1 })
    f.setTime(RUN_TIME + 1); f.store.tick()
    const before = f.log.read('lead', { audience: 'person' }).events.length
    for (let minute = 1; minute <= 60; minute++) {
      f.setTime(RUN_TIME + minute * 60_000)
      f.store.heartbeat(); f.store.tick()
      assert.deepEqual(f.store.dispatch(), [])
    }
    assert.equal(f.store.attempts('lead').length, 1)
    assert.equal(f.store.wakes('lead')[0]!.deliveries, 0)
    assert.equal(f.store.get('lead').state, 'waiting_children')
    assert.equal(f.log.read('lead', { audience: 'person' }).events.length, before)
    assert.deepEqual(f.store.dispatch(() => false), [])
    const [claimed] = f.store.dispatch(() => true)
    assert.ok(claimed)
    assert.equal(f.store.wakes('lead')[0]!.deliveries, 1)
    assert.equal(f.store.wakes('lead')[0]!.acknowledged_at, null)
    f.store.modelStarted(claimed)
    assert.deepEqual(f.store.dispatch(() => true), [])
  } finally { f.close() }
})

test('M3: R1 lifecycle events and an agent handle share a session in either order', () => {
  const f = runFixture()
  try {
    for (const order of ['run-first', 'handle-first']) {
      let handle
      if (order === 'run-first') f.store.create({ id: order })
      handle = f.log.open(order, { kind: 'agent' })
      try {
        if (order === 'handle-first') f.store.create({ id: order })
        handle.append({ type: 'assistant.message', data: { messageId: null, step: null, text: 'agent narrative' } })
        f.store.start(order)
        handle.append({ type: 'assistant.message', data: { messageId: null, step: null, text: 'after run event' } })
        assert.throws(() => f.log.open(order, { kind: 'agent' }), { code: 'writer_busy' })
        const events = f.log.read(order, { audience: 'person' }).events
        assert.equal(events.filter((e) => e.type === 'run.lifecycle').length, 2)
        assert.equal(events.filter((e) => e.type === 'assistant.message').length, 2)
        assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1))
      } finally { handle.close() }
    }
  } finally { f.close() }
})

test('M5: idle heartbeat/tick/dispatch take no write transaction until ownerTtl/3', () => {
  const transactions: string[] = []
  const f = runFixture(':memory:', { fault: (op, point) => { if (point === 'before_begin') transactions.push(op) } })
  try {
    const changes = () => Number((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
    const before = changes()
    for (let ms = 0; ms < 10_000; ms += 100) {
      f.setTime(RUN_TIME + ms); f.store.heartbeat(); f.store.tick(); f.store.dispatch()
    }
    assert.deepEqual(transactions, [])
    assert.equal(changes(), before)
    f.setTime(RUN_TIME + 10_000); f.store.heartbeat()
    assert.deepEqual(transactions, ['heartbeat'])
    assert.equal(changes(), before + 1)
    f.setTime(RUN_TIME + 19_999); f.store.heartbeat(); f.store.tick()
    assert.deepEqual(transactions, ['heartbeat'])
    assert.equal(changes(), before + 1)
  } finally { f.close() }
})

test('L1: wall-clock suspend wakes timers while execution fences use monotonic elapsed time', () => {
  const f = runFixture(':memory:', { leaseClock: () => RUN_TIME })
  try {
    const a = f.store.start(f.store.create({ id: 'lead' }).id)
    const p = f.store.delegate(a, { key: 'child', deadline: RUN_TIME + 10_000 })
    const child = f.store.start(p.child_id)
    f.setTime(RUN_TIME + 600_000) // Linux monotonic clock can exclude this suspended time.
    f.store.heartbeat(); f.store.tick()
    assert.equal(f.store.promises('lead')[0]!.outcome, 'deadline')
    assert.equal(f.store.attempts(p.child_id)[0]!.state, 'delivered')
    assert.doesNotThrow(() => f.store.renew(child))
    f.store.retain(child, { key: 'wall-retention', kind: 'scratch', retainUntil: RUN_TIME + 700_000 })
    f.store.complete(child, 'completed')
    f.setTime(RUN_TIME + 1)
    assert.deepEqual(f.store.reapResources(), [])
    f.setTime(RUN_TIME + 700_000)
    assert.deepEqual(f.store.reapResources(), ['resource:wall-retention'])
  } finally { f.close() }
})

test('L2: report admission rejects an expired but unreaped active attempt with a domain error', () => {
  const f = runFixture()
  try {
    const a = f.store.start(f.store.create({ id: 'lead' }).id)
    const p = f.store.delegate(a, { key: 'child', deadline: RUN_TIME + 10 })
    f.store.start(p.child_id)
    f.setTime(RUN_TIME + 10); f.store.tick()
    f.setTime(RUN_TIME + 61_000); f.store.heartbeat()
    assert.throws(() => f.store.start(p.child_id), { code: 'invalid_transition' })
    assert.equal(f.store.attempts(p.child_id).length, 1)
    f.store.tick()
    assert.equal(f.store.start(p.child_id).ordinal, 2)
  } finally { f.close() }
})

test('L5: public reconciliation cannot discard attempts admitted by this activation', () => {
  const f = runFixture()
  try {
    f.store.start(f.store.create({ id: 'live' }).id)
    Reflect.apply(f.store.reconcile, f.store, [false]) // Legacy force flag is ignored.
    assert.equal(f.store.get('live').state, 'working')
    assert.equal(f.store.attempts('live')[0]!.state, 'delivered')
  } finally { f.close() }
})

test('M4: tick itself marks an expired attempt lost before a replacement can be admitted', () => {
  const f = runFixture()
  try {
    const a = f.store.start(f.store.create({ id: 'live' }).id)
    f.setTime(RUN_TIME + 60_000); f.store.heartbeat(); f.store.tick()
    assert.equal(f.store.attempts('live')[0]!.state, 'lost')
    assert.equal(f.store.get('live').state, 'interrupted')
    assert.equal((f.db.prepare("SELECT released FROM leases WHERE key='run:live/exec'").get() as { released: number }).released, 1)
    assert.ok(f.store.start('live').token > a.token)
  } finally { f.close() }
})

test('M4: terminal retained resources remain protected until retain_until, including its boundary', () => {
  const f = runFixture()
  try {
    const a = f.store.start(f.store.create({ id: 'lead' }).id)
    f.store.retain(a, { key: 'retained', kind: 'worktree', retainUntil: RUN_TIME + 100 })
    f.store.complete(a, 'completed')
    f.setTime(RUN_TIME + 99)
    assert.deepEqual(f.store.reapResources(), [])
    assert.equal((f.db.prepare("SELECT released FROM leases WHERE key='resource:retained'").get() as { released: number }).released, 0)
    f.setTime(RUN_TIME + 100)
    assert.deepEqual(f.store.reapResources(), ['resource:retained'])
  } finally { f.close() }
})

test('M4: a wake cannot bypass input_required before an explicit decision', () => {
  const f = runFixture()
  try {
    const a = f.store.start(f.store.create({ id: 'lead' }).id)
    const p = f.store.delegate(a, { key: 'child', deadline: RUN_TIME + 100 })
    const child = f.store.start(p.child_id)
    f.store.signal(child, 'needs-decision')
    const handler = f.store.deliver('lead', 1)!
    f.store.modelStarted(handler); f.store.inputRequired(handler)
    f.store.complete(child, 'completed')
    const before = f.store.attempts('lead').length
    assert.equal(f.store.deliver('lead', 2), null)
    assert.deepEqual(f.store.dispatch(() => true), [])
    assert.equal(f.store.attempts('lead').length, before)
    assert.equal(f.store.wakes('lead')[1]!.deliveries, 0)
  } finally { f.close() }
})

test('self-review: takeover cap follows observed predecessor renewals without fencing a live home', () => {
  const f = runFixture()
  let now = RUN_TIME
  const successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => now })
  try {
    assert.throws(() => successor.heartbeat(), { code: 'writer_busy' })
    for (let elapsed = 10_000; elapsed <= 120_000; elapsed += 10_000) {
      now = RUN_TIME + elapsed; f.setTime(now); f.store.heartbeat()
      assert.throws(() => successor.heartbeat(), { code: 'writer_busy' })
      assert.equal(f.store.create().state, 'submitted')
    }
    now += 91_000
    successor.heartbeat()
    assert.throws(() => f.store.create(), { code: 'stale_lease' })
  } finally { successor.close(); f.close() }
})


test('self-review: a session writer_busy failure is local to its run', () => {
  for (const operation of ['timers', 'reconcile', 'dispatch']) {
    let armed = false
    const f = runFixture(':memory:', { logFault: (_, detail) => {
      if (armed && detail.sessionId === 'alpha') throw new SessionLogError('writer_busy', 'fixture session writer')
    } })
    try {
      for (const id of ['alpha', 'beta']) {
        const a = f.store.start(f.store.create({ id }).id)
        if (operation !== 'reconcile') {
          const p = f.store.delegate(a, { key: 'child', deadline: RUN_TIME + 10 })
          if (operation === 'dispatch') f.store.complete(f.store.start(p.child_id), 'completed')
        }
      }
      armed = true; f.setTime(RUN_TIME + 20)
      assert.doesNotThrow(() => operation === 'timers' ? f.store.tick() : operation === 'dispatch' ? f.store.dispatch(() => true) : reconcileAllForTest(f.store))
      assert.equal(f.store.failures()[0]!.code, 'writer_busy')
      if (operation === 'timers') assert.equal(f.store.wakes('beta').length, 1)
      if (operation === 'reconcile') assert.equal(f.store.attempts('beta')[0]!.state, 'lost')
      if (operation === 'dispatch') assert.ok(f.store.wakes('beta')[0]!.attempt_id)
    } finally { f.close() }
  }
})
