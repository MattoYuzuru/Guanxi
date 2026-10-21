import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunStore } from '../src/runs/store.ts'
import { SessionLog } from '../src/session-log/log.ts'
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

test('R1 follow-up: home append tolerates an unavailable isTransaction property', () => {
  const f = runFixture()
  // Native DatabaseSync accessors cannot be redefined. Bind every real operation
  // to the database while exposing the pre-22.16 property shape to the log.
  const compatDb = new Proxy({} as typeof f.db, { get: (_, key) => {
    if (key === 'isTransaction') return undefined
    const value = Reflect.get(f.db, key, f.db)
    return typeof value === 'function' ? value.bind(f.db) : value
  } })
  const log = new SessionLog({ db: compatDb, scrubber: f.scrubber })
  try {
    assert.equal(compatDb.isTransaction, undefined, 'simulate Node versions before 22.16')
    f.db.exec('BEGIN IMMEDIATE')
    try {
      log.appendFromHomeWithin('compat', { kind: 'agent' }, {
        type: 'assistant.message', data: { messageId: null, step: null, text: 'committed home event' },
      })
      f.db.exec('COMMIT')
    } catch (error) { f.db.exec('ROLLBACK'); throw error }
    const messages = log.read('compat', { audience: 'person' }).events.filter((e) => e.type === 'assistant.message')
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.data.text, 'committed home event')
    assert.equal(f.db.isTransaction, false)
    assert.throws(() => f.log.appendFromHomeWithin('outside', { kind: 'agent' }, {
      type: 'assistant.message', data: { messageId: null, step: null, text: 'outside transaction' },
    }), { code: 'invalid_event' })
  } finally { log.close(); f.close() }
})

test('R1 follow-up: scheduler passes fail globally after losing the durable home', () => {
  for (const operation of ['expiry', 'timers', 'reconcile', 'dispatch']) {
    const f = runFixture()
    const lead = f.store.start(f.store.create({ id: 'lead' }).id)
    if (operation === 'timers' || operation === 'dispatch') {
      const promise = f.store.delegate(lead, { key: 'child', deadline: RUN_TIME + 10 })
      if (operation === 'dispatch') f.store.complete(f.store.start(promise.child_id), 'completed')
    }
    f.store.close()
    const now = RUN_TIME + (operation === 'expiry' ? 61_000 : 20)
    const next = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => now })
    try {
      next.heartbeat()
      const before = { attempts: next.attempts('lead'), promises: next.promises('lead'), wakes: next.wakes('lead') }
      f.db.prepare("UPDATE leases SET holder='successor',token=token+1 WHERE key='durable-runs/home'").run()
      assert.throws(() => {
        if (operation === 'dispatch') next.dispatch(() => true)
        else if (operation === 'reconcile') next.reconcile()
        else next.tick()
      }, { code: 'stale_lease' }, operation)
      assert.deepEqual(next.failures(), [], 'home loss must escape per-run failure isolation')
      assert.deepEqual({ attempts: next.attempts('lead'), promises: next.promises('lead'), wakes: next.wakes('lead') }, before)
    } finally { next.close(); f.close() }
  }
})

test('R1 follow-up: closing a log releases only its own durable home writer rows', () => {
  const f = runFixture()
  const other = new SessionLog({ db: f.db, scrubber: f.scrubber, clock: () => new Date(RUN_TIME) })
  try {
    f.store.create({ id: 'home-one' }); f.store.create({ id: 'home-two' })
    const otherHandle = other.open('other-writer', { kind: 'agent' })
    const rows = () => f.db.prepare('SELECT session_id,writer_id,epoch,released_at FROM session_writers ORDER BY session_id').all()
    const before = rows()
    assert.equal(before.length, 3)
    assert.ok(before.every((row) => row.released_at === null))
    f.log.close()
    const after = rows()
    assert.deepEqual(after.filter((row) => row.session_id.startsWith('home-')).map((row) => row.released_at),
      [new Date(RUN_TIME).toISOString(), new Date(RUN_TIME).toISOString()])
    assert.deepEqual(after.find((row) => row.session_id === 'other-writer'), before.find((row) => row.session_id === 'other-writer'))
    for (const id of ['home-one', 'home-two']) {
      const handle = other.open(id, { kind: 'agent' })
      assert.equal(handle.epoch, 2, 'a clean close permits immediate acquisition without expiry')
      handle.close()
    }
    otherHandle.append({ type: 'assistant.message', data: { messageId: null, step: null, text: 'still live' } })
  } finally { other.close(); f.close() }
})

test('R1 follow-up: busy transactions renew the home only at ownerTtl/3', () => {
  const f = runFixture(':memory:', { ownerTtlMs: 300, maxAttemptTtlMs: 1_000 })
  try {
    // Observe actual UPDATEs, including no-op writes at the same timestamp.
    f.db.exec(`CREATE TEMP TABLE home_renewals (expires_at INTEGER);
      CREATE TEMP TRIGGER record_home_renewal AFTER UPDATE OF expires_at ON leases
      WHEN NEW.key='durable-runs/home'
      BEGIN INSERT INTO home_renewals VALUES (NEW.expires_at); END;`)
    const renewals = () => f.db.prepare('SELECT expires_at FROM home_renewals ORDER BY rowid').all().map((row) => row.expires_at)
    const attempt = f.store.start(f.store.create({ id: 'busy' }).id)
    for (const elapsed of [0, 1, 50, 99]) {
      f.setTime(RUN_TIME + elapsed); f.store.renew(attempt)
      assert.deepEqual(renewals(), [], `no home update at ${elapsed}ms`)
    }
    f.setTime(RUN_TIME + 100); f.store.renew(attempt)
    assert.deepEqual(renewals(), [RUN_TIME + 400])
    for (const elapsed of [100, 101, 150, 199]) {
      f.setTime(RUN_TIME + elapsed); f.store.renew(attempt)
      assert.deepEqual(renewals(), [RUN_TIME + 400], `no second home update at ${elapsed}ms`)
    }
    f.setTime(RUN_TIME + 200); f.store.renew(attempt)
    assert.deepEqual(renewals(), [RUN_TIME + 400, RUN_TIME + 500])
  } finally { f.close() }
})
