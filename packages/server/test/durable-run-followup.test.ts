import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunStore } from '../src/runs/store.ts'
import { bootServerKernel, LEGACY_SERVER_PROFILE } from '../src/runtime/kernel.ts'
import { runFixture, RUN_TIME, RUN_DEADLINE } from './fixtures/durable-runs.ts'

function inheritedWake(f: ReturnType<typeof runFixture>) {
  const lead = f.store.start(f.store.create({ id: 'lead' }).id)
  f.store.modelStarted(lead)
  const promise = f.store.delegate(lead, { key: 'child', deadline: RUN_DEADLINE })
  f.store.complete(f.store.start(promise.child_id), 'completed')
  return f.store.deliver('lead', 1)!
}

test('R1 follow-up: readiness cannot expose an inherited wake before startup reconciliation', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = runFixture()
  const inherited = inheritedWake(f)
  f.store.close(); f.log.close()
  t.after(() => { f.db.close(); f.scrubber.close() })
  const kernel = await bootServerKernel([LEGACY_SERVER_PROFILE, {
    name: 'test:inherited-wake-window', patch: [{ id: 'egress-scrubber', config: { expectedSources: ['vault'] } }],
  }], { db: f.db, runs: { clock: () => RUN_TIME + 1_000, tickMs: 5 } })
  try {
    const store = kernel.durableRuns!.store
    assert.equal(kernel.durableRuns!.health().failure, 'egress_not_ready', 'clean close permits immediate home claim')
    assert.equal(store.attempts('lead')[1]!.state, 'delivered', 'recovery is deferred until readiness')
    kernel.scrubber.ready('vault')
    assert.equal(store.deliver('lead', 1), null, 'direct claim must wait for inherited-attempt recovery')
    assert.deepEqual(store.dispatch(() => true), [], 'dispatch must also withhold inherited attempts')
    assert.equal(store.wakes('lead')[0]!.acknowledged_at, null)
    assert.equal(store.wakes('lead')[0]!.deliveries, 1)
    t.mock.timers.tick(5)
    assert.equal(kernel.durableRuns!.health().failure, null)
    assert.equal(store.attempts('lead')[1]!.state, 'lost')
    const fresh = store.deliver('lead', 1)!
    assert.notEqual(fresh.id, inherited.id)
    assert.ok(fresh.token > inherited.token)
    store.modelStarted(fresh)
    store.reconcile(); t.mock.timers.tick(5)
    assert.equal(store.get('lead').state, 'working')
    assert.equal(store.attempts('lead').find((a) => a.id === fresh.id)!.state, 'started')
    assert.equal(store.wakes('lead').length, 1)
    assert.equal(store.wakes('lead')[0]!.deliveries, 2)
    assert.equal(store.wakes('lead')[0]!.acknowledged_at, RUN_TIME + 1_000)
    assert.equal(store.deliver('lead', 1), null, 'acknowledged wake is never redelivered')
  } finally { await kernel.node.dispose() }
})

test('R1 follow-up: inherited attempt credentials are fenced before reconciliation', () => {
  const f = runFixture()
  const inherited = inheritedWake(f)
  f.store.close()
  const next = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => RUN_TIME + 1_000 })
  try {
    next.heartbeat()
    assert.throws(() => next.modelStarted(inherited), { code: 'stale_lease' })
    assert.throws(() => next.renew(inherited), { code: 'stale_lease' })
    assert.equal(next.wakes('lead')[0]!.acknowledged_at, null)
    assert.equal(next.attempts('lead')[1]!.state, 'delivered')
    next.reconcile()
    assert.equal(next.attempts('lead')[1]!.state, 'lost')
    assert.ok(next.deliver('lead', 1))
  } finally { next.close(); f.close() }
})
