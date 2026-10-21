import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { validatePlan, type Plan } from './protocol.ts'
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
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  /** Keep the worst-case reservation charged, including crashes/unknown usage. No automatic refunds. */
  settle(id: string) { this.db.prepare("UPDATE reservations SET state='settled' WHERE id=?").run(id) }
  rows() { return this.db.prepare('SELECT id, month, day, provider, dollars, tokens, state FROM reservations ORDER BY id').all() }
  close() { this.db.close() }
}
