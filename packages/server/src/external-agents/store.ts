import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EgressScrubber } from '../egress/types.ts'
import { rolesSchema, quotaObservationSchema, type Roles, type QuotaObservation, type AdapterId, type Fact, ExternalAgentError } from './types.ts'

/** No vendor state is stored here. Migrations are local to this sidecar and append-only. */
export class ExternalStore {
  readonly db: DatabaseSync
  private readonly scrubber: EgressScrubber
  constructor(path: string, scrubber: EgressScrubber) {
    this.scrubber = scrubber
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS k5_migrations(version INTEGER PRIMARY KEY);`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare('SELECT version FROM k5_migrations WHERE version=1').get()) {
        this.db.exec(`
          CREATE TABLE project_roles(owner TEXT NOT NULL, project TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,project));
          CREATE TABLE editor_grants(owner TEXT NOT NULL, connection TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(owner,connection,actor));
          CREATE TABLE quota_reports(owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, node TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,account,adapter,node));
          CREATE TABLE concurrency(owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, successful INTEGER, rejected INTEGER, observed_at TEXT NOT NULL, PRIMARY KEY(owner,account,adapter));
          INSERT INTO k5_migrations VALUES(1);`)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) chmodSync(file, 0o600)
  }
  private ready() { if (!this.scrubber.isReady()) throw new ExternalAgentError('egress_unavailable') }
  setRoles(owner: string, project: string, roles: Roles) {
    this.ready()
    const safe = rolesSchema.parse(this.scrubber.scrub(rolesSchema.parse(roles)))
    this.db.prepare('INSERT OR REPLACE INTO project_roles VALUES(?,?,?)').run(owner, project, JSON.stringify(safe))
    return safe
  }
  roles(owner: string, project: string): Roles {
    this.ready()
    const row = this.db.prepare('SELECT data FROM project_roles WHERE owner=? AND project=?').get(owner, project)
    return rolesSchema.parse(this.scrubber.scrub(row ? JSON.parse(String(row.data)) : {}))
  }
  grant(owner: string, connection: string, actor: string, allowed: boolean) {
    this.ready()
    if (allowed) this.db.prepare('INSERT OR IGNORE INTO editor_grants VALUES(?,?,?)').run(owner, connection, actor)
    else this.db.prepare('DELETE FROM editor_grants WHERE owner=? AND connection=? AND actor=?').run(owner, connection, actor)
  }
  editorAllowed(owner: string, connection: string, actor: string) {
    return !!this.db.prepare('SELECT 1 FROM editor_grants WHERE owner=? AND connection=? AND actor=?').get(owner, connection, actor)
  }
  observe(input: QuotaObservation, now: number) {
    this.ready()
    const report = quotaObservationSchema.parse(this.scrubber.scrub(quotaObservationSchema.parse(input)))
    report.observedAt = new Date(report.observedAt).toISOString()
    report.windows = report.windows.map(window => ({ ...window, resetsAt: window.resetsAt ? new Date(window.resetsAt).toISOString() : null }))
    if (Date.parse(report.observedAt) > now) throw new ExternalAgentError('future_observation')
    const previous = this.db.prepare('SELECT data FROM quota_reports WHERE owner=? AND account=? AND adapter=? AND node=?')
      .get(report.ownerAccountId, report.billingAccount, report.adapter, report.nodeId)
    if (previous && Date.parse(JSON.parse(String(previous.data)).observedAt) > Date.parse(report.observedAt)) return
    this.db.prepare('INSERT OR REPLACE INTO quota_reports VALUES(?,?,?,?,?)')
      .run(report.ownerAccountId, report.billingAccount, report.adapter, report.nodeId, JSON.stringify(report))
  }
  limits(owner: string, account: string, adapter: AdapterId, now: number, maxAgeMs: number) {
    this.ready()
    const reports = this.db.prepare('SELECT data FROM quota_reports WHERE owner=? AND account=? AND adapter=?').all(owner, account, adapter)
      .map(row => quotaObservationSchema.parse(this.scrubber.scrub(JSON.parse(String(row.data)))))
    const fresh = reports.filter(r => now - Date.parse(r.observedAt) <= maxAgeMs)
    // Account windows are already pooled by the vendor. Never sum device percentages.
    // Preserve reset-window identity; differing periods are distinct facts, not comparable totals.
    const windows = new Map<string, { name: string; resetsAt: string | null; used: Fact<number>; nodes: string[] }>()
    for (const report of fresh) for (const window of report.windows) {
      const key = JSON.stringify([window.name, window.resetsAt])
      const prior = windows.get(key)
      const value = window.usedPercent
      if (!prior) windows.set(key, { name: window.name, resetsAt: window.resetsAt,
        used: { value, source: report.source, observedAt: report.observedAt, confidence: value === null ? 'unknown' : report.confidence }, nodes: [report.nodeId] })
      else {
        prior.nodes.push(report.nodeId)
        if (value !== null && (prior.used.value === null || value > prior.used.value)) prior.used = {
          value, source: report.source, observedAt: report.observedAt, confidence: report.confidence,
        }
      }
    }
    return { windows: [...windows.values()], reports, stale: reports.length > fresh.length,
      known: [...windows.values()].some(w => w.used.value !== null) }
  }
  learn(owner: string, account: string, adapter: AdapterId, parallel: number, outcome: 'success' | 'concurrency_rejected', now: string) {
    this.ready()
    const row = this.db.prepare('SELECT successful,rejected FROM concurrency WHERE owner=? AND account=? AND adapter=?').get(owner, account, adapter)
    let successful = row?.successful == null ? null : Number(row.successful)
    let rejected = row?.rejected == null ? null : Number(row.rejected)
    if (outcome === 'success') successful = Math.max(successful ?? 0, parallel)
    else rejected = Math.min(rejected ?? Infinity, parallel)
    this.db.prepare('INSERT OR REPLACE INTO concurrency VALUES(?,?,?,?,?,?)').run(owner, account, adapter, successful, rejected, now)
  }
  learning(owner: string, account: string, adapter: AdapterId) {
    this.ready()
    const row = this.db.prepare('SELECT successful,rejected,observed_at FROM concurrency WHERE owner=? AND account=? AND adapter=?').get(owner, account, adapter)
    return { successful: row?.successful == null ? null : Number(row.successful),
      rejectedAt: row?.rejected == null ? null : Number(row.rejected),
      source: 'local_dispatch_observations', observedAt: row ? String(row.observed_at) : null,
      confidence: row ? 'low' as const : 'unknown' as const }
  }
  close() { this.db.close() }
}
