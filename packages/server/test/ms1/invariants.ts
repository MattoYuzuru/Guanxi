/** Facts that must hold at EVERY instant of the composed system, including the instant of a kill. The first two
 * checks are the LW crash suite's (`test/leads/lead-crash.test.ts`); the rest are the relay and F2 rows the
 * composition adds. */
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'

const count = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number }).n)

export function legalState(db: DatabaseSync): void {
  for (const d of db.prepare('SELECT * FROM lead_delegations').all() as unknown as { lead_run_id: string; key: string; state: string; child_run_id: string | null }[]) {
    const promise = db.prepare('SELECT * FROM promises WHERE parent_id=? AND delegation_key=?').get(d.lead_run_id, d.key)
    if (d.state === 'intent') assert.equal(d.child_run_id, null)
    else {
      assert.ok(promise, `delegation ${d.state} must have a committed R1 promise`)
      assert.equal(promise['child_id'], d.child_run_id)
    }
  }
  for (const w of db.prepare('SELECT run_id,wake_seq FROM lead_wakes').all() as unknown as { run_id: string; wake_seq: number }[]) {
    assert.ok(db.prepare('SELECT 1 FROM outbox WHERE run_id=? AND wake_seq=?').get(w.run_id, w.wake_seq), 'a stored packet belongs to a committed wake')
  }
  for (const o of db.prepare('SELECT * FROM outbox WHERE acknowledged_at IS NOT NULL').all() as unknown as { attempt_id: string }[]) {
    const attempt = db.prepare('SELECT * FROM run_attempts WHERE id=?').get(o.attempt_id)!
    assert.ok(attempt['first_model_at'] !== null, 'an acknowledged wake always follows an observed model start')
  }
  // A relay start row has its run and its ledger; a ledger has its run.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_public_starts'").get()) {
    for (const row of db.prepare('SELECT run_id FROM relay_public_starts').all() as unknown as { run_id: string }[]) {
      assert.ok(db.prepare('SELECT 1 FROM durable_runs WHERE id=?').get(row.run_id), 'a relay start belongs to a committed run')
      assert.ok(db.prepare('SELECT 1 FROM relay_runs WHERE run_id=?').get(row.run_id), 'a relay start belongs to a committed ledger')
    }
  }
  // F2-c: the terminal receipt, the cost and the completion are one transaction, so a remote call is billed to its child
  // run exactly when that child completed, and never twice.
  for (const child of db.prepare("SELECT id,state FROM durable_runs WHERE id LIKE 'rc-%'").all() as unknown as { id: string; state: string }[]) {
    const rows = count(db, 'SELECT COUNT(*) AS n FROM run_costs WHERE run_id=?', child.id)
    assert.ok(rows <= 1, `${child.id} has at most one cost row`)
    if (child.state === 'completed') assert.equal(rows, 1, `${child.id}: a completed remote call carries its usage`)
    if (rows === 1) assert.ok(['completed', 'failed', 'canceled'].includes(child.state), `${child.id}: usage is recorded only with a terminal state`)
  }
}

export function integrity(db: DatabaseSync): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  for (const session of db.prepare('SELECT DISTINCT session_id FROM session_events').all() as unknown as { session_id: string }[]) {
    const seqs = (db.prepare('SELECT seq FROM session_events WHERE session_id=? ORDER BY seq').all(session.session_id) as unknown as { seq: number }[]).map(r => r.seq)
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'contiguous replay')
  }
  // Every unreleased execution lease belongs to exactly one live attempt, and the reverse.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM leases l WHERE l.key LIKE 'run:%/exec' AND l.released=0 AND NOT EXISTS (SELECT 1 FROM run_attempts a WHERE a.id=l.holder AND a.state IN ('delivered','started'))"), 0)
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM run_attempts a WHERE a.state IN ('delivered','started') AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.holder=a.id AND l.released=0)"), 0)
}
