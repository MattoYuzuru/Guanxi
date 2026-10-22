import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { schedule, validatePlan, type Plan } from './protocol.ts'
import { checkedQuote, requestUsageSchema, type RequestIdentity, type RequestReservation, type RequestUsage } from './request-admission.ts'
const MONTHLY_CAP = 200_000_000 // D-150; USD micro-units, never floating dollars.
export class Budget {
  private db: DatabaseSync
  private clock: () => Date
  constructor(path: string, clock: () => Date = () => new Date()) {
    this.clock = clock
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, month TEXT NOT NULL,
        day TEXT NOT NULL, provider TEXT NOT NULL, dollars INTEGER NOT NULL,
        tokens INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','settled'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS request_runs (
        run_id TEXT PRIMARY KEY REFERENCES reservations(id), model TEXT NOT NULL,
        deadline_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS request_trials (
        run_id TEXT NOT NULL REFERENCES reservations(id), task TEXT NOT NULL, arm TEXT NOT NULL,
        seed INTEGER NOT NULL, max_cost INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
        max_steps INTEGER NOT NULL, halted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(run_id,task,arm,seed)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS request_reservations (
        run_id TEXT NOT NULL, request_id TEXT NOT NULL, task TEXT NOT NULL, arm TEXT NOT NULL,
        seed INTEGER NOT NULL, tokens INTEGER NOT NULL, cost INTEGER NOT NULL, quote TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown','breached')),
        usage TEXT, PRIMARY KEY(run_id,request_id),
        FOREIGN KEY(run_id,task,arm,seed) REFERENCES request_trials(run_id,task,arm,seed)
      ) STRICT;`)
  }
  reserve(raw: Plan, now = this.clock()): void {
    const p = validatePlan(raw, now)
    const perArm = p.tasks.length * p.seeds.length * p.maxTrialMicrousd
    const dollars = perArm * p.arms.length
    const tokens = p.tasks.length * p.seeds.length * p.maxTrialTokens * p.arms.length
    if (![perArm, dollars, tokens].every(Number.isSafeInteger)) throw new Error('budget_overflow')
    const iso = now.toISOString(); const day = iso.slice(0, 10); const month = iso.slice(0, 7)
    if ((dollars > 0 || tokens > 0) && new Date(now.getTime() + p.timeoutSec * 1000).toISOString().slice(0, 10) !== day) throw new Error('run_crosses_utc_budget_day')
    const fingerprint = createHash('sha256').update(JSON.stringify(p)).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('SELECT id FROM reservations WHERE id=?').get(p.id)) throw new Error('run_already_reserved')
      const spent = this.db.prepare('SELECT COALESCE(SUM(dollars),0) n FROM reservations WHERE month=?').get(month) as { n: number }
      const daily = this.db.prepare('SELECT COALESCE(SUM(tokens),0) n FROM reservations WHERE day=? AND provider=?').get(day, p.provider) as { n: number }
      // MUTATION: budget-guard
      if (perArm > p.armCapMicrousd || spent.n + dollars > MONTHLY_CAP || daily.n + tokens > p.dailyTokenCap) throw new Error('budget_cap_exceeded')
      this.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?)').run(p.id, fingerprint, month, day, p.provider, dollars, tokens, 'reserved')
      this.db.prepare('INSERT INTO request_runs VALUES (?,?,?)').run(p.id, p.model, now.getTime() + p.timeoutSec * 1000)
      const trial = this.db.prepare('INSERT INTO request_trials (run_id,task,arm,seed,max_cost,max_tokens,max_steps) VALUES (?,?,?,?,?,?,?)')
      for (const { task, arm, seed } of schedule(p)) trial.run(p.id, task.id, arm.id, seed, p.maxTrialMicrousd, p.maxTrialTokens, p.maxSteps)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  /** Consume the already-charged experiment envelope, never a second monthly charge.
   * Holds survive failure/restart; no request identifier may dispatch twice. */
  admitRequest(identity: RequestIdentity, rawQuote: unknown): RequestReservation {
    if (![identity.runId, identity.task, identity.arm, identity.requestId].every(value => typeof value === 'string' && value.length > 0) ||
      !Number.isSafeInteger(identity.seed) || identity.seed < 0) throw new Error('request_identity_invalid')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // A competing writer may hold the lock past quote/run expiry. Sample the
      // injected clock only after admission owns the ledger transaction.
      const now = this.clock()
      const { quote, tokens, costMicrousd } = checkedQuote(rawQuote, now)
      const run = this.db.prepare(`SELECT r.provider,r.day,r.state,q.model,q.deadline_at FROM reservations r
        JOIN request_runs q ON q.run_id=r.id WHERE r.id=?`).get(identity.runId) as
        { provider: string; day: string; state: string; model: string; deadline_at: number } | undefined
      if (!run || run.state !== 'reserved') throw new Error('request_run_not_open')
      if (run.day !== now.toISOString().slice(0, 10) || now.getTime() >= run.deadline_at) throw new Error('request_run_expired')
      if (quote.provider !== run.provider || quote.model !== run.model) throw new Error('request_model_mismatch')
      const trial = this.db.prepare('SELECT * FROM request_trials WHERE run_id=? AND task=? AND arm=? AND seed=?')
        .get(identity.runId, identity.task, identity.arm, identity.seed) as
        { max_cost: number; max_tokens: number; max_steps: number; halted: number } | undefined
      if (!trial) throw new Error('request_trial_unknown')
      if (trial.halted) throw new Error('request_trial_halted')
      if (this.db.prepare('SELECT 1 FROM request_reservations WHERE run_id=? AND request_id=?').get(identity.runId, identity.requestId)) throw new Error('request_already_admitted')
      if (this.db.prepare(`SELECT 1 FROM request_reservations WHERE run_id=? AND task=? AND arm=? AND seed=? AND state='reserved'`)
        .get(identity.runId, identity.task, identity.arm, identity.seed)) throw new Error('request_in_flight_or_unreconciled')
      const used = this.db.prepare(`SELECT COUNT(*) steps,COALESCE(SUM(tokens),0) tokens,COALESCE(SUM(cost),0) cost
        FROM request_reservations WHERE run_id=? AND task=? AND arm=? AND seed=?`)
        .get(identity.runId, identity.task, identity.arm, identity.seed) as { steps: number; tokens: number; cost: number }
      if (used.steps >= trial.max_steps || tokens > trial.max_tokens - used.tokens || costMicrousd > trial.max_cost - used.cost) throw new Error('request_budget_exceeded')
      this.db.prepare('INSERT INTO request_reservations VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(identity.runId, identity.requestId, identity.task, identity.arm, identity.seed, tokens, costMicrousd, JSON.stringify(quote), 'reserved', null)
      this.db.exec('COMMIT')
      return { requestId: identity.requestId, tokens, costMicrousd }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Unknown or out-of-bound observations retain the whole hold and stop the trial. */
  settleRequest(runId: string, requestId: string, usage: RequestUsage | null): void {
    if (usage !== null) {
      usage = requestUsageSchema.parse(usage)
      if (Date.parse(usage.observedAt) > this.clock().getTime()) throw new Error('request_usage_invalid')
    }
    this.db.exec('BEGIN IMMEDIATE')
    let breached = false
    try {
      const row = this.db.prepare('SELECT * FROM request_reservations WHERE run_id=? AND request_id=?').get(runId, requestId) as
        { task: string; arm: string; seed: number; tokens: number; cost: number; state: string; usage: string | null } | undefined
      if (!row) throw new Error('request_not_admitted')
      const serialized = usage === null ? null : JSON.stringify(usage)
      if (row.state !== 'reserved') {
        if (row.usage !== serialized) throw new Error('request_already_settled')
        if (row.state === 'breached') throw new Error('request_bound_violated')
        this.db.exec('COMMIT'); return
      }
      breached = usage !== null && (usage.tokens > row.tokens || usage.costMicrousd > row.cost)
      const state = usage === null ? 'unknown' : breached ? 'breached' : 'settled'
      this.db.prepare('UPDATE request_reservations SET state=?,usage=? WHERE run_id=? AND request_id=?').run(state, serialized, runId, requestId)
      if (state !== 'settled') this.db.prepare('UPDATE request_trials SET halted=1 WHERE run_id=? AND task=? AND arm=? AND seed=?').run(runId, row.task, row.arm, row.seed)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (breached) throw new Error('request_bound_violated')
  }
  requestRows() { return this.db.prepare('SELECT run_id,request_id,task,arm,seed,tokens,cost,state FROM request_reservations ORDER BY run_id,request_id').all() }
  /** Keep the worst-case reservation charged, including crashes/unknown usage. No automatic refunds. */
  settle(id: string) { this.db.prepare("UPDATE reservations SET state='settled' WHERE id=?").run(id) }
  rows() { return this.db.prepare('SELECT id, month, day, provider, dollars, tokens, state FROM reservations ORDER BY id').all() }
  close() { this.db.close() }
}
