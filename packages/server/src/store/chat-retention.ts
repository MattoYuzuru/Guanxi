import {
  CHAT_LIFECYCLE_VERSION,
  CHAT_RETENTION_DAYS,
  CHAT_RETENTION_VERSION,
  chatRetentionProjectionSchema,
  chatTrashItemSchema,
  restoredChatLifecycleSchema,
  type ChatRetentionPolicy,
  type ChatRetentionProjection,
  type ChatTrashItem,
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
}

export interface RetentionEligibilityCursor {
  activityAt: string
  chatId: string
}

export interface RetentionEligibilityCandidate extends RetentionEligibilityCursor {
  projectId: string | null
  activitySource: 'chat_created' | 'user_message' | 'chat_restored'
}

export type ChatRetentionLookup =
  | { status: 'ok'; retention: ChatRetentionProjection }
  | { status: 'not_found' }
  | { status: 'not_chat' }
  | { status: 'in_trash' }

export type RestoreChatLookup =
  | { status: 'ok'; lifecycle: RestoredChatLifecycle }
  | { status: 'not_found' }
  | { status: 'not_chat' }
  | { status: 'not_in_trash' }

export interface ChatTrashPage {
  chats: ChatTrashItem[]
  hasMore: boolean
}

export interface ChatRetentionStoreOptions {
  clock?: () => Date
}

function addSevenDays(value: string): string {
  return new Date(Date.parse(value) + CHAT_RETENTION_DAYS * DAY_MS).toISOString()
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

function toProjection(row: RetentionRow): ChatRetentionProjection {
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
  })
}

function toTrashItem(row: RetentionRow): ChatTrashItem {
  return chatTrashItemSchema.parse({
    lifecycleVersion: CHAT_LIFECYCLE_VERSION,
    chatId: row.id,
    title: row.title,
    projectId: row.project_id,
    state: 'trash',
    reason: row.chat_tombstone_reason,
    tombstonedAt: row.chat_tombstoned_at,
    activityBasis: {
      at: row.chat_tombstone_activity_at,
      source: activitySource(row),
    },
    source: 'server_maintenance',
    hardDeletion: 'not_implemented',
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
    return { status: 'ok', retention: toProjection(row) }
  }

  update(chatId: string, policy: ChatRetentionPolicy): ChatRetentionLookup {
    const row = this.row(chatId)
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    if (row.chat_lifecycle_state === 'trash' && policy.mode === 'session') {
      return { status: 'in_trash' }
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
                 chat_tombstone_activity_at = NULL
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
               retention_policy_updated_at = ?
           WHERE id = ? AND mode = 'chat' AND chat_lifecycle_state = 'active'`,
        )
        .run(policy.mode, updatedAt, chatId)
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
    return {
      chats: rows.slice(0, limit).map(toTrashItem),
      hasMore: rows.length > limit,
    }
  }

  restore(chatId: string): RestoreChatLookup {
    const row = this.row(chatId)
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    if (row.chat_lifecycle_state !== 'trash') {
      if (row.last_user_restore_at === null) return { status: 'not_in_trash' }
      return { status: 'ok', lifecycle: this.restoredLifecycle(row, false) }
    }

    const restoredAt = this.nextMutationTime(row.chat_tombstoned_at ?? row.created_at)
    this.transact(() => {
      const result = this.db
        .prepare(
          `UPDATE threads
           SET chat_lifecycle_state = 'active', chat_tombstoned_at = NULL,
               chat_tombstone_reason = NULL, chat_tombstone_activity_at = NULL,
               last_user_activity_at = ?, last_user_restore_at = ?
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
        `SELECT t.*
         FROM threads t
         WHERE t.mode = 'chat'
           AND t.chat_lifecycle_state = 'active'
           AND t.retention_policy = 'ttl'
           AND t.last_user_activity_at <= ?
           AND (
             t.last_user_activity_at > ?
             OR (t.last_user_activity_at = ? AND t.id > ?)
           )
           AND NOT EXISTS (
             SELECT 1
             FROM chat_job_inputs input
             JOIN jobs job ON job.id = input.job_id
             WHERE input.thread_id = t.id
               AND job.status NOT IN (${TERMINAL_JOB_STATES})
           )
         ORDER BY t.last_user_activity_at ASC, t.id ASC
         LIMIT ?`,
      )
      .all(cutoff, afterActivity, afterActivity, afterChatId, limit) as unknown as RetentionRow[]
    return rows.map((row) => ({
      chatId: row.id,
      projectId: row.project_id,
      activityAt: row.last_user_activity_at ?? row.created_at,
      activitySource: activitySource(row),
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
        const result = this.db
          .prepare(
            `UPDATE threads
             SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
                 chat_tombstone_reason = 'ttl_expired',
                 chat_tombstone_activity_at = last_user_activity_at
             WHERE id = ? AND mode = 'chat'
               AND chat_lifecycle_state = 'active'
               AND retention_policy = 'ttl'
               AND last_user_activity_at = ?
               AND last_user_activity_at <= ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM chat_job_inputs input
                 JOIN jobs job ON job.id = input.job_id
                 WHERE input.thread_id = threads.id
                   AND job.status NOT IN (${TERMINAL_JOB_STATES})
               )`,
          )
          .run(observedAt, candidate.chatId, candidate.activityAt, cutoff)
        if (result.changes === 0) continue
        this.db
          .prepare(
            `INSERT INTO chat_lifecycle_audit (
               chat_id, event_type, reason, occurred_at, activity_basis_at, source
             ) VALUES (?, 'tombstoned', 'ttl_expired', ?, ?, 'server_maintenance')`,
          )
          .run(candidate.chatId, observedAt, candidate.activityAt)
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
                chat_tombstone_activity_at
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
      hardDeletion: 'not_implemented',
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
