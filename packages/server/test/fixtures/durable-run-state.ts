import type { Db } from '../../src/store/db.ts'

/** Stable domain projection across independent processes with fresh UUIDs. */
export function runStateSnapshot(db: Db): unknown {
  const runs = db.prepare('SELECT * FROM durable_runs').all() as unknown as { id: string; parent_id: string | null }[]
  const promises = db.prepare('SELECT * FROM promises').all() as unknown as { id: string; child_id: string; parent_id: string; delegation_key: string }[]
  const ids = new Map<string, string>()
  const key = (id: string): string => {
    const run = runs.find((r) => r.id === id)!
    const promise = promises.find((p) => p.child_id === id)
    return run.parent_id ? `${key(run.parent_id)}/${promise!.delegation_key}` : id
  }
  for (const run of runs) ids.set(run.id, key(run.id))
  for (const p of promises) ids.set(p.id, `${key(p.parent_id)}/promise:${p.delegation_key}`)
  for (const a of db.prepare('SELECT id,run_id,ordinal FROM run_attempts').all() as unknown as { id: string; run_id: string; ordinal: number }[]) {
    ids.set(a.id, `${key(a.run_id)}/attempt:${a.ordinal}`)
  }
  for (const w of db.prepare('SELECT * FROM outbox').all() as unknown as { source_key: string; run_id: string; wake_seq: number }[]) {
    if (!ids.has(w.source_key)) ids.set(w.source_key, `${key(w.run_id)}/source:${w.wake_seq}`)
  }
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      for (const [id, name] of ids) value = (value as string).replaceAll(id, name)
      return value
    }
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
    return value
  }
  const tables: Record<string, unknown> = {}
  for (const table of ['durable_runs', 'run_attempts', 'promises', 'timers', 'outbox', 'run_resources', 'run_costs']) {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all().map((r) => JSON.stringify(normalize(r))).sort()
  }
  tables.leases = db.prepare("SELECT key,epoch,token,holder,expires_at,released FROM leases WHERE key LIKE 'run:%/exec'").all().map((r) => JSON.stringify(normalize(r))).sort()
  tables.events = db.prepare('SELECT seq,type,payload,writer_epoch FROM session_events ORDER BY session_id,seq').all().map((r) => normalize({ ...r, payload: JSON.parse(r.payload as string) }))
  return tables
}
