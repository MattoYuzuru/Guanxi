import type { Db } from '../store/db.ts'
import { leadInvariant } from './types.ts'

// Independent additive ledger 41 in the SAME node database as R1 and K2, so lead rows commit
// inside R1's fenced transactions. F1 owns 34, relay 35, remote attempts 36-37, relay judge 38,
// relay public start 39, the session queue (Q0) 40. No `user_version` change and no existing migration is edited.
export const LEAD_MIGRATION = `
CREATE TABLE lead_migrations (version INTEGER PRIMARY KEY);
INSERT INTO lead_migrations VALUES (41);
CREATE TABLE lead_sessions (
  run_id TEXT PRIMARY KEY REFERENCES durable_runs(id),
  owner_account_id TEXT NOT NULL, actor_account_id TEXT NOT NULL, project_id TEXT NOT NULL,
  session_roles TEXT NOT NULL, fallback TEXT, binding_digest TEXT NOT NULL, fallback_used INTEGER NOT NULL DEFAULT 0,
  task TEXT NOT NULL, handoff TEXT NOT NULL DEFAULT '',
  acp_session_id TEXT, load_session INTEGER,
  failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0);
CREATE TABLE lead_delegations (
  lead_run_id TEXT NOT NULL REFERENCES lead_sessions(run_id), key TEXT NOT NULL, brief TEXT NOT NULL,
  deadline INTEGER NOT NULL, on_deadline TEXT NOT NULL, on_cancel TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent','delegated','child_started','child_stop_requested','abandoned')),
  child_run_id TEXT REFERENCES durable_runs(id), PRIMARY KEY (lead_run_id, key));
CREATE TABLE lead_wakes (
  run_id TEXT NOT NULL REFERENCES lead_sessions(run_id), wake_seq INTEGER NOT NULL, packet TEXT NOT NULL,
  packet_hash TEXT NOT NULL, resume_mode TEXT CHECK (resume_mode IS NULL OR resume_mode IN ('load','seeded','new')),
  PRIMARY KEY (run_id, wake_seq));
CREATE TRIGGER lead_wakes_packet_immutable BEFORE UPDATE OF run_id, wake_seq, packet, packet_hash ON lead_wakes
  BEGIN SELECT RAISE(ABORT, 'wake packet is immutable'); END;
CREATE TRIGGER lead_wakes_no_delete BEFORE DELETE ON lead_wakes BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER lead_delegations_brief_immutable BEFORE UPDATE OF lead_run_id, key, brief, deadline, on_deadline, on_cancel ON lead_delegations
  BEGIN SELECT RAISE(ABORT, 'delegation intent is immutable'); END;
`
export interface LeadSession {
  run_id: string; owner_account_id: string; actor_account_id: string; project_id: string
  session_roles: string; fallback: string | null; binding_digest: string; fallback_used: number
  task: string; handoff: string; acp_session_id: string | null; load_session: number | null
  failures: number; retry_at: number; turns: number
}
export type DelegationState = 'intent' | 'delegated' | 'child_started' | 'child_stop_requested' | 'abandoned'
export interface LeadDelegation {
  lead_run_id: string; key: string; brief: string; deadline: number; on_deadline: 'wrap_up' | 'detach'
  on_cancel: 'cancel' | 'detach'; state: DelegationState; child_run_id: string | null
}
export interface LeadWakeRow { run_id: string; wake_seq: number; packet: string; packet_hash: string; resume_mode: string | null }

/** Reads are free; every write takes the transaction handle of an R1 fenced extension call. */
export class LeadStore {
  readonly db: Db
  constructor(db: Db) {
    this.db = db
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='lead_migrations'").get()) {
      db.exec('BEGIN IMMEDIATE')
      try { db.exec(LEAD_MIGRATION); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    const rows = db.prepare('SELECT version FROM lead_migrations').all()
    leadInvariant(rows.length === 1 && rows[0]!.version === 41, 'lead_schema_version')
  }
  session(runId: string): LeadSession | undefined {
    return this.db.prepare('SELECT * FROM lead_sessions WHERE run_id=?').get(runId) as unknown as LeadSession | undefined
  }
  sessions(): LeadSession[] { return this.db.prepare('SELECT * FROM lead_sessions ORDER BY run_id').all() as unknown as LeadSession[] }
  /** Each lead with its R1 run state (null when the run row is missing), for callers that must tell a finished lead from a live one. */
  sessionStates(): Array<LeadSession & { run_state: string | null }> {
    return this.db.prepare('SELECT s.*, r.state AS run_state FROM lead_sessions s LEFT JOIN durable_runs r ON r.id = s.run_id ORDER BY s.run_id').all() as unknown as Array<LeadSession & { run_state: string | null }>
  }
  delegation(runId: string, key: string): LeadDelegation | undefined {
    return this.db.prepare('SELECT * FROM lead_delegations WHERE lead_run_id=? AND key=?').get(runId, key) as unknown as LeadDelegation | undefined
  }
  delegations(runId?: string): LeadDelegation[] {
    return (runId === undefined ? this.db.prepare('SELECT * FROM lead_delegations ORDER BY lead_run_id, key').all()
      : this.db.prepare('SELECT * FROM lead_delegations WHERE lead_run_id=? ORDER BY key').all(runId)) as unknown as LeadDelegation[]
  }
  /** Delegations that still need the pump: an unfinished intent or child start of a live lead, a child that
   * was canceled and still has an executor to stop, or one that lost its executor. Retired rows are never read again. */
  openDelegations(): LeadDelegation[] {
    return this.db.prepare(`SELECT d.* FROM lead_delegations d
      JOIN durable_runs l ON l.id = d.lead_run_id LEFT JOIN durable_runs c ON c.id = d.child_run_id
      WHERE (d.state IN ('intent','delegated') AND l.state NOT IN ('completed','failed','canceled','rejected'))
         OR (d.state = 'child_started' AND (c.state = 'canceled' OR (c.state = 'interrupted' AND l.state NOT IN ('completed','failed','canceled','rejected'))))
      ORDER BY d.lead_run_id, d.key`).all() as unknown as LeadDelegation[]
  }
  delegationOfChild(childRunId: string): LeadDelegation | undefined {
    return this.db.prepare('SELECT * FROM lead_delegations WHERE child_run_id=?').get(childRunId) as unknown as LeadDelegation | undefined
  }
  wake(runId: string, wakeSeq: number): LeadWakeRow | undefined {
    return this.db.prepare('SELECT * FROM lead_wakes WHERE run_id=? AND wake_seq=?').get(runId, wakeSeq) as unknown as LeadWakeRow | undefined
  }
  wakes(runId: string): LeadWakeRow[] {
    return this.db.prepare('SELECT * FROM lead_wakes WHERE run_id=? ORDER BY wake_seq').all(runId) as unknown as LeadWakeRow[]
  }
  insertSession(db: Db, row: Pick<LeadSession, 'run_id' | 'owner_account_id' | 'actor_account_id' | 'project_id' | 'session_roles' | 'fallback' | 'binding_digest' | 'task'>): void {
    db.prepare(`INSERT INTO lead_sessions (run_id,owner_account_id,actor_account_id,project_id,session_roles,fallback,binding_digest,task)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.run_id, row.owner_account_id, row.actor_account_id, row.project_id, row.session_roles,
      row.fallback, row.binding_digest, row.task)
  }
  observeSession(db: Db, runId: string, acpSessionId: string, loadSession: boolean, bindingDigest: string): void {
    db.prepare('UPDATE lead_sessions SET acp_session_id=?, load_session=?, binding_digest=?, turns=turns+1 WHERE run_id=?')
      .run(acpSessionId, loadSession ? 1 : 0, bindingDigest, runId)
  }
  useFallback(db: Db, runId: string, digest: string): void {
    db.prepare('UPDATE lead_sessions SET fallback_used=1, binding_digest=?, acp_session_id=NULL, load_session=NULL WHERE run_id=?').run(digest, runId)
  }
  setHandoff(db: Db, runId: string, handoff: string): void {
    db.prepare('UPDATE lead_sessions SET handoff=? WHERE run_id=?').run(handoff, runId)
  }
  setRetry(db: Db, runId: string, failures: number, retryAt: number): void {
    db.prepare('UPDATE lead_sessions SET failures=?, retry_at=? WHERE run_id=?').run(failures, retryAt, runId)
  }
  insertIntent(db: Db, row: Omit<LeadDelegation, 'state' | 'child_run_id'>): void {
    db.prepare(`INSERT INTO lead_delegations (lead_run_id,key,brief,deadline,on_deadline,on_cancel,state) VALUES (?,?,?,?,?,?,'intent')`)
      .run(row.lead_run_id, row.key, row.brief, row.deadline, row.on_deadline, row.on_cancel)
  }
  setDelegationState(db: Db, runId: string, key: string, state: DelegationState, childRunId?: string): void {
    if (childRunId === undefined) db.prepare('UPDATE lead_delegations SET state=? WHERE lead_run_id=? AND key=?').run(state, runId, key)
    else db.prepare('UPDATE lead_delegations SET state=?, child_run_id=? WHERE lead_run_id=? AND key=?').run(state, childRunId, runId, key)
  }
  insertWake(db: Db, row: { runId: string; wakeSeq: number; packet: string; hash: string }): void {
    db.prepare('INSERT OR IGNORE INTO lead_wakes (run_id,wake_seq,packet,packet_hash) VALUES (?,?,?,?)').run(row.runId, row.wakeSeq, row.packet, row.hash)
  }
  setResumeMode(db: Db, runId: string, wakeSeq: number, mode: 'load' | 'seeded' | 'new'): void {
    db.prepare('UPDATE lead_wakes SET resume_mode=? WHERE run_id=? AND wake_seq=?').run(mode, runId, wakeSeq)
  }
}
