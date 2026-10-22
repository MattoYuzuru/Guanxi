import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { Db } from '../../src/store/db.ts'
import { leadWorld, readLog, START } from '../fixtures/lead-world.ts'

const worker = fileURLToPath(new URL('../fixtures/lead-crash-worker.ts', import.meta.url))
const HOUR = 3_600_000
type World = ReturnType<typeof leadWorld>
const count = (db: Db, sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n)

/** Cross-table facts that must hold at EVERY instant, including the instant of a kill. */
function legalState(db: Db): void {
  for (const d of db.prepare('SELECT * FROM lead_delegations').all() as unknown as { lead_run_id: string; key: string; state: string; child_run_id: string | null }[]) {
    const promise = db.prepare('SELECT * FROM promises WHERE parent_id=? AND delegation_key=?').get(d.lead_run_id, d.key)
    if (d.state === 'intent') assert.equal(d.child_run_id, null)
    else {
      assert.ok(promise, `delegation ${d.state} must have a committed R1 promise`)
      assert.equal(promise.child_id, d.child_run_id)
    }
  }
  for (const w of db.prepare('SELECT run_id,wake_seq FROM lead_wakes').all() as unknown as { run_id: string; wake_seq: number }[]) {
    assert.ok(db.prepare('SELECT 1 FROM outbox WHERE run_id=? AND wake_seq=?').get(w.run_id, w.wake_seq), 'a stored packet belongs to a committed wake')
  }
  for (const o of db.prepare('SELECT * FROM outbox WHERE acknowledged_at IS NOT NULL').all() as unknown as { attempt_id: string }[]) {
    const attempt = db.prepare('SELECT * FROM run_attempts WHERE id=?').get(o.attempt_id)!
    assert.ok(attempt.first_model_at !== null, 'an acknowledged wake always follows an observed model start')
  }
}
function integrity(db: Db): void {
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
const ledger = (w: World, runId: string) => JSON.stringify([w.runs.costs(runId), count(w.db, 'SELECT COUNT(*) AS n FROM run_costs WHERE run_id=?', runId)])

for (const stage of ['delegate', 'delegate-silent', 'wake', 'signal', 'cancel'] as const) {
  const base = stage === 'delegate-silent' ? 'delegate' : stage
  test(`crash property: SIGKILL at every ${stage} boundary of the lead flow yields one delegation, one resolution, one acknowledged wake and one resumed turn`, async t => {
    const root = mkdtempSync(join(tmpdir(), `guanxi-lw-${stage}-`))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const probe = spawnSync(process.execPath, [worker, join(root, 'probe.db'), stage, '-1'], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const { points } = JSON.parse(probe.stdout) as { points: string[] }
    assert.ok(points.length >= 8)
    const ackIdx = points.indexOf('model_started:committed')
    const intentIdx = points.indexOf('lead:delegate:intent_persisted')
    if (base === 'delegate') assert.ok(intentIdx > 0, 'the probe reaches the durable delegation intent')
    if (stage === 'wake') assert.ok(ackIdx > 0, 'the probe reaches the acknowledgement')
    const crashClock = stage === 'wake' ? START + HOUR : START
    for (let index = 0; index < points.length; index++) {
      const dir = join(root, String(index))
      spawnSync('mkdir', ['-p', dir])
      const path = join(dir, 'node.db')
      const killed = spawnSync(process.execPath, [worker, path, stage, String(index)], { encoding: 'utf8' })
      assert.equal(killed.signal, 'SIGKILL', `${index} ${points[index]}: ${killed.stderr}`)
      let now = crashClock
      const w = leadWorld({ path, dir, clock: () => now, deferClaim: true })
      const label = `${stage}:${index}:${points[index]}`
      try {
        assert.throws(() => w.runs.heartbeat(), { code: 'writer_busy' })
        now += 100_000
        w.runs.heartbeat()
        legalState(w.db)
        // Did the escalation commit before the kill? Then the lead is owed one more wake.
        const escalated = count(w.db, "SELECT COUNT(*) AS n FROM outbox WHERE kind='escalation'") > 0
        const expectedWakes = stage === 'signal' && escalated ? 2 : 1
        w.runs.reconcile()
        const settle = async () => { for (let i = 0; i < 4; i++) { w.lead.pump(); await w.lead.idle(); now += 1_000; w.runs.tick() } }
        await settle()
        const lead = w.db.prepare('SELECT id FROM durable_runs WHERE parent_id IS NULL').get() as { id: string } | undefined
        if (!lead) {
          assert.equal(count(w.db, 'SELECT COUNT(*) AS n FROM lead_sessions'), 0, label)
          assert.equal(count(w.db, 'SELECT COUNT(*) AS n FROM promises'), 0)
          assert.ok(index < 3, `only a kill before the start transaction commits leaves no run: ${label}`)
          continue
        }
        const runId = lead.id
        // The lead's first turn is never re-prompted by recovery. A person retries explicitly.
        if (base === 'delegate' && w.runs.promises(runId).length === 0) {
          // Once the intent committed, recovery completes the delegation itself: the lead decided already.
          assert.ok(index < intentIdx, `a committed intent must be completed by recovery without prompting the lead: ${label}`)
          assert.equal(w.runs.get(runId).state, 'interrupted', label)
          assert.equal(count(w.db, 'SELECT COUNT(*) AS n FROM lead_delegations'), 0, 'no intent exists, so nothing is completed on the lead\'s behalf')
          assert.equal((await w.lead.resume(runId, 'delegate now')).outcome, 'hibernated', label)
          await settle()
        }
        if (stage === 'cancel') {
          if (w.runs.get(runId).state !== 'canceled') await w.lead.cancel(runId)
          await settle()
          const child = w.runs.promises(runId)[0]!.child_id
          for (const id of [runId, child]) {
            assert.equal(w.runs.get(id).state, 'canceled', label)
            assert.equal(w.runs.get(id).cancel_count, 1, label)
            const events = w.log.read(runId, { audience: 'person', limit: 1_000 }).events
            assert.equal(events.filter(e => e.type === 'run.lifecycle' && e.data.runId === id && e.data.action === 'canceled').length, 1, label)
          }
          const stops = readLog(dir, 'children.jsonl').filter(e => e.event === 'stop')
          assert.ok(stops.length >= 1 && stops.length <= 2, `stop is at-least-once and idempotent: ${stops.length} ${label}`)
          assert.equal(w.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'child_stop_requested', label)
          assert.equal(w.runs.wakes(runId).length, 0)
          integrity(w.db)
          continue
        }
        assert.equal(w.runs.promises(runId).length, 1, `exactly one delegation: ${label}`)
        assert.equal(count(w.db, 'SELECT COUNT(*) AS n FROM durable_runs WHERE parent_id=?', runId), 1, 'exactly one child run')
        const promise = w.runs.promises(runId)[0]!
        const childId = promise.child_id
        if (base === 'delegate') {
          // Hibernated again, one live executor, and the lead's ledger is not touched while it sleeps.
          assert.equal(w.runs.get(runId).state, 'waiting_children', label)
          assert.equal(w.db.prepare("SELECT state FROM lead_delegations").get()!.state, 'child_started', label)
          assert.equal(w.runs.attempts(childId).filter(a => ['delivered', 'started'].includes(a.state)).length, 1, `one live executor: ${label}`)
          assert.ok(readLog(dir, 'children.jsonl').filter(e => e.event === 'launch').length <= 2)
          const before = ledger(w, runId)
          const attempt = w.children.attempts.get(childId)!
          for (let elapsed = 0; elapsed < HOUR; elapsed += 50_000) { now += 50_000; w.runs.renew(attempt, 60_000) }
          assert.equal(ledger(w, runId), before, 'no lead cost accrues while hibernating')
          w.runs.complete(attempt, 'completed')
          assert.equal(ledger(w, runId), before, 'the child\'s resolution does not bill the lead')
        } else if (stage === 'signal') {
          // The escalation woke the lead (or never committed); the child is still the lead's business.
          if (w.runs.get(runId).state === 'interrupted') await w.lead.resume(runId, 'continue the lead')
          await settle()
          assert.equal(w.runs.get(runId).state, 'waiting_children', `the lead yielded again: ${label}`)
          assert.equal(w.runs.promises(runId)[0]!.outcome, null, 'an escalation never resolves the promise')
          assert.equal(w.runs.wakes(runId).length, escalated ? 1 : 0, label)
          const attempt = w.children.attempts.get(childId)!
          w.runs.complete(attempt, 'completed')
        } else if (promise.outcome === null) {
          // The killed executor is gone. Its child never began a model call, so the lead service started
          // a fresh one; otherwise a person's explicit retry would be needed.
          const state = w.runs.get(childId).state
          assert.equal(state, 'working', `a never-started child is restarted: ${label}`)
          w.runs.complete(w.children.attempts.get(childId)!, 'completed')
        }
        await settle()
        let state = w.runs.get(runId).state
        if (state === 'interrupted') {
          assert.ok(stage === 'wake' && index >= ackIdx, `automatic recovery must finish a wake killed before its acknowledgement: ${label}`)
          assert.equal((await w.lead.resume(runId, 'continue the lead')).outcome, 'completed', label)
          state = w.runs.get(runId).state
        }
        assert.equal(state, 'completed', label)
        assert.equal(w.runs.promises(runId).filter(p => p.outcome === 'completed').length, 1, label)
        assert.equal(w.runs.wakes(runId).length, expectedWakes, `exact wake count: ${label}`)
        assert.equal(w.runs.wakes(runId).filter(x => x.acknowledged_at !== null).length, expectedWakes, `every wake acknowledged exactly once: ${label}`)
        const events = w.log.read(runId, { audience: 'person', limit: 1_000 }).events
        assert.equal(events.filter(e => e.type === 'run.lifecycle' && e.data.action === 'resolved').length, 1, label)
        assert.equal(events.filter(e => e.type === 'run.lifecycle' && e.data.action === 'acknowledged').length, expectedWakes, label)
        for (let seq = 1; seq <= expectedWakes; seq++) assert.equal(w.runs.deliver(runId, seq), null, 'an acknowledged wake is never delivered again')
        const turns = readLog(dir, 'turns.jsonl')
        const started = (kind: string, seq?: number) => turns.filter(e => e.event === 'prompt' && e.kind === kind && (seq === undefined || e.wakeSeq === seq)).length
        const completed = (kind: string, seq?: number) => turns.filter(e => e.event === 'turn_end' && e.kind === kind && (seq === undefined || e.wakeSeq === seq)).length
        // A turn killed before its acknowledgement is lost with its process and re-delivered: it may
        // START twice but COMPLETES once. After the acknowledgement it is never replayed automatically.
        for (let seq = 1; seq <= expectedWakes; seq++) assert.ok(started('wake', seq) >= 1 && started('wake', seq) <= 2 && completed('wake', seq) <= 1, `wake ${seq}: ${label}`)
        if (base === 'delegate' || (stage === 'wake' && index < ackIdx)) {
          assert.equal(completed('wake'), 1, `exactly one resumed lead turn completed: ${label}`)
          assert.equal(completed('continue'), 0, label)
        } else if (stage === 'wake') {
          assert.equal(started('wake'), 1, `an acknowledged wake is never delivered twice: ${label}`)
          assert.ok(started('continue') <= 1, label)
          // The node cannot know that a killed agent finished; a person decides, once, with `resume`.
        } else {
          assert.equal(completed('wake', expectedWakes), 1, `the final resolution wake completed once: ${label}`)
        }
        // The ledger holds exactly what the agent reported cumulatively for its one session: a kill between
        // the cost entry and anything else can neither lose a delta forever nor bill a turn twice.
        const turnsStarted = turns.filter(e => e.event === 'prompt').length
        assert.deepEqual(w.runs.costs(runId), [{ currency: 'USD', inputTokens: turnsStarted * 1000, outputTokens: turnsStarted * 200, costMicrounits: turnsStarted * 500_000 }], `exact lead ledger: ${label}`)
        assert.equal(count(w.db, 'SELECT COUNT(*) AS n FROM run_resources WHERE run_id=?', runId), 1, `the sleeping lead's scratch resource is retained: ${label}`)
        assert.equal(count(w.db, "SELECT COUNT(*) AS n FROM lead_delegations WHERE state='intent'"), 0)
        assert.equal(w.tools.activeGrants(), 0)
        integrity(w.db)
      } finally { await w.close() }
    }
    t.diagnostic(`exhausted ${points.length} ${stage} crash boundaries (SIGKILL)`)
  })
}
