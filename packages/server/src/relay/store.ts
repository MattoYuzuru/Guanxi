import { randomUUID } from 'node:crypto'
import type { Db } from '../store/db.ts'
import type { RunStore } from '../runs/store.ts'
import type { Attempt } from '../runs/types.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { SessionEventInput } from '../session-log/log.ts'
import { planSchema, capsSchema, invariant, type Ledger, type Plan, type Caps, type Note, type NoteKind, type CycleState, type Handoff } from './types.ts'
import { canonical, hash, strip, byteHash, validateHandoff } from './handoff.ts'

// Independent additive ledger, in the SAME database as R1 and K2 for atomic commits.
// 35 is reserved to R2; F1's independent federation ledger owns 34. No user_version change.
export const RELAY_MIGRATION = `
CREATE TABLE relay_migrations (version INTEGER PRIMARY KEY);
INSERT INTO relay_migrations VALUES (35);
CREATE TABLE relay_runs (run_id TEXT PRIMARY KEY REFERENCES durable_runs(id), snapshot TEXT NOT NULL);
CREATE TABLE relay_notes (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES relay_runs(run_id), payload TEXT NOT NULL);
CREATE TABLE relay_seals (run_id TEXT NOT NULL REFERENCES relay_runs(run_id), cycle INTEGER NOT NULL,
 attempt_id TEXT NOT NULL REFERENCES run_attempts(id), epoch INTEGER NOT NULL, token INTEGER NOT NULL,
 ledger TEXT NOT NULL, handoff TEXT NOT NULL, artifact_hash TEXT NOT NULL, markdown TEXT NOT NULL, bundle BLOB NOT NULL,
 PRIMARY KEY(run_id,cycle));
CREATE TRIGGER relay_notes_immutable BEFORE UPDATE ON relay_notes BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER relay_notes_no_delete BEFORE DELETE ON relay_notes BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER relay_seals_immutable BEFORE UPDATE ON relay_seals BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER relay_seals_no_delete BEFORE DELETE ON relay_seals BEGIN SELECT RAISE(ABORT,'append only'); END;
`
export const progressState = (l: Ledger) => {
  const done = Object.entries(l.items).filter(([, status]) => status === 'done').map(([id]) => id).sort()
  const gates = Object.fromEntries(l.evidence.filter(e => e.head === l.head).map(e => [e.item, e.ok]))
  return { statuses: hash(Object.fromEntries(Object.entries(l.items).map(([k, v]) => [k, v === 'done']))),
    gates: hash(gates), done, passed: Object.entries(gates).filter(([, ok]) => ok).map(([id]) => id).sort() }
}
const transitions: Record<CycleState, readonly CycleState[]> = {
  boot: ['orient'], orient: ['work', 'escalate'], work: ['wind_down', 'handoff_write', 'finish', 'escalate'],
  wind_down: ['handoff_write'], handoff_write: ['handoff_validate', 'harness_fallback'],
  handoff_validate: ['sealed', 'handoff_write', 'harness_fallback'], harness_fallback: ['handoff_validate', 'escalate'],
  sealed: ['boot', 'finish', 'escalate'], finish: [], escalate: ['boot'],
}
export class RelayStore {
  readonly db: Db; readonly runs: RunStore; readonly scrubber: EgressScrubber
  readonly clock: () => number; readonly fault?: (point: string) => void
  constructor(db: Db, runs: RunStore, scrubber: EgressScrubber, clock = Date.now, fault?: (point: string) => void) {
    this.db = db; this.runs = runs; this.scrubber = scrubber; this.clock = clock; this.fault = fault
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='relay_migrations'").get()) {
      db.exec('BEGIN IMMEDIATE')
      try { db.exec(RELAY_MIGRATION); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
    }
    invariant((db.prepare('SELECT version FROM relay_migrations').get() as { version: number }).version === 35, 'schema_version')
  }
  read(runId: string): Ledger {
    invariant(this.scrubber.isReady(), 'egress_not_ready')
    const row = this.db.prepare('SELECT snapshot FROM relay_runs WHERE run_id=?').get(runId) as { snapshot: string } | undefined
    invariant(row, 'relay_not_found')
    const value = JSON.parse(row.snapshot) as Ledger
    // Late secret registration must not silently change an already hashed snapshot.
    // Return a redacted copy with an explicit marker; the next mutation persists it.
    const clean = this.scrubber.scrub(value)
    if (canonical(clean) !== canonical(value)) return { ...clean, withheld: true }
    return value
  }
  private event(emit: (e: SessionEventInput) => void, action: string, data: unknown): void {
    emit({ type: 'agent.note', data: { text: canonical({ relay: action, data }) } })
  }
  change<T>(a: Attempt, action: string, apply: (l: Ledger) => T): T {
    return this.runs.mutate(a, (db, emit) => {
      const l = this.read(a.run_id)
      const value = apply(l)
      invariant(canonical(this.scrubber.scrub(l)) === canonical(l), 'unscrubbed_ledger')
      db.prepare('UPDATE relay_runs SET snapshot=? WHERE run_id=?').run(canonical(l), a.run_id)
      this.event(emit, action, { cycle: l.cycle, state: l.state, hash: hash(l) })
      return value
    })
  }
  emit(a: Attempt, event: SessionEventInput): void { this.runs.mutate(a, (_db, emit) => emit(event)) }
  init(a: Attempt, rawPlan: Plan, rawCaps: Caps): void {
    const plan = planSchema.parse(this.scrubber.scrub(rawPlan)), caps = capsSchema.parse(rawCaps)
    this.runs.mutate(a, (db, emit) => this.initWithin(a, plan, caps, db, emit))
  }
  /** Only for an already-fenced synchronous R1 start/mutation transaction. */
  initWithin(a: Attempt, plan: Plan, caps: Caps, db: Db, emit: (e: SessionEventInput) => void): void {
      invariant(!db.prepare('SELECT run_id FROM relay_runs WHERE run_id=?').get(a.run_id), 'already_initialized')
      const l: Ledger = { plan, caps, cycle: 0, state: 'boot', startedAt: this.clock(), items: Object.fromEntries(plan.items.map(i => [i.id, 'open'])),
        head: plan.base, files: [], diffstat: '', evidence: [], noProgress: 0, tokens: 0, moneyMicros: 0, unknownCosts: 0,
        errors: 0, proposals: [], eta: null, baseline: { statuses: '', gates: '', head: plan.base }, pendingCall: null }
      db.prepare('INSERT INTO relay_runs VALUES (?,?)').run(a.run_id, canonical(l))
      this.event(emit, 'initialized', { revision: plan.revision, hash: hash(l) })
  }
  transition(a: Attempt, state: CycleState): void {
    this.change(a, 'transition', l => {
      invariant(transitions[l.state].includes(state), 'cycle_transition')
      if (state === 'sealed') {
        const seal = this.db.prepare('SELECT 1 FROM relay_seals WHERE run_id=? AND cycle=? AND attempt_id=? AND epoch=? AND token=?').get(a.run_id, l.cycle, a.id, a.epoch, a.token)
        invariant(seal, 'seal_missing')
      }
      l.state = state
    })
  }
  begin(a: Attempt): void {
    this.change(a, 'cycle_begin', l => {
      invariant(l.state === 'boot', 'cycle_transition')
      l.cycle++; l.state = 'orient'; l.baseline = { ...progressState(l), head: l.head }
    })
  }
  /** Explicit recovery only, after R1 admitted a NEW fence. Never resumes a pending model call. */
  recover(a: Attempt): void {
    this.change(a, 'recovered', l => {
      // A lead decision admits a new attempt; escalation is recoverable, finish is not.
      invariant(l.state !== 'finish', 'cycle_transition')
      l.pendingCall = null; l.state = 'boot'
    })
  }
  notes(runId: string): Note[] {
    this.read(runId)
    return this.db.prepare('SELECT id,payload FROM relay_notes WHERE run_id=? ORDER BY id').all(runId).map(r => this.scrubber.scrub({ ...JSON.parse(String(r.payload)), id: Number(r.id) }))
  }
  note(a: Attempt, kind: NoteKind, text: string, items: string[], expiresAt: number | null): void {
    invariant(['decision', 'dead_end', 'hypothesis', 'open_issue', 'lesson'].includes(kind) && typeof text === 'string' && text.trim(), 'invalid_note')
    invariant(expiresAt === null || Number.isSafeInteger(expiresAt), 'invalid_note')
    this.runs.mutate(a, (db, emit) => {
      const l = this.read(a.run_id)
      invariant(items.every(i => i in l.items), 'invalid_item')
      const payload = canonical(this.scrubber.scrub({ kind, text, items, expiresAt }))
      db.prepare('INSERT INTO relay_notes(run_id,payload) VALUES (?,?)').run(a.run_id, payload)
      this.event(emit, 'note', { kind, items })
    })
  }
  propose(a: Attempt, text: string): void { this.change(a, 'amendment_proposed', l => { l.proposals.push(this.scrubber.scrub(text)) }) }
  requestVerification(a: Attempt, item: string): void {
    this.change(a, 'verification_requested', l => {
      invariant(item in l.items && l.items[item] !== 'done', 'invalid_item')
      if (l.items[item] === 'open') l.items[item] = 'verification_requested'
    })
  }
  observe(a: Attempt, input: { head: string; files: string[]; diffstat: string; evidence?: { item: string; ok: boolean; output: string } }): void {
    this.change(a, 'observed', l => {
      if (input.head !== l.head) for (const id of Object.keys(l.items)) l.items[id] = 'open'
      l.head = input.head; l.files = this.scrubber.scrub(input.files); l.diffstat = this.scrubber.scrub(input.diffstat)
      if (input.evidence) {
        const e = input.evidence
        invariant(e.item in l.items && l.plan.items.find(i => i.id === e.item)!.dependsOn.every(d => l.items[d] === 'done'), 'invalid_item')
        l.evidence.push({ ...this.scrubber.scrub(e), id: randomUUID(), head: input.head })
        l.items[e.item] = e.ok ? 'done' : 'verification_requested'
      }
    })
  }
  countProgress(a: Attempt, nonemptyCommit: boolean): boolean {
    return this.change(a, 'progress', l => {
      // Agent requests and notes are not status evidence. Only a transition toward done
      // or a passing gate counts; the first observation of a failing gate does not.
      const now = progressState(l)
      const done = now.done.some(id => !(l.baseline.done ?? []).includes(id))
      const gate = now.passed.some(id => !(l.baseline.passed ?? []).includes(id))
      const progressed = done || gate || (l.head !== l.baseline.head && nonemptyCommit)
      l.noProgress = progressed ? 0 : l.noProgress + 1
      return progressed
    })
  }
  seal(a: Attempt, h: Handoff, bundle: Uint8Array, max: number): void {
    this.runs.mutate(a, (db, emit) => {
      const l = this.read(a.run_id)
      invariant(l.state === 'handoff_validate' && h.runId === a.run_id && h.attemptId === a.id && h.epoch === a.epoch && h.token === a.token, 'seal_fence')
      // The boundary ledger includes the final sealed state. No half-written pointer exists.
      l.state = 'sealed'
      validateHandoff(h, l, bundle, max)
      invariant(canonical(this.scrubber.scrub(h)) === canonical(h), 'unscrubbed_handoff')
      const prior = db.prepare('SELECT handoff FROM relay_seals WHERE run_id=? AND cycle=?').get(a.run_id, l.cycle)
      invariant(!prior, 'already_sealed')
      db.prepare('INSERT INTO relay_seals VALUES (?,?,?,?,?,?,?,?,?,?)').run(a.run_id, l.cycle, a.id, a.epoch, a.token, canonical(l), canonical(h), hash(h), renderHandoff(h), bundle)
      this.fault?.('seal_uploaded')
      db.prepare('UPDATE relay_runs SET snapshot=? WHERE run_id=?').run(canonical(l), a.run_id)
      this.fault?.('seal_pointer')
      this.event(emit, 'sealed', { cycle: l.cycle, ledgerHash: h.ledgerHash, bundleHash: byteHash(bundle) })
      this.fault?.('seal_trace')
    })
    this.fault?.('seal_committed')
  }
  sealed(a: Attempt): { handoff: Handoff; ledger: Ledger; bundle: Uint8Array; artifactHash: string } | null {
    this.read(a.run_id)
    const lease = this.db.prepare('SELECT holder,epoch,token FROM leases WHERE key=?').get(`run:${a.run_id}/exec`)
    if (!lease || lease.holder !== a.id || lease.epoch !== a.epoch || lease.token !== a.token) return null
    // Every seal was fence-checked at upload; a newly admitted attempt still needs the
    // run's latest handoff, not only seals written under its own token.
    const r = this.db.prepare('SELECT * FROM relay_seals WHERE run_id=? ORDER BY cycle DESC LIMIT 1').get(a.run_id)
    if (!r) return null
    let handoff: Handoff
    try { handoff = JSON.parse(String(r.handoff)) } catch { handoff = null as unknown as Handoff }
    // Invalid artifact JSON is a failed integrity probe, not a failure to read the ledger.
    return { handoff, ledger: JSON.parse(String(r.ledger)), bundle: r.bundle as Uint8Array, artifactHash: String(r.artifact_hash) }
  }
}
import { render as renderHandoff } from './handoff.ts'
