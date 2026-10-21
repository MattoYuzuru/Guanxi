import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { start } from '../src/index.ts'
import { RunStore } from '../src/runs/store.ts'
import { bootServerKernel } from '../src/runtime/kernel.ts'
import { runFixture, RUN_TIME } from './fixtures/durable-runs.ts'

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
      assert.doesNotThrow(() => operation === 'dispatch' ? f.store.dispatch(() => true) : operation === 'reconcile' ? f.store.reconcile() : f.store.tick(), operation)
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
