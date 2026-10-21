import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  chatDeletionAuditSchema,
  listChatTrashQuery,
  listChatTrashResponse,
} from '@guanxi/contract'
import {
  RetentionMaintenanceOwner,
  type RetentionMaintenanceScheduler,
} from '../src/retention/maintenance.ts'
import {
  ChatRetentionStore,
} from '../src/store/chat-retention.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ReasoningArtifactStore } from '../src/store/reasoning-artifacts.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { threadsRoutes } from '../src/http/threads-routes.ts'
import type { AppContext } from '../src/context.ts'
import { createAppContext } from '../src/context.ts'
import { downgradeChatHardDeletionToV19 } from './fixtures/retention-lifecycle-migration.ts'
import { orderedRows } from './fixtures/table-rows.ts'
import { SESSION_LOG_TABLES } from './fixtures/session-log-migration.ts'

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS
const TOMBSTONED_AT = '2026-08-11T12:00:00.000Z'
const DEADLINE = '2026-08-12T12:00:00.000Z'
const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'high' as const }
const NON_TERMINAL = [
  'queued', 'reserving', 'loading', 'prefill', 'thinking', 'generating',
  'waiting_tool', 'waiting_approval', 'finalizing', 'cancelling',
] as const
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'] as const

class FakeScheduler implements RetentionMaintenanceScheduler {
  readonly callbacks: Array<() => void> = []
  readonly cleared: unknown[] = []

  setInterval(callback: () => void): unknown {
    this.callbacks.push(callback)
    return { index: this.callbacks.length - 1 }
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle)
  }
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string, where = '', value?: string): number {
  const statement = db.prepare(`SELECT COUNT(*) AS count FROM "${table}" ${where}`)
  const row = value === undefined ? statement.get() : statement.get(value)
  return (row as { count: number }).count
}

function createChat(db: DatabaseSync, title: string, projectId: string | null = null) {
  const threads = new ThreadStore(db)
  return projectId === null
    ? threads.create({
        title, mode: 'chat', model: 'fixture', workspaceId: null, options: OPTIONS,
      })
    : threads.createWithOwnership({ title, model: 'fixture', projectId, options: OPTIONS })
}

function sessionTrash(
  db: DatabaseSync,
  title: string,
  tombstonedAt = TOMBSTONED_AT,
  projectId: string | null = null,
) {
  const chat = createChat(db, title, projectId)
  const leaveAt = new Date(Date.parse(tombstonedAt) - HOUR_MS).toISOString()
  db.prepare(
    `UPDATE threads
     SET retention_policy = 'session', retention_policy_source = 'user',
         retention_policy_updated_at = ?, session_leave_at = ?,
         session_leave_source = 'explicit_user_action'
     WHERE id = ?`,
  ).run(leaveAt, leaveAt, chat.id)
  const store = new ChatRetentionStore(db)
  assert.equal(store.tombstoneEligible([{
    chatId: chat.id,
    projectId,
    activityAt: leaveAt,
    activitySource: 'session_leave',
    reason: 'session_left',
  }], tombstonedAt), 1)
  return chat
}

function attachJob(db: DatabaseSync, chatId: string, key: string, state: string): string {
  const association = new JobStore(db).createChat({
    threadId: chatId,
    idempotencyScope: `chat:${chatId}:send:v1`,
    idempotencyKey: key,
    requestFingerprint: `fingerprint-${key}`,
    input: { content: `private prompt ${key}`, attachments: [], autoApprove: null },
    derivedTitle: 'Private prompt',
  })
  if (state !== 'queued') {
    const terminal = TERMINAL.includes(state as (typeof TERMINAL)[number])
    db.prepare(
      'UPDATE jobs SET status = ?, phase = ?, started_at = ?, finished_at = ? WHERE id = ?',
    ).run(state, state, TOMBSTONED_AT, terminal ? TOMBSTONED_AT : null, association.job.id)
  }
  return association.job.id
}

function allTablesPayload(db: DatabaseSync, excluded: ReadonlySet<string>): string {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name)
    .filter((name) => !excluded.has(name)
      && name !== 'artifact_blobs'
      && name !== 'artifacts'
      && name !== 'artifact_attachments')
  return JSON.stringify(Object.fromEntries(tables.map((name) => [
    name,
    orderedRows(db, name),
  ])))
}

function seedOwnedRows(
  db: DatabaseSync,
  chatId: string,
  key: string,
  projectId: string | null,
  artifactExpiresAt = new Date(Date.parse(DEADLINE) + DAY_MS).toISOString(),
): string {
  const jobId = attachJob(db, chatId, key, 'completed')
  const assistant = db.prepare(
    "SELECT id FROM messages WHERE thread_id = ? AND job_id = ? AND role = 'assistant'",
  ).get(chatId, jobId) as { id: string }
  db.prepare('UPDATE messages SET content = ?, thinking = ? WHERE id = ?')
    .run(`neighbor final ${key}`, `neighbor thinking ${key}`, assistant.id)
  const compaction = new ThreadStore(db).addMessage({
    threadId: chatId, role: 'system', content: `neighbor compaction ${key}`, isCompaction: true,
  })
  new ThreadStore(db).recordToolRun(chatId, compaction.id, {
    id: `tool-${key}`, name: 'read_file', arguments: { path: `/neighbor/${key}` },
    status: 'ok', result: `neighbor tool ${key}`, error: null, durationMs: 1,
    source: 'builtin', parsedFrom: 'native', diff: null,
  })
  const reasoning = `neighbor reasoning ${key}`
  const createdAt = new Date(Date.parse(DEADLINE) - DAY_MS).toISOString()
  const expiresAt = artifactExpiresAt
  db.prepare(
    `INSERT INTO reasoning_artifacts (
       id, artifact_version, chat_id, project_id, source_message_id, source_job_id,
       media_type, storage_kind, content_text, byte_size, checksum, created_at,
       artifact_expires_at, parent_retention_mode, parent_retention_expires_at,
       effective_expires_at
     ) VALUES (?, 1, ?, ?, ?, ?, 'text/markdown; charset=utf-8', 'sqlite_text',
       ?, ?, ?, ?, ?, 'ttl', ?, ?)`,
  ).run(
    `artifact-${key}`, chatId, projectId, assistant.id, jobId, reasoning,
    Buffer.byteLength(reasoning), `sha256:${createHash('sha256').update(reasoning).digest('hex')}`,
    createdAt, expiresAt, expiresAt, expiresAt,
  )
  db.prepare(
    `INSERT INTO chat_lifecycle_audit (
       chat_id, event_type, reason, occurred_at, activity_basis_at, source
     ) VALUES (?, 'restored', 'user_restore', ?, ?, 'user_action')`,
  ).run(chatId, createdAt, createdAt)
  return jobId
}

function ownedPayload(db: DatabaseSync, chatIds: readonly string[]): string {
  const placeholders = chatIds.map(() => '?').join(',')
  const rows = (table: string, predicate: string) =>
    db.prepare(`SELECT * FROM ${table} WHERE ${predicate} ORDER BY rowid`).all(...chatIds)
  const jobs = db.prepare(
    `SELECT j.* FROM jobs j JOIN chat_job_inputs i ON i.job_id = j.id
     WHERE i.thread_id IN (${placeholders}) ORDER BY j.rowid`,
  ).all(...chatIds)
  const events = db.prepare(
    `SELECT e.* FROM job_events e JOIN chat_job_inputs i ON i.job_id = e.job_id
     WHERE i.thread_id IN (${placeholders}) ORDER BY e.rowid`,
  ).all(...chatIds)
  return JSON.stringify({
    threads: rows('threads', `id IN (${placeholders})`),
    messages: rows('messages', `thread_id IN (${placeholders})`),
    toolRuns: rows('tool_runs', `thread_id IN (${placeholders})`),
    inputs: rows('chat_job_inputs', `thread_id IN (${placeholders})`),
    reasoning: rows('reasoning_artifacts', `chat_id IN (${placeholders})`),
    lifecycle: rows('chat_lifecycle_audit', `chat_id IN (${placeholders})`),
    jobs,
    events,
  })
}

describe('P3-I Session Chat metadata hard deletion', () => {
  it('adds append-only v20 on fresh/v19/reopen and rolls a true late failure back byte-exact for retry', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-chat-delete-v20-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seed = openDb(path)
    assert.equal(version(seed), 32)
    const chat = createChat(seed, 'Legacy final answer')
    new ThreadStore(seed).addMessage({
      threadId: chat.id,
      role: 'assistant',
      content: 'exact v19 final answer',
      thinking: 'exact v19 legacy thinking',
      turnStatus: 'completed',
      stopReason: 'stop',
    })
    const legacySession = sessionTrash(seed, 'Exact v19 Session Trash', TOMBSTONED_AT)
    new ThreadStore(seed).addMessage({
      threadId: legacySession.id,
      role: 'assistant',
      content: 'exact v19 trashed payload',
      thinking: 'exact v19 trashed thinking',
    })
    const legacyTtl = createChat(seed, 'Exact v19 TTL Trash')
    const ttlBasis = new Date(Date.parse(TOMBSTONED_AT) - 8 * DAY_MS).toISOString()
    seed.prepare(
      "UPDATE threads SET retention_policy = 'ttl', last_user_activity_at = ? WHERE id = ?",
    ).run(ttlBasis, legacyTtl.id)
    const legacyStore = new ChatRetentionStore(seed)
    const ttlCandidate = legacyStore.eligiblePage(TOMBSTONED_AT, null, 20)
      .find(({ chatId }) => chatId === legacyTtl.id)!
    assert.equal(legacyStore.tombstoneEligible([ttlCandidate], TOMBSTONED_AT), 1)
    assert.equal(count(seed, 'chat_lifecycle_audit'), 2)
    const columns = (seed.prepare('PRAGMA table_info(chat_deletion_audit)').all() as Array<{ name: string }>)
      .map(({ name }) => name)
    assert.deepEqual(columns, [
      'id', 'deletion_version', 'chat_id', 'scope', 'project_id', 'reason',
      'tombstoned_at', 'recovery_deadline', 'deleted_at', 'source', 'boundary', 'blob_gc',
    ])
    assert.deepEqual(seed.prepare('PRAGMA foreign_key_list(chat_deletion_audit)').all(), [])
    downgradeChatHardDeletionToV19(seed)
    const v19Payload = allTablesPayload(seed, new Set())
    seed.exec(`
      CREATE TABLE migration_20_midpoint_sentinel (collision TEXT NOT NULL);
      CREATE INDEX idx_chat_deletion_audit_scope
        ON migration_20_midpoint_sentinel(collision);
    `)
    seed.close()

    assert.throws(() => openDb(path), /Миграция 20 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 19)
    assert.equal(count(rolledBack, 'sqlite_master', "WHERE type = 'table' AND name = ?", 'chat_deletion_audit'), 0)
    assert.equal(
      allTablesPayload(rolledBack, new Set(['migration_20_midpoint_sentinel'])),
      v19Payload,
    )
    rolledBack.exec(`
      DROP INDEX idx_chat_deletion_audit_scope;
      DROP TABLE migration_20_midpoint_sentinel;
    `)
    rolledBack.close()

    const retried = openDb(path)
    assert.equal(version(retried), 32)
    assert.equal(count(retried, 'messages'), 2)
    assert.equal(count(retried, 'chat_lifecycle_audit'), 2)
    assert.equal(count(retried, 'chat_deletion_audit'), 0)
    assert.equal(allTablesPayload(retried, new Set([
      'chat_deletion_audit', 'quick_runs', 'recipes', 'recipe_revisions',
      'recipe_job_snapshots', 'context_checkpoints', ...SESSION_LOG_TABLES,
    ])), v19Payload)
    retried.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 32)
    assert.equal(count(reopened, 'chat_deletion_audit'), 0)
    assert.equal(allTablesPayload(reopened, new Set([
      'chat_deletion_audit', 'quick_runs', 'recipes', 'recipe_revisions',
      'recipe_job_snapshots', 'context_checkpoints', ...SESSION_LOG_TABLES,
    ])), v19Payload)
    reopened.close()
  })

  it('keeps deletion contracts strict, scoped, sourced and content-free', () => {
    const valid = {
      deletionVersion: 1,
      chatId: 'chat-1',
      scope: 'projectless',
      projectId: null,
      state: 'deleted',
      reason: 'session_recovery_elapsed',
      tombstonedAt: TOMBSTONED_AT,
      recoveryDeadline: DEADLINE,
      deletedAt: DEADLINE,
      source: 'server_maintenance',
      boundary: 'thread_owned_sqlite_metadata',
      blobGc: 'not_applicable',
    }
    assert.equal(chatDeletionAuditSchema.safeParse(valid).success, true)
    for (const invalid of [
      { ...valid, deletionVersion: 2 },
      { ...valid, scope: 'project', projectId: null },
      { ...valid, scope: 'projectless', projectId: 'project-a' },
      { ...valid, recoveryDeadline: new Date(Date.parse(DEADLINE) - 1).toISOString() },
      { ...valid, deletedAt: new Date(Date.parse(DEADLINE) - 1).toISOString() },
      { ...valid, title: 'private title' },
      { ...valid, blobGc: 'collected' },
    ]) assert.equal(chatDeletionAuditSchema.safeParse(invalid).success, false)
    assert.equal(listChatTrashQuery.safeParse({
      lifecycleVersion: 1, deletionVersion: 1, scope: 'projectless', limit: 20,
    }).success, true)
    assert.equal(listChatTrashQuery.safeParse({
      lifecycleVersion: 1, scope: 'projectless', limit: 20,
    }).success, false)
    assert.equal(listChatTrashQuery.safeParse({
      lifecycleVersion: 1, deletionVersion: 2, scope: 'projectless', limit: 20,
    }).success, false)
    assert.equal(listChatTrashResponse.safeParse({
      lifecycleVersion: 1,
      deletionVersion: 1,
      scope: 'project',
      projectId: 'project-a',
      chats: [],
      hasMore: false,
      deletions: [{ ...valid, scope: 'project', projectId: 'project-b' }],
      deletionsHaveMore: false,
    }).success, false)
  })

  it('enforces -1ms/at/+1ms, Session-only basis and every canonical Job state in scan and CAS', () => {
    for (const [offset, eligible] of [[-1, false], [0, true], [1, true]] as const) {
      const db = openDb(':memory:')
      const chat = sessionTrash(db, `Boundary ${offset}`)
      const store = new ChatRetentionStore(db)
      const observedAt = new Date(Date.parse(DEADLINE) + offset).toISOString()
      const candidates = store.hardDeletionEligiblePage(observedAt, null, 10)
      assert.equal(candidates.length, eligible ? 1 : 0, `${offset}ms scan`)
      const casCandidates = offset === 1 && candidates.length === 1
        ? [{ ...candidates[0]!, recoveryDeadline: '2099-01-01T00:00:00.000Z' }]
        : candidates
      assert.equal(store.hardDeleteEligible(casCandidates, observedAt), eligible ? 1 : 0, `${offset}ms CAS`)
      assert.equal(count(db, 'chat_deletion_audit'), eligible ? 1 : 0)
      if (offset === 1) {
        assert.equal((db.prepare(
          'SELECT recovery_deadline FROM chat_deletion_audit WHERE chat_id = ?',
        ).get(chat.id) as { recovery_deadline: string }).recovery_deadline, DEADLINE)
      }
      assert.equal(store.hardDeleteEligible(candidates, observedAt), 0)
      assert.deepEqual(store.hardDeletionEligiblePage(observedAt, null, 10), [])
      assert.equal(count(db, 'threads', 'WHERE id = ?', chat.id), eligible ? 0 : 1)
      db.close()
    }

    const excluded = openDb(':memory:')
    const keep = createChat(excluded, 'Keep')
    const activeSession = createChat(excluded, 'Active Session')
    excluded.prepare("UPDATE threads SET retention_policy = 'keep' WHERE id = ?").run(keep.id)
    excluded.prepare("UPDATE threads SET retention_policy = 'session' WHERE id = ?").run(activeSession.id)
    const invalidBasis = createChat(excluded, 'Invalid Session basis')
    excluded.prepare("UPDATE threads SET retention_policy = 'session' WHERE id = ?").run(invalidBasis.id)
    excluded.exec('DROP TRIGGER threads_chat_lifecycle_update_valid')
    excluded.prepare(
      `UPDATE threads
       SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
           chat_lifecycle_reason = 'session_left', chat_tombstone_reason = NULL,
           chat_tombstone_activity_at = ?
       WHERE id = ?`,
    ).run(TOMBSTONED_AT, TOMBSTONED_AT, invalidBasis.id)
    const invalidReason = createChat(excluded, 'Invalid deletion reason')
    const invalidReasonLeave = new Date(Date.parse(TOMBSTONED_AT) - HOUR_MS).toISOString()
    excluded.prepare(
      `UPDATE threads
       SET retention_policy = 'session', session_leave_at = ?,
           session_leave_source = 'explicit_user_action'
       WHERE id = ?`,
    ).run(invalidReasonLeave, invalidReason.id)
    excluded.prepare(
      `UPDATE threads
       SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
           chat_lifecycle_reason = 'ttl_expired', chat_tombstone_reason = 'ttl_expired',
           chat_tombstone_activity_at = ?
       WHERE id = ?`,
    ).run(TOMBSTONED_AT, invalidReasonLeave, invalidReason.id)
    const ttlTrash = createChat(excluded, 'TTL Trash')
    const old = new Date(Date.parse(TOMBSTONED_AT) - 8 * DAY_MS).toISOString()
    excluded.prepare(
      "UPDATE threads SET retention_policy = 'ttl', last_user_activity_at = ? WHERE id = ?",
    ).run(old, ttlTrash.id)
    const excludedStore = new ChatRetentionStore(excluded)
    const ttlCandidate = excludedStore.eligiblePage(TOMBSTONED_AT, null, 20)
      .find(({ chatId }) => chatId === ttlTrash.id)!
    assert.equal(excludedStore.tombstoneEligible([ttlCandidate], TOMBSTONED_AT), 1)
    const audited = sessionTrash(excluded, 'Already audited')
    excluded.prepare(
      `INSERT INTO chat_deletion_audit (
         deletion_version, chat_id, scope, project_id, reason, tombstoned_at,
         recovery_deadline, deleted_at, source, boundary, blob_gc
       ) VALUES (1, ?, 'projectless', NULL, 'session_recovery_elapsed', ?, ?, ?,
         'server_maintenance', 'thread_owned_sqlite_metadata', 'not_applicable')`,
    ).run(audited.id, TOMBSTONED_AT, DEADLINE, DEADLINE)
    assert.deepEqual(excludedStore.hardDeletionEligiblePage(DEADLINE, null, 20), [])
    assert.equal(count(excluded, 'threads'), 6)
    excluded.close()

    for (const state of NON_TERMINAL) {
      const db = openDb(':memory:')
      const chat = sessionTrash(db, `Blocked ${state}`)
      const store = new ChatRetentionStore(db)
      const stale = store.hardDeletionEligiblePage(DEADLINE, null, 10)
      assert.equal(stale.length, 1)
      attachJob(db, chat.id, `blocked-${state}`, state)
      assert.deepEqual(store.hardDeletionEligiblePage(DEADLINE, null, 10), [], `${state} scan`)
      assert.equal(store.hardDeleteEligible(stale, DEADLINE), 0, `${state} CAS`)
      assert.equal(count(db, 'threads', 'WHERE id = ?', chat.id), 1)
      db.close()
    }
    for (const state of TERMINAL) {
      const db = openDb(':memory:')
      const chat = sessionTrash(db, `Terminal ${state}`)
      attachJob(db, chat.id, `terminal-${state}`, state)
      const store = new ChatRetentionStore(db)
      const candidates = store.hardDeletionEligiblePage(DEADLINE, null, 10)
      assert.equal(candidates.length, 1, state)
      assert.equal(store.hardDeleteEligible(candidates, DEADLINE), 1, state)
      assert.equal(count(db, 'chat_deletion_audit'), 1, state)
      db.close()
    }
  })

  it('loses stale Restore/Keep/TTL, retombstone and Job-after-scan races without partial audit', () => {
    for (const mode of ['restore', 'keep', 'ttl'] as const) {
      const db = openDb(':memory:')
      const chat = sessionTrash(db, `Race ${mode}`)
      seedOwnedRows(db, chat.id, `stale-${mode}`, null)
      const deleting = new ChatRetentionStore(db)
      const stale = deleting.hardDeletionEligiblePage(DEADLINE, null, 10)
      const user = new ChatRetentionStore(db, {
        clock: () => new Date(Date.parse(DEADLINE) - 1),
      })
      const result = mode === 'restore'
        ? user.restore(chat.id)
        : user.update(chat.id, mode === 'keep'
          ? { mode: 'keep' }
          : { mode: 'ttl', expiresAfterDays: 7 })
      assert.equal(result.status, 'ok')
      const beforeStaleDelete = allTablesPayload(db, new Set())
      assert.equal(deleting.hardDeleteEligible(stale, DEADLINE), 0, mode)
      assert.equal(allTablesPayload(db, new Set()), beforeStaleDelete, `${mode} payload`)
      assert.equal(count(db, 'threads', 'WHERE id = ?', chat.id), 1)
      assert.equal(count(db, 'chat_deletion_audit'), 0)
      db.close()
    }

    const policyDb = openDb(':memory:')
    const policyRace = sessionTrash(policyDb, 'Policy-only stale candidate')
    seedOwnedRows(policyDb, policyRace.id, 'stale-policy-only', null)
    const policyStore = new ChatRetentionStore(policyDb)
    const policyStale = policyStore.hardDeletionEligiblePage(DEADLINE, null, 10)
    policyDb.exec('DROP TRIGGER threads_session_leave_update_valid')
    policyDb.prepare("UPDATE threads SET retention_policy = 'keep' WHERE id = ?").run(policyRace.id)
    const policyBeforeDelete = allTablesPayload(policyDb, new Set())
    assert.equal(policyStore.hardDeleteEligible(policyStale, DEADLINE), 0)
    assert.equal(allTablesPayload(policyDb, new Set()), policyBeforeDelete)
    assert.equal(count(policyDb, 'threads', 'WHERE id = ?', policyRace.id), 1)
    assert.equal(count(policyDb, 'chat_deletion_audit'), 0)
    policyDb.close()

    const retombstoneDb = openDb(':memory:')
    const retombstoned = sessionTrash(retombstoneDb, 'Retombstone')
    seedOwnedRows(retombstoneDb, retombstoned.id, 'stale-retombstone', null)
    const deleting = new ChatRetentionStore(retombstoneDb)
    const stale = deleting.hardDeletionEligiblePage(DEADLINE, null, 10)
    const newLeave = new Date(Date.parse(TOMBSTONED_AT) - 2 * HOUR_MS).toISOString()
    retombstoneDb.exec('DROP TRIGGER threads_chat_lifecycle_update_valid')
    retombstoneDb.exec('DROP TRIGGER threads_session_leave_update_valid')
    retombstoneDb.prepare(
      `UPDATE threads
       SET session_leave_at = ?, chat_tombstone_activity_at = ?
       WHERE id = ?`,
    ).run(newLeave, newLeave, retombstoned.id)
    assert.equal((retombstoneDb.prepare(
      'SELECT chat_tombstoned_at FROM threads WHERE id = ?',
    ).get(retombstoned.id) as { chat_tombstoned_at: string }).chat_tombstoned_at, TOMBSTONED_AT)
    const retombstoneBeforeDelete = allTablesPayload(retombstoneDb, new Set())
    assert.equal(deleting.hardDeleteEligible(stale, DEADLINE), 0)
    assert.equal(allTablesPayload(retombstoneDb, new Set()), retombstoneBeforeDelete)
    assert.equal(count(retombstoneDb, 'threads', 'WHERE id = ?', retombstoned.id), 1)
    assert.equal(count(retombstoneDb, 'chat_deletion_audit'), 0)
    retombstoneDb.close()

    const jobDb = openDb(':memory:')
    const jobRace = sessionTrash(jobDb, 'Job after scan')
    seedOwnedRows(jobDb, jobRace.id, 'stale-job', null)
    const jobStore = new ChatRetentionStore(jobDb)
    const jobStale = jobStore.hardDeletionEligiblePage(DEADLINE, null, 10)
    attachJob(jobDb, jobRace.id, 'job-after-scan', 'queued')
    const jobBeforeDelete = allTablesPayload(jobDb, new Set())
    assert.equal(jobStore.hardDeleteEligible(jobStale, DEADLINE), 0)
    assert.equal(allTablesPayload(jobDb, new Set()), jobBeforeDelete)
    assert.equal(count(jobDb, 'chat_deletion_audit'), 0)
    assert.equal(count(jobDb, 'threads', 'WHERE id = ?', jobRace.id), 1)
    jobDb.close()
  })

  it('deletes only documented Thread-owned rows, preserves durable Jobs/neighbors and commits redacted audit atomically', () => {
    const db = openDb(':memory:')
    const dependencyInventory = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).flatMap(({ name }) =>
      (db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{
        table: string
        from: string
        on_delete: string
      }>).filter(({ table }) =>
        ['threads', 'messages', 'jobs', 'projects', 'workspaces'].includes(table),
      ).map((foreignKey) => ({
        child: name,
        table: foreignKey.table,
        from: foreignKey.from,
        on_delete: foreignKey.on_delete,
      })),
    ).toSorted((left, right) =>
      `${left.child}:${left.table}:${left.from}`.localeCompare(`${right.child}:${right.table}:${right.from}`),
    )
    assert.deepEqual(dependencyInventory, [
      { child: 'artifacts', table: 'jobs', from: 'source_job_id', on_delete: 'RESTRICT' },
      { child: 'artifacts', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'chat_job_inputs', table: 'jobs', from: 'job_id', on_delete: 'CASCADE' },
      { child: 'chat_job_inputs', table: 'messages', from: 'assistant_message_id', on_delete: 'CASCADE' },
      { child: 'chat_job_inputs', table: 'messages', from: 'user_message_id', on_delete: 'CASCADE' },
      { child: 'chat_job_inputs', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'chat_lifecycle_audit', table: 'threads', from: 'chat_id', on_delete: 'CASCADE' },
      { child: 'context_checkpoints', table: 'messages', from: 'thread_id', on_delete: 'NO ACTION' },
      { child: 'context_checkpoints', table: 'messages', from: 'up_to_seq', on_delete: 'NO ACTION' },
      { child: 'context_checkpoints', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'job_events', table: 'jobs', from: 'job_id', on_delete: 'CASCADE' },
      { child: 'messages', table: 'jobs', from: 'job_id', on_delete: 'SET NULL' },
      { child: 'messages', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'project_filesystem_bindings', table: 'projects', from: 'project_id', on_delete: 'CASCADE' },
      { child: 'project_filesystem_bindings', table: 'workspaces', from: 'workspace_id', on_delete: 'CASCADE' },
      { child: 'quick_runs', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'reasoning_artifacts', table: 'jobs', from: 'source_job_id', on_delete: 'CASCADE' },
      { child: 'reasoning_artifacts', table: 'messages', from: 'source_message_id', on_delete: 'CASCADE' },
      { child: 'reasoning_artifacts', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'reasoning_artifacts', table: 'threads', from: 'chat_id', on_delete: 'CASCADE' },
      { child: 'recipe_job_snapshots', table: 'jobs', from: 'job_id', on_delete: 'RESTRICT' },
      { child: 'recipe_job_snapshots', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'recipes', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'session_mirror_backlog', table: 'jobs', from: 'job_id', on_delete: 'CASCADE' },
      { child: 'session_mirror_backlog', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'sessions', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'threads', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'threads', table: 'workspaces', from: 'workspace_id', on_delete: 'SET NULL' },
      { child: 'tool_runs', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
    ])
    const project = new ProjectStore(db).create('Neighbor Project', TOMBSTONED_AT)
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES ('neighbor-workspace', 'Neighbor Workspace', '/fixture/neighbor', ?, NULL)`,
    ).run(TOMBSTONED_AT)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES ('neighbor-bound-project', 'Bound Neighbor', ?, ?)`,
    ).run(TOMBSTONED_AT, TOMBSTONED_AT)
    db.prepare(
      `INSERT INTO project_filesystem_bindings (id, project_id, workspace_id, created_at)
       VALUES ('neighbor-binding', 'neighbor-bound-project', 'neighbor-workspace', ?)`,
    ).run(TOMBSTONED_AT)
    const target = sessionTrash(db, 'Private target title', TOMBSTONED_AT, project.id)
    const neighbor = createChat(db, 'Neighbor', project.id)
    const projectlessNeighbor = createChat(db, 'Projectless Neighbor')
    seedOwnedRows(db, neighbor.id, 'project-neighbor', project.id)
    seedOwnedRows(db, projectlessNeighbor.id, 'projectless-neighbor', null)
    const neighborIds = [neighbor.id, projectlessNeighbor.id]
    const neighborBefore = ownedPayload(db, neighborIds)
    const jobs = new JobStore(db)
    const association = jobs.createChat({
      threadId: target.id,
      idempotencyScope: `chat:${target.id}:send:v1`,
      idempotencyKey: 'owned-content',
      requestFingerprint: 'owned-fingerprint',
      input: {
        content: 'private prompt sentinel',
        attachments: ['/private/workspace/secret.txt'],
        autoApprove: null,
      },
      derivedTitle: 'Private prompt',
    })
    jobs.terminalizeChat({
      jobId: association.job.id,
      expectedStatus: 'queued',
      status: 'completed',
      messageId: association.assistantMessageId,
      message: {
        outcome: 'completed',
        error: null,
        stopReason: 'stop',
        content: 'private final answer sentinel',
        thinking: 'private reasoning sentinel',
        toolCalls: [],
        usage: null,
      },
      error: null,
      outcome: { code: 'chat_completed', metadata: {} },
      stopReason: 'completed',
    })
    const threads = new ThreadStore(db)
    const compaction = threads.addMessage({
      threadId: target.id,
      role: 'system',
      content: 'private compaction sentinel',
      isCompaction: true,
    })
    threads.recordToolRun(target.id, compaction.id, {
      id: 'private-tool-run',
      name: 'read_file',
      arguments: { path: '/private/workspace/secret.txt' },
      status: 'ok',
      result: 'private tool result sentinel',
      error: null,
      durationMs: 1,
      source: 'builtin',
      parsedFrom: 'native',
      diff: null,
    })
    for (let index = 0; index < 8; index += 1) {
      threads.addMessage({
        threadId: target.id,
        role: 'user',
        content: `private checkpoint source ${index}`,
      })
    }
    const firstCheckpointSelection = threads.compactionCandidates(target.id, 4)!
    const firstCheckpoint = threads.createContextCheckpoint({
      threadId: target.id,
      upToSeq: firstCheckpointSelection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'private checkpoint summary one',
    })
    for (let index = 8; index < 14; index += 1) {
      threads.addMessage({
        threadId: target.id,
        role: 'user',
        content: `private checkpoint source ${index}`,
      })
    }
    const secondCheckpointSelection = threads.compactionCandidates(target.id, 4)!
    threads.createContextCheckpoint({
      threadId: target.id,
      upToSeq: secondCheckpointSelection.upToSeq,
      expectedPreviousCheckpointId: firstCheckpoint.id,
      summary: 'private checkpoint summary two',
    })
    assert.equal(count(db, 'context_checkpoints', 'WHERE thread_id = ?', target.id), 2)
    const targetMessageCount = count(db, 'messages', 'WHERE thread_id = ?', target.id)
    db.prepare(
      `INSERT INTO reasoning_artifact_deletion_audit (
         enforcement_version, artifact_id, artifact_version, chat_id, project_id,
         source_message_id, source_job_id, reason, due_at, occurred_at, source
       ) VALUES (1, 'prior-artifact', 1, ?, ?, 'prior-message', 'prior-job',
         'diagnostic_ttl_expired', ?, ?, 'server_maintenance')`,
    ).run(target.id, project.id, TOMBSTONED_AT, TOMBSTONED_AT)
    const protectedTables = new Set([
      'jobs', 'job_events', 'reasoning_artifact_deletion_audit', 'projects',
      'project_filesystem_bindings', 'workspaces', 'settings', 'model_calibration',
      'model_calibration_observations', 'installed_model_evidence_cache',
      'completion_probe_evidence', 'model_capability_user_overrides',
      'recipes', 'recipe_revisions',
    ])
    const protectedBefore = allTablesPayload(db, new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>).map(({ name }) => name)
        .filter((name) => !protectedTables.has(name)),
    ))
    const store = new ChatRetentionStore(db)
    const candidate = store.hardDeletionEligiblePage(DEADLINE, null, 10)
    assert.equal(candidate.length, 1)

    db.exec(`
      CREATE TRIGGER fail_chat_delete_audit
      BEFORE INSERT ON chat_deletion_audit
      BEGIN SELECT RAISE(ABORT, 'injected delete audit failure'); END;
    `)
    const beforeAuditFailure = allTablesPayload(db, new Set())
    assert.throws(() => store.hardDeleteEligible(candidate, DEADLINE), /injected delete audit failure/u)
    assert.equal(allTablesPayload(db, new Set()), beforeAuditFailure)
    assert.equal(count(db, 'threads', 'WHERE id = ?', target.id), 1)
    assert.equal(count(db, 'messages', 'WHERE thread_id = ?', target.id), targetMessageCount)
    assert.equal(count(db, 'chat_deletion_audit'), 0)
    db.exec('DROP TRIGGER fail_chat_delete_audit')

    db.exec(`
      CREATE TRIGGER fail_thread_delete
      BEFORE DELETE ON threads
      WHEN OLD.id = '${target.id}'
      BEGIN SELECT RAISE(ABORT, 'injected Thread delete failure'); END;
    `)
    const beforeThreadFailure = allTablesPayload(db, new Set())
    assert.throws(() => store.hardDeleteEligible(candidate, DEADLINE), /injected Thread delete failure/u)
    assert.equal(allTablesPayload(db, new Set()), beforeThreadFailure)
    assert.equal(count(db, 'threads', 'WHERE id = ?', target.id), 1)
    assert.equal(count(db, 'chat_deletion_audit'), 0)
    db.exec('DROP TRIGGER fail_thread_delete')

    assert.equal(store.hardDeleteEligible(candidate, DEADLINE), 1)
    assert.equal(store.hardDeleteEligible(candidate, DEADLINE), 0)
    for (const table of ['threads', 'messages', 'context_checkpoints', 'tool_runs', 'chat_job_inputs', 'reasoning_artifacts', 'chat_lifecycle_audit']) {
      const column = table === 'threads' ? 'id'
        : table === 'messages' || table === 'context_checkpoints' || table === 'tool_runs' ? 'thread_id'
          : table === 'chat_job_inputs' ? 'thread_id' : 'chat_id'
      assert.equal(count(db, table, `WHERE ${column} = ?`, target.id), 0, table)
    }
    assert.equal(count(db, 'jobs', 'WHERE id = ?', association.job.id), 1)
    assert.equal(count(db, 'job_events', 'WHERE job_id = ?', association.job.id), 2)
    assert.equal(count(db, 'reasoning_artifact_deletion_audit', 'WHERE chat_id = ?', target.id), 1)
    assert.equal(count(db, 'threads', 'WHERE id = ?', neighbor.id), 1)
    assert.equal(count(db, 'threads', 'WHERE id = ?', projectlessNeighbor.id), 1)
    assert.equal(ownedPayload(db, neighborIds), neighborBefore)
    assert.equal(count(db, 'workspaces', 'WHERE id = ?', 'neighbor-workspace'), 1)
    assert.equal(count(db, 'project_filesystem_bindings', 'WHERE id = ?', 'neighbor-binding'), 1)
    assert.equal(allTablesPayload(db, new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>).map(({ name }) => name)
        .filter((name) => !protectedTables.has(name)),
    )), protectedBefore)
    const audit = db.prepare('SELECT * FROM chat_deletion_audit').get() as Record<string, unknown>
    assert.deepEqual(chatDeletionAuditSchema.parse({
      deletionVersion: audit['deletion_version'],
      chatId: audit['chat_id'],
      scope: audit['scope'],
      projectId: audit['project_id'],
      state: 'deleted',
      reason: audit['reason'],
      tombstonedAt: audit['tombstoned_at'],
      recoveryDeadline: audit['recovery_deadline'],
      deletedAt: audit['deleted_at'],
      source: audit['source'],
      boundary: audit['boundary'],
      blobGc: audit['blob_gc'],
    }).chatId, target.id)
    const serializedAudit = JSON.stringify(audit)
    for (const secret of [
      'Private target title', 'private prompt sentinel', 'private final answer sentinel',
      'private reasoning sentinel', 'private compaction sentinel',
      'private checkpoint summary one', 'private checkpoint summary two',
      'private tool result sentinel', '/private/workspace/secret.txt',
    ]) assert.equal(serializedAudit.includes(secret), false, secret)
    const page = store.listTrash({ scope: 'project', projectId: project.id }, 20)
    assert.deepEqual(page.chats, [])
    assert.equal(page.deletions.length, 1)
    assert.equal(page.deletions[0]!.chatId, target.id)
    assert.equal(page.deletions[0]!.blobGc, 'not_applicable')
    db.close()
  })

  it('uses the existing owner for stable finite pages, coalescing, startup, periodic retry and shutdown', async () => {
    const db = openDb(':memory:')
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const tombstonedAt = new Date(Date.parse(TOMBSTONED_AT) - index).toISOString()
      ids.push(sessionTrash(db, `Batch ${index}`, tombstonedAt).id)
    }
    const dueReasoningChatId = ids.at(-1)!
    seedOwnedRows(
      db,
      dueReasoningChatId,
      'reasoning-before-chat-delete',
      null,
      new Date(Date.parse(DEADLINE) - 1).toISOString(),
    )
    const store = new ChatRetentionStore(db)
    const expectedOrder = ids.toReversed()
    assert.deepEqual(
      store.hardDeletionEligiblePage(DEADLINE, null, 20).map(({ chatId }) => chatId),
      expectedOrder,
    )
    const firstPage = store.hardDeletionEligiblePage(DEADLINE, null, 2)
    const secondPage = store.hardDeletionEligiblePage(DEADLINE, firstPage.at(-1)!, 2)
    const thirdPage = store.hardDeletionEligiblePage(DEADLINE, secondPage.at(-1)!, 2)
    assert.deepEqual([...firstPage, ...secondPage, ...thirdPage].map(({ chatId }) => chatId), expectedOrder)

    const scheduler = new FakeScheduler()
    const owner = new RetentionMaintenanceOwner(store, {
      clock: () => new Date(DEADLINE),
      batchSize: 2,
      maxBatchesPerRun: 1,
      intervalMs: 10,
      scheduler,
      reasoningArtifacts: new ReasoningArtifactStore(db),
    })
    const startupPromise = owner.start()
    assert.equal(owner.start(), startupPromise)
    const startup = await startupPromise
    assert.deepEqual({
      scanned: startup.hardDeletionScanned,
      deleted: startup.hardDeleted,
      batches: startup.hardDeletionBatches,
    }, { scanned: 2, deleted: 2, batches: 1 })
    assert.equal(count(db, 'reasoning_artifact_deletion_audit', 'WHERE chat_id = ?', dueReasoningChatId), 1)
    assert.equal(count(db, 'chat_deletion_audit', 'WHERE chat_id = ?', dueReasoningChatId), 1)
    assert.equal(scheduler.callbacks.length, 1)
    const coalescedA = owner.runOnce()
    const coalescedB = owner.runOnce()
    assert.equal(coalescedA, coalescedB)
    assert.equal((await coalescedA).hardDeleted, 2)
    scheduler.callbacks[0]!()
    for (let attempt = 0; attempt < 100 && count(db, 'chat_deletion_audit') < 5; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.equal(count(db, 'chat_deletion_audit'), 5)
    assert.deepEqual(
      (db.prepare('SELECT chat_id FROM chat_deletion_audit ORDER BY tombstoned_at, chat_id').all() as Array<{ chat_id: string }>)
        .map(({ chat_id }) => chat_id),
      expectedOrder,
    )
    assert.equal((await owner.runOnce()).hardDeleted, 0)
    const retry = sessionTrash(db, 'Owner transaction retry', TOMBSTONED_AT)
    ids.push(retry.id)
    db.exec(`
      CREATE TRIGGER fail_owner_delete_audit
      BEFORE INSERT ON chat_deletion_audit
      BEGIN SELECT RAISE(ABORT, 'injected owner transaction failure'); END;
    `)
    await assert.rejects(owner.runOnce(), /injected owner transaction failure/u)
    assert.equal(count(db, 'threads', 'WHERE id = ?', retry.id), 1)
    assert.equal(count(db, 'chat_deletion_audit'), 5)
    db.exec('DROP TRIGGER fail_owner_delete_audit')
    assert.equal((await owner.runOnce()).hardDeleted, 1)
    assert.equal(count(db, 'chat_deletion_audit'), 6)
    assert.deepEqual(
      store.listTrash({ scope: 'projectless' }, 20).deletions.map(({ chatId }) => chatId),
      ids.toSorted(),
    )
    await owner.close()
    assert.equal(scheduler.cleared.length, 1)
    const afterClose = sessionTrash(db, 'After close', TOMBSTONED_AT)
    scheduler.callbacks[0]!()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(count(db, 'threads', 'WHERE id = ?', afterClose.id), 1)
    await assert.rejects(owner.runOnce(), /closed/u)
    assert.equal(ids.length, 6)
    db.close()
  })

  it('projects bounded deletion audit pages in exact Project scopes through store and route', async () => {
    const db = openDb(':memory:')
    const projects = new ProjectStore(db)
    const project = projects.create('Audit scope', TOMBSTONED_AT)
    const projectIds = ['c', 'a', 'b'].map((suffix) =>
      sessionTrash(db, `Project ${suffix}`, TOMBSTONED_AT, project.id).id)
    const projectlessIds = ['z', 'y'].map((suffix) =>
      sessionTrash(db, `Projectless ${suffix}`, TOMBSTONED_AT).id)
    const store = new ChatRetentionStore(db)
    const candidates = store.hardDeletionEligiblePage(DEADLINE, null, 20)
    assert.equal(store.hardDeleteEligible(candidates, DEADLINE), 5)
    const expectedProject = projectIds.toSorted()
    const expectedProjectless = projectlessIds.toSorted()
    const projectPage = store.listTrash({ scope: 'project', projectId: project.id }, 2)
    assert.deepEqual(projectPage.deletions.map(({ chatId }) => chatId), expectedProject.slice(0, 2))
    assert.equal(projectPage.deletionsHaveMore, true)
    assert.equal(projectPage.deletions.some(({ chatId }) => projectlessIds.includes(chatId)), false)
    const projectlessPage = store.listTrash({ scope: 'projectless' }, 20)
    assert.deepEqual(projectlessPage.deletions.map(({ chatId }) => chatId), expectedProjectless)
    assert.equal(projectlessPage.deletionsHaveMore, false)
    assert.equal(projectlessPage.deletions.some(({ chatId }) => projectIds.includes(chatId)), false)

    const routes = threadsRoutes({
      retention: store,
      projects: { get: (id: string) => id === project.id ? { id } : null },
    } as unknown as AppContext)
    const response = await routes.request(
      `/trash?lifecycleVersion=1&deletionVersion=1&scope=project&projectId=${project.id}&limit=2`,
    )
    assert.equal(response.status, 200)
    const routed = listChatTrashResponse.parse(await response.json())
    assert.deepEqual(routed.deletions.map(({ chatId }) => chatId), expectedProject.slice(0, 2))
    assert.equal(routed.deletionsHaveMore, true)
    for (const query of [
      'lifecycleVersion=1&scope=projectless&limit=2',
      'lifecycleVersion=1&deletionVersion=bad&scope=projectless&limit=2',
      'lifecycleVersion=1&deletionVersion=2&scope=projectless&limit=2',
      'lifecycleVersion=1&deletionVersion=1&deletionVersion=1&scope=projectless&limit=2',
    ]) assert.equal((await routes.request(`/trash?${query}`)).status, 400)
    db.close()
  })

  it('keeps Restore v1 compatible and opts into truthful Session deletion projection', async () => {
    const db = openDb(':memory:')
    const legacyChat = sessionTrash(db, 'Legacy Restore response')
    const optedInChat = sessionTrash(db, 'Opted-in Restore response')
    const store = new ChatRetentionStore(db, {
      clock: () => new Date(Date.parse(DEADLINE) - 1),
    })
    const routes = threadsRoutes({ retention: store } as unknown as AppContext)
    const restore = (chatId: string, body: unknown) => routes.request(`/${chatId}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const legacyResponse = await restore(legacyChat.id, { lifecycleVersion: 1 })
    assert.equal(legacyResponse.status, 200)
    const legacyBody = await legacyResponse.json() as Record<string, unknown>
    assert.equal(legacyBody['hardDeletion'], 'not_implemented')
    assert.equal('deletionVersion' in legacyBody, false)

    const optedInResponse = await restore(optedInChat.id, {
      lifecycleVersion: 1,
      deletionVersion: 1,
    })
    assert.equal(optedInResponse.status, 200)
    assert.deepEqual(await optedInResponse.json(), {
      lifecycleVersion: 1,
      chatId: optedInChat.id,
      projectId: null,
      state: 'active',
      restored: true,
      restoredAt: new Date(Date.parse(DEADLINE) - 1).toISOString(),
      activityBasis: {
        at: new Date(Date.parse(DEADLINE) - 1).toISOString(),
        source: 'chat_restored',
      },
      source: 'user_restore',
      deletionVersion: 1,
      hardDeletion: 'session_metadata_after_recovery_not_scheduled',
    })
    assert.equal((await restore(optedInChat.id, {
      lifecycleVersion: 1,
      deletionVersion: 2,
    })).status, 400)
    db.close()
  })

  it('runs hard deletion through the application owner without runtime or external effects', async (test) => {
    const scheduler = new FakeScheduler()
    const context = await createAppContext({
      dbPath: ':memory:',
      appVersion: 'test',
      retentionMaintenance: {
        clock: () => new Date(DEADLINE), scheduler, intervalMs: 10,
        batchSize: 10, maxBatchesPerRun: 1,
      },
    })
    test.after(async () => {
      await context.maintenance?.close()
      await context.chatExecution.shutdown()
      context.jobService.closeSubscriptions()
      context.db.close()
    })
    const target = sessionTrash(context.db, 'No effect target')
    const unrelated = createChat(context.db, 'Unrelated reasoning')
    seedOwnedRows(context.db, unrelated.id, 'unrelated-reasoning', null)
    const protectedBefore = ownedPayload(context.db, [unrelated.id])
    const toolBefore = JSON.stringify(context.db.prepare('SELECT * FROM tool_runs ORDER BY rowid').all())
    const workspaceBefore = JSON.stringify(context.db.prepare('SELECT * FROM workspaces ORDER BY rowid').all())
    const governorBefore = JSON.stringify(context.governor.snapshot(DEADLINE))
    let ollamaCalls = 0
    let modelCalls = 0
    let workspaceCalls = 0
    context.ollama = () => {
      ollamaCalls += 1
      throw new Error('hard deletion must not call Ollama')
    }
    context.models = () => {
      modelCalls += 1
      throw new Error('hard deletion must not call model/provider services')
    }
    context.workspaces.list = () => {
      workspaceCalls += 1
      throw new Error('hard deletion must not inspect filesystem workspaces')
    }
    const report = await context.maintenance!.runOnce()
    assert.equal(report.hardDeleted, 1)
    assert.equal(count(context.db, 'threads', 'WHERE id = ?', target.id), 0)
    assert.deepEqual({ ollamaCalls, modelCalls, workspaceCalls }, {
      ollamaCalls: 0, modelCalls: 0, workspaceCalls: 0,
    })
    assert.equal(JSON.stringify(context.governor.snapshot(DEADLINE)), governorBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM tool_runs ORDER BY rowid').all()), toolBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM workspaces ORDER BY rowid').all()), workspaceBefore)
    assert.equal(ownedPayload(context.db, [unrelated.id]), protectedBefore)
    assert.equal(count(context.db, 'reasoning_artifact_deletion_audit', 'WHERE chat_id = ?', unrelated.id), 0)
    const storeSource = await readFile(
      new URL('../src/store/chat-retention.ts', import.meta.url),
      'utf8',
    )
    for (const forbidden of [
      'fetch(', "from 'node:fs", 'ollama', 'governor', 'workspace', 'analytics',
      'model-unload', 'modelUnload', 'toolExecutor', 'toolService',
    ]) assert.equal(storeSource.includes(forbidden), false, forbidden)
  })
})
