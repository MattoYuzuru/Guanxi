import { createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CHAT_RETENTION_DAYS, SESSION_TRASH_RECOVERY_HOURS, type SessionEventData } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import type { SessionLog } from '../session-log/log.ts'
import { assertRootsClean } from './cleanup.ts'

const DAY = 86400000
/** Thread-owned metadata and a durable deletion intent; filesystem cleanup is retryable. */
export class NativeSessions {
  readonly db: Db
  readonly log: SessionLog
  readonly dataDir: string
  constructor(db: Db, log: SessionLog, dataDir: string) { this.db = db; this.log = log; this.dataDir = dataDir }
  create(id: string, model: string, retention: 'keep' | 'ttl' | 'session', policy: SessionEventData<'agent.policy'>) {
    const now = new Date().toISOString()
    return this.log.open(id, { kind: 'agent', threadId: id }, {
      beforeAcquire: () => {
        this.db.prepare(`INSERT INTO threads(id,title,mode,model,num_ctx,temperature,think,
          created_at,updated_at,retention_policy,retention_policy_source,retention_policy_updated_at,
          last_user_activity_at,last_user_activity_source) VALUES (?,'Agent session','agent',?,4096,0.7,'auto',?,?,?,'default',?,?,'chat_created')`)
          .run(id, model, now, now, retention, now, now)
      },
      afterAcquire: () => {
        this.db.prepare('INSERT INTO native_sessions(session_id,thread_id) VALUES (?,?)').run(id, id)
        const head = this.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(id) as { last_seq: number }
        this.log.appendFromHomeWithin(id, { kind: 'agent', threadId: id }, { type: 'agent.policy', data: policy }, { expectedSeq: head.last_seq + 1 })
      },
    })
  }
  assertAvailable(id: string) {
    const row = this.db.prepare(`SELECT n.deletion_requested,n.trashed_at,n.leave_at FROM native_sessions n
      JOIN threads t ON t.id=n.thread_id WHERE n.session_id=?`).get(id)
    if (!row) throw new Error('session_not_found')
    if (row.deletion_requested || row.trashed_at !== null || row.leave_at !== null) throw new Error('session_expired')
  }
  retention(id: string) {
    const row = this.db.prepare(`SELECT t.retention_policy,n.trashed_at,n.leave_at,n.deletion_requested FROM native_sessions n JOIN threads t ON t.id=n.thread_id WHERE n.session_id=?`).get(id)
    if (!row) throw new Error('session_not_found')
    return { mode: row.retention_policy as 'keep' | 'ttl' | 'session', state: row.deletion_requested ? 'deleting' as const : row.trashed_at ? 'trash' as const : 'active' as const, expiresAt: this.expiry(id) ?? null, recoveryDeadline: row.leave_at && row.trashed_at ? new Date(Date.parse(String(row.trashed_at)) + SESSION_TRASH_RECOVERY_HOURS * 3600000).toISOString() : null }
  }
  setRetention(id: string, mode: 'keep' | 'ttl' | 'session') {
    const row = this.retention(id)
    if (row.state === 'trash' && mode === 'session') throw new Error('invalid_retention')
    if (row.state === 'deleting' || (row.recoveryDeadline && Date.parse(row.recoveryDeadline) <= Date.now())) throw new Error('session_busy')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = new Date().toISOString()
      this.db.prepare(`UPDATE threads SET retention_policy=?,retention_policy_source='user',retention_policy_updated_at=?,
        last_user_activity_at=CASE WHEN ?='trash' THEN ? ELSE last_user_activity_at END WHERE id=(SELECT thread_id FROM native_sessions WHERE session_id=?)`).run(mode, now, row.state, now, id)
      this.db.prepare('UPDATE native_sessions SET trashed_at=NULL,leave_at=NULL WHERE session_id=?').run(id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.retention(id)
  }
  leave(id: string) {
    const retention = this.retention(id)
    if (retention.state === 'deleting') throw new Error('session_busy')
    if (retention.mode !== 'session') throw new Error('invalid_retention')
    this.db.prepare('UPDATE native_sessions SET leave_at=? WHERE session_id=? AND leave_at IS NULL').run(new Date().toISOString(), id)
    return this.retention(id)
  }
  touch(id: string) {
    this.assertAvailable(id)
    this.db.prepare(`UPDATE threads SET last_user_activity_at=?,last_user_activity_source='user_message'
      WHERE id=(SELECT thread_id FROM native_sessions WHERE session_id=?)`).run(new Date().toISOString(), id)
  }
  expiry(id: string): string | undefined {
    const row = this.db.prepare(`SELECT retention_policy,last_user_activity_at,created_at FROM threads
      WHERE id=(SELECT thread_id FROM native_sessions WHERE session_id=?)`).get(id)
    if (!row || row.retention_policy !== 'ttl') return undefined
    return new Date(Date.parse(String(row.last_user_activity_at ?? row.created_at)) + CHAT_RETENTION_DAYS * DAY).toISOString()
  }
  paths(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid_session_id')
    return [join(this.dataDir, 'scratch', id), join(this.dataDir, 'native-attachments', id),
      join(this.dataDir, 'native-output', createHash('sha256').update(id).digest('hex'))]
  }
  async remove(id: string) {
    const paths = this.paths(id)
    const policy = this.log.readAll(id, 'remote_agent').find(e => e.type === 'agent.policy')
    if (policy?.type !== 'agent.policy') throw new Error('session_not_found')
    // Quarantine records and their sessions remain until explicit runtime recovery.
    assertRootsClean(this.dataDir, [paths[0]!, ...policy.data.roots])
    const writer = this.db.prepare('SELECT writer_id FROM session_writers WHERE session_id=? AND released_at IS NULL').get(id)
    if (writer && writer.writer_id !== this.log.writer.id) throw new Error('writer_busy')
    const handle = this.log.open(id, { kind: 'agent', threadId: id })
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const busy = this.db.prepare(`SELECT 1 FROM durable_runs r JOIN run_attempts a ON a.run_id=r.id
          WHERE r.session_id=? AND a.state IN ('delivered','started')`).get(id)
        if (busy) throw new Error('session_busy')
        const foreignDependency = this.db.prepare(`SELECT 1 FROM promises p JOIN durable_runs r ON r.id=p.parent_id JOIN durable_runs c ON c.id=p.child_id
          WHERE (r.session_id=? OR c.session_id=?) AND r.session_id<>c.session_id`).get(id, id)
        if (foreignDependency) throw new Error('session_busy')
        if (!this.db.prepare('UPDATE native_sessions SET deletion_requested=1 WHERE session_id=?').run(id).changes) throw new Error('session_not_found')
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      // No caller can resume a session with a persisted deletion intent, even after a crash.
      for (const path of paths) await rm(path, { recursive: true, force: true })
      this.db.exec('BEGIN IMMEDIATE')
      try {
        assertRootsClean(this.dataDir, [paths[0]!, ...policy.data.roots])
        const ids = (this.db.prepare('SELECT id FROM durable_runs WHERE session_id=?').all(id) as { id: string }[]).map(r => r.id)
        for (const runId of ids) {
          if (this.db.prepare(`SELECT 1 FROM promises WHERE (parent_id=? OR child_id=?)
            AND (parent_id NOT IN (SELECT id FROM durable_runs WHERE session_id=?) OR child_id NOT IN (SELECT id FROM durable_runs WHERE session_id=?))`).get(runId, runId, id, id)) throw new Error('session_busy')
        }
        for (const table of ['timers','promises','outbox','run_costs','run_resources','run_execution','run_attempts']) {
          const predicate = table === 'timers' ? 'promise_id IN (SELECT id FROM promises WHERE parent_id IN (SELECT id FROM durable_runs WHERE session_id=?))'
            : table === 'promises' ? 'parent_id IN (SELECT id FROM durable_runs WHERE session_id=?)' : 'run_id IN (SELECT id FROM durable_runs WHERE session_id=?)'
          this.db.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run(id)
        }
        this.db.prepare('DELETE FROM durable_runs WHERE session_id=?').run(id)
        for (const runId of ids) this.db.prepare("DELETE FROM leases WHERE key=? OR (key LIKE 'resource:%' AND holder=?)").run(`run:${runId}/exec`, runId)
        this.db.prepare('DELETE FROM native_sessions WHERE session_id=?').run(id)
        this.db.prepare('DELETE FROM threads WHERE id=?').run(id)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      this.log.notify([id])
    } finally { handle.close() }
  }
  /** Recover private directories from a crash before atomic session admission. */
  async reapOrphans(isPreparing: (id: string) => boolean, assertHome: () => void) {
    for (const kind of ['scratch', 'native-attachments']) {
      let entries: string[]
      try { entries = await readdir(join(this.dataDir, kind)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const id of entries) {
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || isPreparing(id) || this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) continue
        assertHome()
        try {
          assertRootsClean(this.dataDir, [join(this.dataDir, 'scratch', id)])
          await rm(join(this.dataDir, kind, id), { recursive: true, force: true })
        } catch { /* Quarantine or unavailable storage is retained for recovery. */ }
      }
    }
  }
  /** Canonical rolling seven-day TTL enters Trash, preserving recoverable data. */
  async maintain(active: ReadonlySet<string>, now = new Date()) {
    const ids = this.db.prepare('SELECT session_id FROM native_sessions').all()
    for (const candidate of ids) {
      const id = String(candidate.session_id)
      // Earlier deletion awaits must not freeze a later session's policy/activity.
      const row = this.db.prepare(`SELECT n.*,t.retention_policy,t.last_user_activity_at,t.created_at FROM native_sessions n JOIN threads t ON t.id=n.thread_id WHERE n.session_id=?`).get(id)
      if (!row) continue
      if (active.has(id) || this.db.prepare(`SELECT 1 FROM durable_runs r JOIN run_attempts a ON a.run_id=r.id WHERE r.session_id=? AND a.state IN ('delivered','started')`).get(id) || this.db.prepare('SELECT 1 FROM session_writers WHERE session_id=? AND released_at IS NULL AND writer_id<>?').get(id, this.log.writer.id)) continue
      if (row.deletion_requested) { try { await this.remove(id) } catch { /* Intent stays durable for the next maintenance pass. */ } }
      else if (row.leave_at) {
        if (row.trashed_at && Date.parse(String(row.trashed_at)) + SESSION_TRASH_RECOVERY_HOURS * 3600000 <= now.getTime()) { try { await this.remove(id) } catch { /* writer/quarantine is retried */ } }
        else this.db.prepare('UPDATE native_sessions SET trashed_at=? WHERE session_id=? AND trashed_at IS NULL').run(now.toISOString(), id)
      }
      else if (row.retention_policy === 'ttl' && Date.parse(String(row.last_user_activity_at ?? row.created_at)) + CHAT_RETENTION_DAYS * DAY <= now.getTime()) {
        this.db.prepare('UPDATE native_sessions SET trashed_at=? WHERE session_id=? AND trashed_at IS NULL').run(now.toISOString(), id)
      }
    }
  }
}
