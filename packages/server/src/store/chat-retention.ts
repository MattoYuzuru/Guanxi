import {
  CHAT_DELETION_VERSION,
  CHAT_LIFECYCLE_VERSION,
  CHAT_RETENTION_DAYS,
  CHAT_RETENTION_VERSION,
  SESSION_LEAVE_VERSION,
  SESSION_TRASH_RECOVERY_HOURS,
  chatDeletionAuditSchema,
  chatRetentionProjectionSchema,
  chatTrashItemSchema,
  leaveSessionChatResponse,
  restoredChatLifecycleSchema,
  type ChatRetentionPolicy,
  type ChatRetentionProjection,
  type ChatDeletionAudit,
  type ChatTrashItem,
  type LeaveSessionChatResponse,
  type RestoredChatLifecycle,
} from '@alamo/contract'
import type { Db } from './db.ts'

const DAY_MS = 24 * 60 * 60 * 1_000
const TERMINAL_JOB_STATES = "'completed','failed','cancelled','interrupted'"

interface RetentionRow {
  id: string
  title: string
  mode: string
  project_id: string | null
  created_at: string
  retention_policy: string | null
  retention_policy_source: string | null
  retention_policy_updated_at: string | null
  last_user_activity_at: string | null
  last_user_activity_source: string | null
  last_user_restore_at: string | null
  chat_lifecycle_state: string
  chat_tombstoned_at: string | null
  chat_tombstone_reason: string | null
  chat_tombstone_activity_at: string | null
  chat_lifecycle_reason: string | null
  session_leave_at: string | null
  session_leave_source: string | null
}

export interface RetentionEligibilityCursor {
  activityAt: string
  chatId: string
}

export interface RetentionEligibilityCandidate extends RetentionEligibilityCursor {
  projectId: string | null
  activitySource: 'chat_created' | 'user_message' | 'chat_restored' | 'session_leave'
  reason: 'ttl_expired' | 'session_left'
}

export interface HardDeletionCursor {
  tombstonedAt: string
  chatId: string
}

export interface HardDeletionCandidate extends HardDeletionCursor {
  projectId: string | null
  sessionLeaveAt: string
  recoveryDeadline: string
}

export type ChatRetentionLookup =
  | { status: 'ok'; retention: ChatRetentionProjection }
  | { status: 'not_found' }
  | { status: 'not_chat' }
  | { status: 'in_trash' }

export type UpdateChatRetentionLookup = ChatRetentionLookup
  | { status: 'recovery_expired' }

export type RestoreChatLookup =
  | { status: 'ok'; lifecycle: RestoredChatLifecycle }
  | { status: 'not_found' }
  | { status: 'not_chat' }
  | { status: 'not_in_trash' }
  | { status: 'recovery_expired' }

export type SessionLeaveScope =
  | { scope: 'projectless' }
  | { scope: 'project'; projectId: string }

export type SessionLeaveLookup =
  | { status: 'ok'; lifecycle: LeaveSessionChatResponse }
  | { status: 'not_found' }
  | { status: 'not_chat' }
  | { status: 'not_session' }
  | { status: 'scope_mismatch' }

export interface ChatTrashPage {
  chats: ChatTrashItem[]
  hasMore: boolean
  deletions: ChatDeletionAudit[]
  deletionsHaveMore: boolean
}

export interface ChatRetentionStoreOptions {
  clock?: () => Date
}

function addSevenDays(value: string): string {
  return new Date(Date.parse(value) + CHAT_RETENTION_DAYS * DAY_MS).toISOString()
}

function sessionRecoveryDeadline(value: string): string {
  return new Date(
    Date.parse(value) + SESSION_TRASH_RECOVERY_HOURS * 60 * 60 * 1_000,
  ).toISOString()
}

function storedPolicy(row: RetentionRow): ChatRetentionPolicy {
  if (row.retention_policy === 'ttl') return { mode: 'ttl', expiresAfterDays: CHAT_RETENTION_DAYS }
  if (row.retention_policy === 'session') return { mode: 'session' }
  return { mode: 'keep' }
}

function activitySource(row: RetentionRow): 'chat_created' | 'user_message' | 'chat_restored' {
  const activityAt = row.last_user_activity_at ?? row.created_at
  if (row.last_user_restore_at === activityAt) return 'chat_restored'
  return row.last_user_activity_source === 'user_message' ? 'user_message' : 'chat_created'
}

function toProjection(row: RetentionRow, activeJobCount: number): ChatRetentionProjection {
  const policy = storedPolicy(row)
  const activityAt = row.last_user_activity_at ?? row.created_at
  return chatRetentionProjectionSchema.parse({
    retentionVersion: CHAT_RETENTION_VERSION,
    chatId: row.id,
    projectId: row.project_id,
    policy,
    policySource: row.retention_policy_source ?? 'legacy_compatibility',
    policyUpdatedAt: row.retention_policy_updated_at ?? row.created_at,
    lastUserActivity: {
      at: activityAt,
      source: activitySource(row),
    },
    expiresAt: policy.mode === 'ttl' ? addSevenDays(activityAt) : null,
    expirySource: policy.mode === 'ttl' ? 'server_calculated' : 'policy_without_time_expiry',
    enforcement: 'rolling_ttl_trash',
    sessionLeave: row.session_leave_at === null
      ? null
      : {
          at: row.session_leave_at,
          source: 'explicit_user_action',
          state: activeJobCount > 0 ? 'blocked_active_job' : 'pending_maintenance',
          activeJobCount,
        },
  })
}

function toTrashItem(row: RetentionRow, observedAt: string): ChatTrashItem {
  const base = {
    lifecycleVersion: CHAT_LIFECYCLE_VERSION,
    chatId: row.id,
    title: row.title,
    projectId: row.project_id,
    state: 'trash',
    reason: row.chat_lifecycle_reason,
    tombstonedAt: row.chat_tombstoned_at,
    activityBasis: {
      at: row.chat_tombstone_activity_at,
      source: row.chat_lifecycle_reason === 'session_left' ? 'session_leave' : activitySource(row),
    },
    source: 'server_maintenance',
  }
  if (row.chat_lifecycle_reason !== 'session_left') {
    return chatTrashItemSchema.parse({ ...base, hardDeletion: 'not_implemented' })
  }
  const deadline = sessionRecoveryDeadline(row.chat_tombstoned_at!)
  const recoveryAvailable = Date.parse(observedAt) < Date.parse(deadline)
  return chatTrashItemSchema.parse({
    ...base,
    recovery: {
      deadline,
      state: recoveryAvailable ? 'available' : 'grace_elapsed',
      source: 'server_calculated_24_hours',
    },
    hardDeletion: {
      state: recoveryAvailable ? 'scheduled_after_recovery' : 'pending_maintenance',
      eligibleAt: deadline,
      source: 'server_maintenance',
      blobGc: 'not_applicable',
    },
  })
}

interface DeletionAuditRow {
  chat_id: string
  scope: string
  project_id: string | null
  tombstoned_at: string
  recovery_deadline: string
  deleted_at: string
}

function toDeletionAudit(row: DeletionAuditRow): ChatDeletionAudit {
  return chatDeletionAuditSchema.parse({
    deletionVersion: CHAT_DELETION_VERSION,
    chatId: row.chat_id,
    scope: row.scope,
    projectId: row.project_id,
    state: 'deleted',
    reason: 'session_recovery_elapsed',
    tombstonedAt: row.tombstoned_at,
    recoveryDeadline: row.recovery_deadline,
    deletedAt: row.deleted_at,
    source: 'server_maintenance',
    boundary: 'thread_owned_sqlite_metadata',
    blobGc: 'not_applicable',
  })
}

export class ChatRetentionStore {
  private readonly db: Db
  private readonly clock: () => Date

  constructor(db: Db, options: ChatRetentionStoreOptions = {}) {
    this.db = db
    this.clock = options.clock ?? (() => new Date())
  }

  get(chatId: string, includeTrash = false): ChatRetentionLookup {
    const row = this.row(chatId)
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    if (!includeTrash && row.chat_lifecycle_state === 'trash') return { status: 'in_trash' }
    return { status: 'ok', retention: toProjection(row, this.activeJobCount(chatId)) }
  }

  update(chatId: string, policy: ChatRetentionPolicy): UpdateChatRetentionLookup {
    const row = this.row(chatId)
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    if (row.chat_lifecycle_state === 'trash' && policy.mode === 'session') {
      return { status: 'in_trash' }
    }
    if (row.chat_lifecycle_state === 'trash' && this.sessionRecoveryElapsed(row)) {
      return { status: 'recovery_expired' }
    }

    const previousMutationAt = row.chat_lifecycle_state === 'trash' && row.chat_tombstoned_at
      ? new Date(Math.max(
          Date.parse(row.retention_policy_updated_at ?? row.created_at),
          Date.parse(row.chat_tombstoned_at),
        )).toISOString()
      : (row.retention_policy_updated_at ?? row.created_at)
    const updatedAt = this.nextMutationTime(previousMutationAt)
    if (row.chat_lifecycle_state === 'trash') {
      this.transact(() => {
        const result = this.db
          .prepare(
            `UPDATE threads
             SET retention_policy = ?, retention_policy_source = 'user',
                 retention_policy_updated_at = ?, last_user_activity_at = ?,
                 last_user_restore_at = ?, chat_lifecycle_state = 'active',
                 chat_tombstoned_at = NULL, chat_tombstone_reason = NULL,
                 chat_tombstone_activity_at = NULL, chat_lifecycle_reason = NULL,
                 session_leave_at = NULL, session_leave_source = NULL
             WHERE id = ? AND mode = 'chat' AND chat_lifecycle_state = 'trash'`,
          )
          .run(policy.mode, updatedAt, updatedAt, updatedAt, chatId)
        if (result.changes !== 1) throw new Error('Chat lifecycle changed during policy restore')
        this.insertRestoreAudit(chatId, updatedAt, 'policy_change')
      })
    } else {
      this.db
        .prepare(
          `UPDATE threads
           SET retention_policy = ?, retention_policy_source = 'user',
               retention_policy_updated_at = ?,
               session_leave_at = CASE WHEN ? = 'session' THEN session_leave_at ELSE NULL END,
               session_leave_source = CASE WHEN ? = 'session' THEN session_leave_source ELSE NULL END
           WHERE id = ? AND mode = 'chat' AND chat_lifecycle_state = 'active'`,
        )
        .run(policy.mode, updatedAt, policy.mode, policy.mode, chatId)
    }
    return this.get(chatId)
  }

  listTrash(
    scope: { scope: 'projectless' } | { scope: 'project'; projectId: string },
    limit: number,
  ): ChatTrashPage {
    const where = scope.scope === 'project'
      ? 't.chat_lifecycle_state = \'trash\' AND t.project_id = ?'
      : "t.chat_lifecycle_state = 'trash' AND t.project_id IS NULL"
    const statement = this.db.prepare(
      `SELECT t.*
       FROM threads t
       WHERE ${where}
       ORDER BY t.chat_tombstoned_at DESC, t.id ASC
       LIMIT ?`,
    )
    const rows = (scope.scope === 'project'
      ? statement.all(scope.projectId, limit + 1)
      : statement.all(limit + 1)) as unknown as RetentionRow[]
    const auditWhere = scope.scope === 'project'
      ? "scope = 'project' AND project_id = ?"
      : "scope = 'projectless' AND project_id IS NULL"
    const auditStatement = this.db.prepare(
      `SELECT chat_id, scope, project_id, tombstoned_at, recovery_deadline, deleted_at
       FROM chat_deletion_audit
       WHERE ${auditWhere}
       ORDER BY deleted_at DESC, chat_id ASC
       LIMIT ?`,
    )
    const auditRows = (scope.scope === 'project'
      ? auditStatement.all(scope.projectId, limit + 1)
      : auditStatement.all(limit + 1)) as unknown as DeletionAuditRow[]
    return {
      chats: rows.slice(0, limit).map((row) => toTrashItem(row, this.clock().toISOString())),
      hasMore: rows.length > limit,
      deletions: auditRows.slice(0, limit).map(toDeletionAudit),
      deletionsHaveMore: auditRows.length > limit,
    }
  }

  hardDeletionEligiblePage(
    observedAt: string,
    after: HardDeletionCursor | null,
    limit: number,
  ): HardDeletionCandidate[] {
    const cutoff = new Date(
      Date.parse(observedAt) - SESSION_TRASH_RECOVERY_HOURS * 60 * 60 * 1_000,
    ).toISOString()
    const afterTombstone = after?.tombstonedAt ?? ''
    const afterChatId = after?.chatId ?? ''
    const rows = this.db.prepare(
      `SELECT t.id, t.project_id, t.chat_tombstoned_at, t.session_leave_at
       FROM threads t
       WHERE t.mode = 'chat'
         AND t.chat_lifecycle_state = 'trash'
         AND t.chat_lifecycle_reason = 'session_left'
         AND t.retention_policy = 'session'
         AND t.session_leave_at IS NOT NULL
         AND t.session_leave_source = 'explicit_user_action'
         AND t.chat_tombstone_activity_at = t.session_leave_at
         AND t.chat_tombstoned_at <= ?
         AND (
           t.chat_tombstoned_at > ?
           OR (t.chat_tombstoned_at = ? AND t.id > ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM chat_deletion_audit audit WHERE audit.chat_id = t.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM chat_job_inputs input
           JOIN jobs job ON job.id = input.job_id
           WHERE input.thread_id = t.id
             AND job.status NOT IN (${TERMINAL_JOB_STATES})
         )
       ORDER BY t.chat_tombstoned_at ASC, t.id ASC
       LIMIT ?`,
    ).all(cutoff, afterTombstone, afterTombstone, afterChatId, limit) as unknown as Array<{
      id: string
      project_id: string | null
      chat_tombstoned_at: string
      session_leave_at: string
    }>
    return rows.map((row) => ({
      chatId: row.id,
      projectId: row.project_id,
      tombstonedAt: row.chat_tombstoned_at,
      sessionLeaveAt: row.session_leave_at,
      recoveryDeadline: sessionRecoveryDeadline(row.chat_tombstoned_at),
    }))
  }

  hardDeleteEligible(
    candidates: readonly HardDeletionCandidate[],
    observedAt: string,
  ): number {
    const cutoff = new Date(
      Date.parse(observedAt) - SESSION_TRASH_RECOVERY_HOURS * 60 * 60 * 1_000,
    ).toISOString()
    return this.transact(() => {
      let deleted = 0
      for (const candidate of candidates) {
        const audit = this.db.prepare(
          `INSERT INTO chat_deletion_audit (
             deletion_version, chat_id, scope, project_id, reason,
             tombstoned_at, recovery_deadline, deleted_at, source, boundary, blob_gc
           )
           SELECT 1, t.id,
                  CASE WHEN t.project_id IS NULL THEN 'projectless' ELSE 'project' END,
                  t.project_id, 'session_recovery_elapsed', t.chat_tombstoned_at,
                  ?, ?, 'server_maintenance', 'thread_owned_sqlite_metadata', 'not_applicable'
           FROM threads t
           WHERE t.id = ? AND t.project_id IS ? AND t.mode = 'chat'
             AND t.chat_lifecycle_state = 'trash'
             AND t.chat_lifecycle_reason = 'session_left'
             AND t.retention_policy = 'session'
             AND t.session_leave_at IS NOT NULL
             AND t.session_leave_source = 'explicit_user_action'
             AND t.chat_tombstone_activity_at = t.session_leave_at
             AND t.session_leave_at = ?
             AND t.chat_tombstoned_at = ?
             AND t.chat_tombstoned_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM chat_deletion_audit existing WHERE existing.chat_id = t.id
             )
             AND NOT EXISTS (
               SELECT 1
               FROM chat_job_inputs input
               JOIN jobs job ON job.id = input.job_id
               WHERE input.thread_id = t.id
                 AND job.status NOT IN (${TERMINAL_JOB_STATES})
             )`,
        ).run(
          sessionRecoveryDeadline(candidate.tombstonedAt),
          observedAt,
          candidate.chatId,
          candidate.projectId,
          candidate.sessionLeaveAt,
          candidate.tombstonedAt,
          cutoff,
        )
        if (audit.changes === 0) continue
        const removed = this.db.prepare('DELETE FROM threads WHERE id = ?').run(candidate.chatId)
        if (removed.changes !== 1) throw new Error('Audited Chat metadata was not deleted')
        deleted += 1
      }
      return deleted
    })
  }

  restore(chatId: string): RestoreChatLookup {
    const row = this.row(chatId)
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    if (row.chat_lifecycle_state !== 'trash') {
      if (row.last_user_restore_at === null) return { status: 'not_in_trash' }
      return { status: 'ok', lifecycle: this.restoredLifecycle(row, false) }
    }
    if (this.sessionRecoveryElapsed(row)) return { status: 'recovery_expired' }

    const restoredAt = this.nextMutationTime(row.chat_tombstoned_at ?? row.created_at)
    this.transact(() => {
      const result = this.db
        .prepare(
          `UPDATE threads
           SET chat_lifecycle_state = 'active', chat_tombstoned_at = NULL,
               chat_tombstone_reason = NULL, chat_tombstone_activity_at = NULL,
               chat_lifecycle_reason = NULL, session_leave_at = NULL,
               session_leave_source = NULL, last_user_activity_at = ?, last_user_restore_at = ?
           WHERE id = ? AND mode = 'chat' AND chat_lifecycle_state = 'trash'`,
        )
        .run(restoredAt, restoredAt, chatId)
      if (result.changes !== 1) throw new Error('Chat lifecycle changed during restore')
      this.insertRestoreAudit(chatId, restoredAt, 'user_restore')
    })
    const restored = this.row(chatId)
    if (!restored) throw new Error('Restored Chat disappeared')
    return { status: 'ok', lifecycle: this.restoredLifecycle(restored, true) }
  }

  leaveSession(chatId: string, scope: SessionLeaveScope): SessionLeaveLookup {
    let row = this.row(chatId)
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    const expectedProjectId = scope.scope === 'project' ? scope.projectId : null
    if (row.project_id !== expectedProjectId) return { status: 'scope_mismatch' }
    if (row.retention_policy !== 'session') return { status: 'not_session' }
    if (row.session_leave_at === null) {
      const leftAt = this.clock().toISOString()
      const result = this.db.prepare(
        `UPDATE threads
         SET session_leave_at = ?, session_leave_source = 'explicit_user_action'
         WHERE id = ? AND mode = 'chat' AND project_id IS ?
           AND retention_policy = 'session' AND session_leave_at IS NULL`,
      ).run(leftAt, chatId, expectedProjectId)
      if (result.changes !== 1) {
        row = this.row(chatId)
        if (!row || row.session_leave_at === null) {
          throw new Error('Session leave lifecycle changed during command')
        }
      } else {
        row = this.row(chatId)!
      }
    }
    return { status: 'ok', lifecycle: this.sessionLeaveLifecycle(row) }
  }

  eligiblePage(
    observedAt: string,
    after: RetentionEligibilityCursor | null,
    limit: number,
  ): RetentionEligibilityCandidate[] {
    const cutoff = new Date(Date.parse(observedAt) - CHAT_RETENTION_DAYS * DAY_MS).toISOString()
    const afterActivity = after?.activityAt ?? ''
    const afterChatId = after?.chatId ?? ''
    const rows = this.db
      .prepare(
        `SELECT t.*,
                CASE WHEN t.retention_policy = 'session'
                  THEN t.session_leave_at ELSE t.last_user_activity_at END AS eligibility_at,
                CASE WHEN t.retention_policy = 'session'
                  THEN 'session_left' ELSE 'ttl_expired' END AS eligibility_reason
         FROM threads t
         WHERE t.mode = 'chat'
           AND t.chat_lifecycle_state = 'active'
           AND (
             (t.retention_policy = 'ttl' AND t.last_user_activity_at <= ?)
             OR (t.retention_policy = 'session' AND t.session_leave_at IS NOT NULL)
           )
           AND (
             CASE WHEN t.retention_policy = 'session'
               THEN t.session_leave_at ELSE t.last_user_activity_at END > ?
             OR (
               CASE WHEN t.retention_policy = 'session'
                 THEN t.session_leave_at ELSE t.last_user_activity_at END = ?
               AND t.id > ?
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM chat_job_inputs input
             JOIN jobs job ON job.id = input.job_id
             WHERE input.thread_id = t.id
               AND job.status NOT IN (${TERMINAL_JOB_STATES})
           )
         ORDER BY eligibility_at ASC, t.id ASC
         LIMIT ?`,
      )
      .all(cutoff, afterActivity, afterActivity, afterChatId, limit) as unknown as Array<
        RetentionRow & {
          eligibility_at: string
          eligibility_reason: 'ttl_expired' | 'session_left'
        }
      >
    return rows.map((row) => ({
      chatId: row.id,
      projectId: row.project_id,
      activityAt: row.eligibility_at,
      activitySource: row.eligibility_reason === 'session_left' ? 'session_leave' : activitySource(row),
      reason: row.eligibility_reason,
    }))
  }

  tombstoneEligible(
    candidates: readonly RetentionEligibilityCandidate[],
    observedAt: string,
  ): number {
    const cutoff = new Date(Date.parse(observedAt) - CHAT_RETENTION_DAYS * DAY_MS).toISOString()
    return this.transact(() => {
      let tombstoned = 0
      for (const candidate of candidates) {
        const session = candidate.reason === 'session_left'
        const result = this.db
          .prepare(
            `UPDATE threads
             SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
                 chat_tombstone_reason = CASE WHEN ? THEN NULL ELSE 'ttl_expired' END,
                 chat_lifecycle_reason = ?, chat_tombstone_activity_at = ?
             WHERE id = ? AND mode = 'chat'
               AND chat_lifecycle_state = 'active'
               AND (
                 (? AND retention_policy = 'session' AND session_leave_at = ?)
                 OR
                 (NOT ? AND retention_policy = 'ttl' AND last_user_activity_at = ?
                   AND last_user_activity_at <= ?)
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM chat_job_inputs input
                 JOIN jobs job ON job.id = input.job_id
                 WHERE input.thread_id = threads.id
                   AND job.status NOT IN (${TERMINAL_JOB_STATES})
               )`,
          )
          .run(
            observedAt,
            session ? 1 : 0,
            candidate.reason,
            candidate.activityAt,
            candidate.chatId,
            session ? 1 : 0,
            candidate.activityAt,
            session ? 1 : 0,
            candidate.activityAt,
            cutoff,
          )
        if (result.changes === 0) continue
        this.db
          .prepare(
            `INSERT INTO chat_lifecycle_audit (
               chat_id, event_type, reason, occurred_at, activity_basis_at, source
             ) VALUES (?, 'tombstoned', ?, ?, ?, 'server_maintenance')`,
          )
          .run(candidate.chatId, candidate.reason, observedAt, candidate.activityAt)
        tombstoned += 1
      }
      return tombstoned
    })
  }

  private row(chatId: string): RetentionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, title, mode, project_id, created_at,
                retention_policy, retention_policy_source, retention_policy_updated_at,
                last_user_activity_at, last_user_activity_source, last_user_restore_at,
                chat_lifecycle_state, chat_tombstoned_at, chat_tombstone_reason,
                chat_tombstone_activity_at, chat_lifecycle_reason,
                session_leave_at, session_leave_source
         FROM threads WHERE id = ?`,
      )
      .get(chatId) as unknown as RetentionRow | undefined
  }

  private nextMutationTime(previous: string): string {
    const observedNow = this.clock().getTime()
    return new Date(Math.max(observedNow, Date.parse(previous) + 1)).toISOString()
  }

  private restoredLifecycle(row: RetentionRow, restored: boolean): RestoredChatLifecycle {
    const restoredAt = row.last_user_restore_at
    if (restoredAt === null) throw new Error('Restored Chat has no sourced restore time')
    return restoredChatLifecycleSchema.parse({
      lifecycleVersion: CHAT_LIFECYCLE_VERSION,
      chatId: row.id,
      projectId: row.project_id,
      state: 'active',
      restored,
      restoredAt,
      activityBasis: { at: restoredAt, source: 'chat_restored' },
      source: 'user_restore',
      hardDeletion: row.retention_policy === 'session'
        ? 'session_metadata_after_recovery_not_scheduled'
        : 'not_implemented',
    })
  }

  private activeJobCount(chatId: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM chat_job_inputs input
       JOIN jobs job ON job.id = input.job_id
       WHERE input.thread_id = ? AND job.status NOT IN (${TERMINAL_JOB_STATES})`,
    ).get(chatId) as { count: number }).count
  }

  private sessionRecoveryElapsed(row: RetentionRow): boolean {
    return row.chat_lifecycle_reason === 'session_left' &&
      row.chat_tombstoned_at !== null &&
      this.clock().getTime() >= Date.parse(sessionRecoveryDeadline(row.chat_tombstoned_at))
  }

  private sessionLeaveLifecycle(row: RetentionRow): LeaveSessionChatResponse {
    if (row.session_leave_at === null) throw new Error('Session Chat has no leave basis')
    const activeJobCount = row.chat_lifecycle_state === 'trash' ? 0 : this.activeJobCount(row.id)
    return leaveSessionChatResponse.parse({
      leaveVersion: SESSION_LEAVE_VERSION,
      chatId: row.id,
      projectId: row.project_id,
      state: row.chat_lifecycle_state === 'trash'
        ? 'trash'
        : activeJobCount > 0 ? 'blocked_active_job' : 'pending_maintenance',
      leaveBasis: { at: row.session_leave_at, source: 'explicit_user_action' },
      activeJobCount,
      recoveryDeadline: row.chat_lifecycle_state === 'trash'
        ? sessionRecoveryDeadline(row.chat_tombstoned_at!)
        : null,
      hardDeletion: 'session_metadata_after_recovery',
    })
  }

  private insertRestoreAudit(
    chatId: string,
    occurredAt: string,
    reason: 'user_restore' | 'policy_change',
  ): void {
    this.db
      .prepare(
        `INSERT INTO chat_lifecycle_audit (
           chat_id, event_type, reason, occurred_at, activity_basis_at, source
         ) VALUES (?, 'restored', ?, ?, ?, 'user_action')`,
      )
      .run(chatId, reason, occurredAt, occurredAt)
  }

  private transact<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
