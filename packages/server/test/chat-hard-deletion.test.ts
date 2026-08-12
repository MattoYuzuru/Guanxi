import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  chatDeletionAuditSchema,
  listChatTrashQuery,
  listChatTrashResponse,
} from '@alamo/contract'
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
import { ThreadStore } from '../src/store/threads.ts'
import { downgradeChatHardDeletionToV19 } from './fixtures/retention-lifecycle-migration.ts'

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
    .filter((name) => !excluded.has(name))
  return JSON.stringify(Object.fromEntries(tables.map((name) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  ])))
}

describe('P3-I Session Chat metadata hard deletion', () => {
  it('adds append-only v20 on fresh/v19/reopen and rolls a true late failure back byte-exact for retry', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-delete-v20-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const seed = openDb(path)
    assert.equal(version(seed), 20)
    const chat = createChat(seed, 'Legacy final answer')
    new ThreadStore(seed).addMessage({
      threadId: chat.id,
      role: 'assistant',
      content: 'exact v19 final answer',
      thinking: 'exact v19 legacy thinking',
      turnStatus: 'completed',
      stopReason: 'stop',
    })
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
    assert.equal(version(retried), 20)
    assert.equal(count(retried, 'messages'), 1)
    assert.equal(count(retried, 'chat_deletion_audit'), 0)
    retried.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 20)
    assert.equal(count(reopened, 'chat_deletion_audit'), 0)
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
      assert.equal(store.hardDeleteEligible(candidates, observedAt), eligible ? 1 : 0, `${offset}ms CAS`)
      assert.equal(count(db, 'chat_deletion_audit'), eligible ? 1 : 0)
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
      assert.equal(deleting.hardDeleteEligible(stale, DEADLINE), 0, mode)
      assert.equal(count(db, 'threads', 'WHERE id = ?', chat.id), 1)
      assert.equal(count(db, 'chat_deletion_audit'), 0)
      db.close()
    }

    const policyDb = openDb(':memory:')
    const policyRace = sessionTrash(policyDb, 'Policy-only stale candidate')
    const policyStore = new ChatRetentionStore(policyDb)
    const policyStale = policyStore.hardDeletionEligiblePage(DEADLINE, null, 10)
    policyDb.exec('DROP TRIGGER threads_session_leave_update_valid')
    policyDb.prepare("UPDATE threads SET retention_policy = 'keep' WHERE id = ?").run(policyRace.id)
    assert.equal(policyStore.hardDeleteEligible(policyStale, DEADLINE), 0)
    assert.equal(count(policyDb, 'threads', 'WHERE id = ?', policyRace.id), 1)
    assert.equal(count(policyDb, 'chat_deletion_audit'), 0)
    policyDb.close()

    const retombstoneDb = openDb(':memory:')
    const retombstoned = sessionTrash(retombstoneDb, 'Retombstone')
    const deleting = new ChatRetentionStore(retombstoneDb)
    const stale = deleting.hardDeletionEligiblePage(DEADLINE, null, 10)
    const user = new ChatRetentionStore(retombstoneDb, {
      clock: () => new Date(Date.parse(DEADLINE) - 1),
    })
    assert.equal(user.restore(retombstoned.id).status, 'ok')
    assert.equal(user.leaveSession(retombstoned.id, { scope: 'projectless' }).status, 'ok')
    const newLeave = (retombstoneDb.prepare(
      'SELECT session_leave_at FROM threads WHERE id = ?',
    ).get(retombstoned.id) as { session_leave_at: string }).session_leave_at
    assert.equal(deleting.tombstoneEligible([{
      chatId: retombstoned.id,
      projectId: null,
      activityAt: newLeave,
      activitySource: 'session_leave',
      reason: 'session_left',
    }], DEADLINE), 1)
    assert.equal(deleting.hardDeleteEligible(stale, DEADLINE), 0)
    assert.equal(count(retombstoneDb, 'threads', 'WHERE id = ?', retombstoned.id), 1)
    retombstoneDb.close()

    const jobDb = openDb(':memory:')
    const jobRace = sessionTrash(jobDb, 'Job after scan')
    const jobStore = new ChatRetentionStore(jobDb)
    const jobStale = jobStore.hardDeletionEligiblePage(DEADLINE, null, 10)
    attachJob(jobDb, jobRace.id, 'job-after-scan', 'queued')
    assert.equal(jobStore.hardDeleteEligible(jobStale, DEADLINE), 0)
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
      { child: 'chat_job_inputs', table: 'jobs', from: 'job_id', on_delete: 'CASCADE' },
      { child: 'chat_job_inputs', table: 'messages', from: 'assistant_message_id', on_delete: 'CASCADE' },
      { child: 'chat_job_inputs', table: 'messages', from: 'user_message_id', on_delete: 'CASCADE' },
      { child: 'chat_job_inputs', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'chat_lifecycle_audit', table: 'threads', from: 'chat_id', on_delete: 'CASCADE' },
      { child: 'job_events', table: 'jobs', from: 'job_id', on_delete: 'CASCADE' },
      { child: 'messages', table: 'jobs', from: 'job_id', on_delete: 'SET NULL' },
      { child: 'messages', table: 'threads', from: 'thread_id', on_delete: 'CASCADE' },
      { child: 'project_filesystem_bindings', table: 'projects', from: 'project_id', on_delete: 'CASCADE' },
      { child: 'project_filesystem_bindings', table: 'workspaces', from: 'workspace_id', on_delete: 'CASCADE' },
      { child: 'reasoning_artifacts', table: 'jobs', from: 'source_job_id', on_delete: 'CASCADE' },
      { child: 'reasoning_artifacts', table: 'messages', from: 'source_message_id', on_delete: 'CASCADE' },
      { child: 'reasoning_artifacts', table: 'projects', from: 'project_id', on_delete: 'RESTRICT' },
      { child: 'reasoning_artifacts', table: 'threads', from: 'chat_id', on_delete: 'CASCADE' },
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
    assert.throws(() => store.hardDeleteEligible(candidate, DEADLINE), /injected delete audit failure/u)
    assert.equal(count(db, 'threads', 'WHERE id = ?', target.id), 1)
    assert.equal(count(db, 'messages', 'WHERE thread_id = ?', target.id), 3)
    assert.equal(count(db, 'chat_deletion_audit'), 0)
    db.exec('DROP TRIGGER fail_chat_delete_audit')

    db.exec(`
      CREATE TRIGGER fail_thread_delete
      BEFORE DELETE ON threads
      WHEN OLD.id = '${target.id}'
      BEGIN SELECT RAISE(ABORT, 'injected Thread delete failure'); END;
    `)
    assert.throws(() => store.hardDeleteEligible(candidate, DEADLINE), /injected Thread delete failure/u)
    assert.equal(count(db, 'threads', 'WHERE id = ?', target.id), 1)
    assert.equal(count(db, 'chat_deletion_audit'), 0)
    db.exec('DROP TRIGGER fail_thread_delete')

    assert.equal(store.hardDeleteEligible(candidate, DEADLINE), 1)
    assert.equal(store.hardDeleteEligible(candidate, DEADLINE), 0)
    for (const table of ['threads', 'messages', 'tool_runs', 'chat_job_inputs', 'reasoning_artifacts', 'chat_lifecycle_audit']) {
      const column = table === 'threads' ? 'id'
        : table === 'messages' || table === 'tool_runs' ? 'thread_id'
          : table === 'chat_job_inputs' ? 'thread_id' : 'chat_id'
      assert.equal(count(db, table, `WHERE ${column} = ?`, target.id), 0, table)
    }
    assert.equal(count(db, 'jobs', 'WHERE id = ?', association.job.id), 1)
    assert.equal(count(db, 'job_events', 'WHERE job_id = ?', association.job.id), 2)
    assert.equal(count(db, 'reasoning_artifact_deletion_audit', 'WHERE chat_id = ?', target.id), 1)
    assert.equal(count(db, 'threads', 'WHERE id = ?', neighbor.id), 1)
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
    })
    const startupPromise = owner.start()
    assert.equal(owner.start(), startupPromise)
    const startup = await startupPromise
    assert.deepEqual({
      scanned: startup.hardDeletionScanned,
      deleted: startup.hardDeleted,
      batches: startup.hardDeletionBatches,
    }, { scanned: 2, deleted: 2, batches: 1 })
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
})
