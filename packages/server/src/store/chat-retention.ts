import {
  CHAT_RETENTION_DAYS,
  CHAT_RETENTION_VERSION,
  chatRetentionProjectionSchema,
  type ChatRetentionPolicy,
  type ChatRetentionProjection,
} from '@alamo/contract'
import type { Db } from './db.ts'

interface RetentionRow {
  id: string
  mode: string
  project_id: string | null
  created_at: string
  retention_policy: string | null
  retention_policy_source: string | null
  retention_policy_updated_at: string | null
  last_user_activity_at: string | null
  last_user_activity_source: string | null
}

export type ChatRetentionLookup =
  | { status: 'ok'; retention: ChatRetentionProjection }
  | { status: 'not_found' }
  | { status: 'not_chat' }

function addSevenDays(value: string): string {
  return new Date(Date.parse(value) + CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString()
}

function storedPolicy(row: RetentionRow): ChatRetentionPolicy {
  if (row.retention_policy === 'ttl') return { mode: 'ttl', expiresAfterDays: CHAT_RETENTION_DAYS }
  if (row.retention_policy === 'session') return { mode: 'session' }
  return { mode: 'keep' }
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
      source: row.last_user_activity_source ?? 'chat_created',
    },
    expiresAt: policy.mode === 'ttl' ? addSevenDays(activityAt) : null,
    expirySource: policy.mode === 'ttl' ? 'server_calculated' : 'policy_without_time_expiry',
    enforcement: 'not_implemented',
  })
}

export class ChatRetentionStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  get(chatId: string): ChatRetentionLookup {
    const row = this.db
      .prepare(
        `SELECT id, mode, project_id, created_at,
                retention_policy, retention_policy_source, retention_policy_updated_at,
                last_user_activity_at, last_user_activity_source
         FROM threads WHERE id = ?`,
      )
      .get(chatId) as unknown as RetentionRow | undefined
    if (!row) return { status: 'not_found' }
    if (row.mode !== 'chat') return { status: 'not_chat' }
    return { status: 'ok', retention: toProjection(row) }
  }

  update(chatId: string, policy: ChatRetentionPolicy): ChatRetentionLookup {
    const current = this.get(chatId)
    if (current.status !== 'ok') return current
    const observedNow = Date.now()
    const previousUpdate = Date.parse(current.retention.policyUpdatedAt)
    const updatedAt = new Date(Math.max(observedNow, previousUpdate + 1)).toISOString()
    const mode = policy.mode
    this.db
      .prepare(
        `UPDATE threads
         SET retention_policy = ?, retention_policy_source = 'user',
             retention_policy_updated_at = ?
         WHERE id = ? AND mode = 'chat'`,
      )
      .run(mode, updatedAt, chatId)
    return this.get(chatId)
  }
}
