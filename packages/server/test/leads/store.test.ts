import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LEAD_MIGRATION, LeadStore } from '../../src/leads/store.ts'
import { openDb } from '../../src/store/db.ts'
import { RunStore } from '../../src/runs/store.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'

function world(path = ':memory:') {
  const db = openDb(path)
  const scrubber = new SecretScrubber()
  const log = new SessionLog({ db, scrubber, isProcessAlive: () => false })
  const runs = new RunStore({ db, log, scrubber, alwaysOn: true })
  runs.heartbeat()
  return { db, runs, close() { runs.close(); log.close(); db.close(); scrubber.close() } }
}
const session = (runId: string) => ({ run_id: runId, owner_account_id: 'o', actor_account_id: 'o', project_id: 'p', session_roles: '{}', fallback: null, binding_digest: 'd', task: 't' })

test('migration 40 is additive, idempotent and leaves every earlier ledger and user_version alone', () => {
  const w = world()
  try {
    const before = w.db.prepare('PRAGMA user_version').get()!.user_version
    const tablesBefore = (w.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(r => r.name)
    const store = new LeadStore(w.db)
    const tablesAfter = (w.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(r => r.name)
    assert.deepEqual(tablesAfter.filter(name => !tablesBefore.includes(name)), ['lead_delegations', 'lead_migrations', 'lead_sessions', 'lead_wakes'])
    assert.equal(w.db.prepare('PRAGMA user_version').get()!.user_version, before)
    w.runs.create({ id: 'r1' })
    w.db.exec('BEGIN IMMEDIATE')
    store.insertSession(w.db, session('r1'))
    w.db.exec('COMMIT')
    assert.equal(new LeadStore(w.db).session('r1')!.task, 't', 'reopening keeps rows and does not migrate again')
    assert.deepEqual(w.db.prepare('SELECT version FROM lead_migrations').all().map(r => r.version), [40])
  } finally { w.close() }
})

test('a failed migration rolls back completely and can be retried', () => {
  const w = world()
  try {
    w.db.exec('CREATE TABLE lead_wakes (x INTEGER)')
    assert.throws(() => new LeadStore(w.db))
    assert.equal(w.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('lead_migrations','lead_sessions','lead_delegations')").all().length, 0)
    w.db.exec('DROP TABLE lead_wakes')
    assert.doesNotThrow(() => new LeadStore(w.db))
    assert.match(LEAD_MIGRATION, /VALUES \(40\)/)
  } finally { w.close() }
})

test('foreign keys, immutable packets and immutable delegation intents are enforced by the database', () => {
  const w = world()
  try {
    const store = new LeadStore(w.db)
    assert.throws(() => store.insertSession(w.db, session('missing')), /FOREIGN KEY/i)
    w.runs.create({ id: 'r1' })
    store.insertSession(w.db, session('r1'))
    store.insertIntent(w.db, { lead_run_id: 'r1', key: 'k', brief: '{}', deadline: 5, on_deadline: 'wrap_up', on_cancel: 'cancel' })
    assert.throws(() => store.insertIntent(w.db, { lead_run_id: 'r1', key: 'k', brief: '{}', deadline: 5, on_deadline: 'wrap_up', on_cancel: 'cancel' }), /UNIQUE|PRIMARY/i)
    assert.throws(() => w.db.prepare("UPDATE lead_delegations SET brief='{\"x\":1}' WHERE key='k'").run(), /immutable/)
    assert.throws(() => w.db.prepare("UPDATE lead_delegations SET state='bogus' WHERE key='k'").run(), /CHECK/i)
    store.setDelegationState(w.db, 'r1', 'k', 'delegated', undefined)
    assert.equal(store.delegation('r1', 'k')!.state, 'delegated', 'state may advance')
    store.insertWake(w.db, { runId: 'r1', wakeSeq: 1, packet: '{"a":1}', hash: 'h' })
    store.insertWake(w.db, { runId: 'r1', wakeSeq: 1, packet: '{"a":2}', hash: 'other' })
    assert.equal(store.wake('r1', 1)!.packet, '{"a":1}', 'a rebuilt packet never replaces the first')
    assert.throws(() => w.db.prepare("UPDATE lead_wakes SET packet='{}' WHERE wake_seq=1").run(), /immutable/)
    assert.throws(() => w.db.prepare('DELETE FROM lead_wakes').run(), /append only/)
    store.setResumeMode(w.db, 'r1', 1, 'load')
    assert.equal(store.wake('r1', 1)!.resume_mode, 'load')
    assert.throws(() => store.setResumeMode(w.db, 'r1', 1, 'bogus' as never), /CHECK/i)
  } finally { w.close() }
})

test('a database file keeps the lead ledger across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-lw-store-'))
  try {
    const first = world(join(dir, 'n.db'))
    first.runs.create({ id: 'r1' })
    new LeadStore(first.db).insertSession(first.db, session('r1'))
    first.close()
    const second = world(join(dir, 'n.db'))
    assert.equal(new LeadStore(second.db).sessions().length, 1)
    second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the pump reads only delegations that still need it', () => {
  const w = world()
  try {
    const store = new LeadStore(w.db)
    const state = (id: string, value: string) => w.db.prepare('UPDATE durable_runs SET state=? WHERE id=?').run(value, id)
    const intent = (lead: string, key: string) => ({ lead_run_id: lead, key, brief: '{}', deadline: 1, on_deadline: 'wrap_up' as const, on_cancel: 'cancel' as const })
    const cases: [string, string, string, string | null, string | null, boolean][] = [
      // [lead id, lead state, delegation state, child state, key, wanted]
      ['l1', 'working', 'intent', null, 'live-intent', true],
      ['l2', 'canceled', 'intent', null, 'dead-intent', false],
      ['l3', 'waiting_children', 'delegated', 'submitted', 'unstarted', true],
      ['l4', 'completed', 'delegated', 'submitted', 'unstarted-dead-lead', false],
      ['l5', 'waiting_children', 'child_started', 'working', 'running', false],
      ['l6', 'waiting_children', 'child_started', 'completed', 'done', false],
      ['l7', 'canceled', 'child_started', 'canceled', 'to-stop', true],
      ['l8', 'waiting_children', 'child_started', 'interrupted', 'lost', true],
      ['l9', 'canceled', 'child_stop_requested', 'canceled', 'stopped', false],
      ['l10', 'completed', 'child_started', 'interrupted', 'detached-lost', false],
      ['l11', 'waiting_children', 'abandoned', null, 'abandoned-intent', false],
    ]
    for (const [lead, leadState, delegation, childState, key] of cases) {
      w.runs.create({ id: lead })
      state(lead, leadState)
      store.insertSession(w.db, session(lead))
      store.insertIntent(w.db, intent(lead, key!))
      if (!childState && delegation !== 'intent') store.setDelegationState(w.db, lead, key!, delegation as never)
      if (childState) {
        w.runs.create({ id: `${lead}-child` })
        state(`${lead}-child`, childState)
        store.setDelegationState(w.db, lead, key!, delegation as never, `${lead}-child`)
      }
    }
    assert.deepEqual(store.openDelegations().map(d => d.key).sort(), cases.filter(c => c[5]).map(c => c[4]!).sort())
  } finally { w.close() }
})
