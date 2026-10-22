import type { Attempt } from '../runs/types.ts'
import { canonical, hash } from './handoff.ts'
import { invariant } from './types.ts'
import type { RelayStore } from './store.ts'
import { copyBrief, nightKey, type RelayDelegationBrief } from './delegation-brief.ts'

/** Independent additive ledger 38; main user_version and existing ledgers are untouched. */
export const JUDGE_MIGRATION_38 = `
CREATE TABLE relay_judge_migrations(version INTEGER PRIMARY KEY);
INSERT INTO relay_judge_migrations VALUES(38);
CREATE TABLE relay_judge_accounts(account_id TEXT PRIMARY KEY, night_policy TEXT NOT NULL);
CREATE TABLE relay_briefs(run_id TEXT PRIMARY KEY REFERENCES relay_runs(run_id), digest TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE relay_brief_attempts(attempt_id TEXT PRIMARY KEY REFERENCES run_attempts(id), run_id TEXT NOT NULL REFERENCES relay_briefs(run_id), epoch INTEGER NOT NULL, token INTEGER NOT NULL, digest TEXT NOT NULL);
CREATE TABLE relay_judge_requests(key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES relay_briefs(run_id), attempt_id TEXT NOT NULL,
 cycle INTEGER NOT NULL, phase TEXT NOT NULL, layer TEXT NOT NULL, reason TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
 payload TEXT, created_at INTEGER NOT NULL);
CREATE TABLE relay_judge_debits(key TEXT PRIMARY KEY REFERENCES relay_judge_requests(key), account_id TEXT NOT NULL, night TEXT NOT NULL,
 tokens INTEGER NOT NULL, money INTEGER NOT NULL, override_id TEXT);
CREATE TABLE relay_judge_availability(run_id TEXT NOT NULL REFERENCES relay_briefs(run_id), cycle INTEGER NOT NULL, available INTEGER NOT NULL,
 PRIMARY KEY(run_id,cycle));
CREATE TRIGGER relay_briefs_immutable BEFORE UPDATE ON relay_briefs BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER relay_briefs_no_delete BEFORE DELETE ON relay_briefs BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER relay_judge_debits_immutable BEFORE UPDATE ON relay_judge_debits BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER relay_judge_debits_no_delete BEFORE DELETE ON relay_judge_debits BEGIN SELECT RAISE(ABORT,'append only'); END;
`
export type JudgeLayer = 'J1.5' | 'J2' | 'J3'
export type JudgeRequestState =
  'prepared' | 'dispatched' | 'completed' | 'unavailable' | 'invalid' | 'abandoned'
export interface JudgeRequest {
  key: string
  state: JudgeRequestState
  payload: unknown
  fresh: boolean
}
export interface JudgeIdentity {
  cycle: number
  phase: string
  layer: JudgeLayer
  reason: string
}
export function judgeRequestKey(
  a: Attempt,
  brief: RelayDelegationBrief,
  identity: JudgeIdentity
): string {
  return hash({
    run: a.run_id,
    attempt: a.id,
    epoch: a.epoch,
    token: a.token,
    ...identity,
    policyHash: hash(brief)
  })
}
export class JudgeStore {
  readonly relay: RelayStore
  constructor(relay: RelayStore) {
    this.relay = relay
    relay.runs.homeFence().transaction('judge_migration', (db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_judge_migrations'").get())
        db.exec(JUDGE_MIGRATION_38)
      const versions = db.prepare('SELECT version FROM relay_judge_migrations').all()
      invariant(versions.length === 1 && versions[0]!.version === 38, 'judge_schema_version')
      // Only inherited/lost ownership is abandoned. Constructing another cascade must not
      // abandon a different live run in this process. No dispatch is replayed by recovery.
      db.prepare(
        `UPDATE relay_judge_requests SET state='abandoned',payload=NULL WHERE state IN ('prepared','dispatched')
        AND NOT EXISTS (SELECT 1 FROM run_attempts a JOIN leases l ON l.key='run:'||a.run_id||'/exec'
        WHERE a.id=attempt_id AND a.state IN ('delivered','started') AND l.holder=a.id AND l.epoch=a.epoch AND l.token=a.token AND l.released=0 AND l.expires_at>?)`
      ).run(relay.clock())
    })
  }
  check(a: Attempt, cycle?: number): void {
    this.relay.runs.mutate(a, () => {
      if (cycle !== undefined)
        invariant(this.relay.read(a.run_id).cycle === cycle, 'judge_stale_cycle')
    })
  }
  bind(a: Attempt, raw: RelayDelegationBrief): RelayDelegationBrief {
    return this.relay.runs.mutate(a, (db, emit) => {
      const ledger = this.relay.read(a.run_id),
        brief = copyBrief(raw, ledger.plan)
      invariant(hash(brief.caps) === hash(ledger.caps), 'brief_caps_conflict')
      const nightPolicy = canonical({
        timeZone: brief.wake.timeZone,
        nightStartsHour: brief.wake.nightStartsHour
      })
      const account = db
        .prepare('SELECT night_policy FROM relay_judge_accounts WHERE account_id=?')
        .get(brief.identity.accountId)
      if (account) invariant(account.night_policy === nightPolicy, 'brief_account_night_conflict')
      else
        db.prepare('INSERT INTO relay_judge_accounts VALUES(?,?)').run(
          brief.identity.accountId,
          nightPolicy
        )
      invariant(
        canonical(this.relay.scrubber.scrub(brief)) === canonical(brief),
        'unscrubbed_brief'
      )
      const digest = hash(brief),
        prior = db.prepare('SELECT digest FROM relay_briefs WHERE run_id=?').get(a.run_id)
      if (prior) invariant(prior.digest === digest, 'brief_conflict')
      else {
        db.prepare('INSERT INTO relay_briefs VALUES(?,?,?)').run(a.run_id, digest, canonical(brief))
        emit({ type: 'agent.note', data: { text: canonical({ relay: 'brief_bound', digest }) } })
      }
      const binding = db.prepare('SELECT * FROM relay_brief_attempts WHERE attempt_id=?').get(a.id)
      if (binding)
        invariant(
          binding.digest === digest &&
            binding.epoch === a.epoch &&
            binding.token === a.token &&
            binding.run_id === a.run_id,
          'brief_attempt_conflict'
        )
      else {
        db.prepare('INSERT INTO relay_brief_attempts VALUES(?,?,?,?,?)').run(
          a.id,
          a.run_id,
          a.epoch,
          a.token,
          digest
        )
        emit({
          type: 'agent.note',
          data: {
            text: canonical({
              relay: 'brief_attempt_bound',
              digest,
              attemptId: a.id,
              epoch: a.epoch,
              token: a.token
            })
          }
        })
      }
      return brief
    })
  }
  prepare(
    a: Attempt,
    brief: RelayDelegationBrief,
    identity: JudgeIdentity,
    evidence: unknown
  ): JudgeRequest {
    return this.relay.runs.mutate(a, (db, emit) => {
      invariant(this.relay.read(a.run_id).cycle === identity.cycle, 'judge_stale_cycle')
      const key = judgeRequestKey(a, brief, identity)
      const digest = hash(evidence)
      const old = db.prepare('SELECT * FROM relay_judge_requests WHERE key=?').get(key)
      if (old) {
        invariant(old.digest === digest, 'judge_request_conflict')
        return {
          key,
          state: old.state as JudgeRequestState,
          payload: old.payload ? this.relay.scrubber.scrub(JSON.parse(String(old.payload))) : null,
          fresh: false
        }
      }
      db.prepare('INSERT INTO relay_judge_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        key,
        a.run_id,
        a.id,
        identity.cycle,
        identity.phase,
        identity.layer,
        identity.reason,
        digest,
        'prepared',
        null,
        this.relay.clock()
      )
      emit({
        type: 'agent.note',
        data: { text: canonical({ relay: 'judge_prepared', key, ...identity }) }
      })
      return { key, state: 'prepared', payload: null, fresh: true }
    })
  }
  dispatch(
    a: Attempt,
    brief: RelayDelegationBrief,
    request: JudgeRequest,
    identity: JudgeIdentity
  ): void {
    this.relay.runs.mutate(a, (db, emit) => {
      invariant(this.relay.read(a.run_id).cycle === identity.cycle, 'judge_stale_cycle')
      const row = db
        .prepare('SELECT state FROM relay_judge_requests WHERE key=? AND attempt_id=?')
        .get(request.key, a.id)
      invariant(row?.state === 'prepared', 'judge_request_state')
      if (identity.layer !== 'J1.5') {
        const role = identity.layer === 'J3' ? brief.roles.j3 : brief.roles.j2
        invariant(role, 'judge_model_unavailable')
        const count = identity.layer === 'J2' ? brief.judges.samples : 1
        const l = this.relay.read(a.run_id),
          tokens = count * role.tokenReserve,
          money = count * role.moneyReserveMicros
        invariant(
          Number.isSafeInteger(tokens) &&
            Number.isSafeInteger(money) &&
            Number.isSafeInteger(l.tokens + tokens) &&
            Number.isSafeInteger(l.moneyMicros + money),
          'judge_budget_exhausted'
        )
        invariant(
          (l.caps.tokens === null || l.tokens + tokens <= l.caps.tokens) &&
            (l.caps.moneyMicros === null || l.moneyMicros + money <= l.caps.moneyMicros),
          'judge_budget_exhausted'
        )
        l.tokens += tokens
        l.moneyMicros += money
        db.prepare('UPDATE relay_runs SET snapshot=? WHERE run_id=?').run(canonical(l), a.run_id)
      }
      if (identity.layer === 'J3') {
        invariant(
          ['flagged', 'final', 'probes', 'no_progress'].includes(identity.reason),
          'judge_reason_denied'
        )
        const policy = brief.judges.j3,
          role = brief.roles.j3
        invariant(policy.enabled && role, 'judge_j3_disabled')
        const night = nightKey(brief.wake, this.relay.clock())
        const sums = db
          .prepare(
            'SELECT count(*) AS calls,coalesce(sum(tokens),0) AS tokens,coalesce(sum(money),0) AS money FROM relay_judge_debits WHERE account_id=? AND night=?'
          )
          .get(brief.identity.accountId, night)!
        const run = db
          .prepare(
            'SELECT count(*) AS calls FROM relay_judge_debits d JOIN relay_judge_requests r ON d.key=r.key WHERE r.run_id=?'
          )
          .get(a.run_id)!
        invariant(
          Number(sums.calls) < policy.maxCallsPerNight &&
            Number(run.calls) < policy.maxCallsPerRun &&
            Number(sums.tokens) + role.tokenReserve <= policy.tokenCapPerNight &&
            Number(sums.money) + role.moneyReserveMicros <= policy.moneyCapPerNightMicros,
          'judge_budget_exhausted'
        )
        db.prepare('INSERT INTO relay_judge_debits VALUES(?,?,?,?,?,?)').run(
          request.key,
          brief.identity.accountId,
          night,
          role.tokenReserve,
          role.moneyReserveMicros,
          policy.override?.id ?? null
        )
      }
      db.prepare("UPDATE relay_judge_requests SET state='dispatched' WHERE key=?").run(request.key)
      emit({
        type: 'agent.note',
        data: {
          text: canonical({ relay: 'judge_dispatched', key: request.key, layer: identity.layer })
        }
      })
    })
  }
  finish(
    a: Attempt,
    cycle: number,
    key: string,
    state: Exclude<JudgeRequestState, 'prepared' | 'dispatched'>,
    payload: unknown
  ): JudgeRequest {
    return this.relay.runs.mutate(a, (db, emit) => {
      invariant(this.relay.read(a.run_id).cycle === cycle, 'judge_stale_cycle')
      const row = db
        .prepare('SELECT state FROM relay_judge_requests WHERE key=? AND attempt_id=?')
        .get(key, a.id)
      invariant(
        row && ['prepared', 'dispatched'].includes(String(row.state)),
        'judge_request_state'
      )
      const clean = this.relay.scrubber.scrub(payload)
      db.prepare('UPDATE relay_judge_requests SET state=?,payload=? WHERE key=?').run(
        state,
        canonical(clean),
        key
      )
      emit({ type: 'agent.note', data: { text: canonical({ relay: 'judge_result', key, state }) } })
      return { key, state, payload: clean, fresh: false }
    })
  }
  availability(a: Attempt, cycle: number, available: boolean): void {
    this.relay.runs.mutate(a, (db) => {
      invariant(this.relay.read(a.run_id).cycle === cycle, 'judge_stale_cycle')
      db.prepare(
        `INSERT INTO relay_judge_availability VALUES(?,?,?) ON CONFLICT(run_id,cycle)
        DO UPDATE SET available=max(available,excluded.available)`
      ).run(a.run_id, cycle, Number(available))
    })
  }
  /** Evaluate once at pre-seal, after both phases. A valid sample group anywhere in a cycle
   * resets the streak; phases and samples cannot count as separate unavailable cycles. */
  unavailableStreak(a: Attempt, cycle: number): number {
    this.check(a, cycle)
    const rows = this.relay.db
      .prepare(
        'SELECT cycle,available FROM relay_judge_availability WHERE run_id=? AND cycle<=? ORDER BY cycle DESC'
      )
      .all(a.run_id, cycle)
    let streak = 0,
      expected = cycle
    for (const row of rows) {
      if (row.cycle !== expected || row.available) break
      streak++
      expected--
    }
    return streak
  }
  snapshot(a: Attempt, brief: RelayDelegationBrief): void {
    this.relay.change(a, 'judge_snapshot', (l) => {
      invariant(!['sealed', 'finish'].includes(l.state), 'judge_sealed_snapshot')
      l.judge = {
        briefHash: hash(brief),
        requestedWake: Object.values(l.items).every((s) => s === 'done')
          ? brief.wake.completion === 'defer'
            ? 'defer_completion_until_08'
            : 'immediate_completion'
          : 'none',
        requests: this.relay.db
          .prepare(
            'SELECT key,state FROM relay_judge_requests WHERE run_id=? AND cycle=? ORDER BY key'
          )
          .all(a.run_id, l.cycle)
          .map((r) => ({ key: String(r.key), state: String(r.state) }))
      }
    })
  }
}
