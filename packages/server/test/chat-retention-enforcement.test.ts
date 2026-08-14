import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CHAT_LIFECYCLE_VERSION,
  chatTrashItemSchema,
  listChatTrashQuery,
  listChatTrashResponse,
  restoreChatBody,
  restoredChatDeletionLifecycleSchema,
  restoredChatLifecycleSchema,
} from '@alamo/contract'
import { createApp } from '../src/app.ts'
import { createAppContext } from '../src/context.ts'
import {
  RetentionMaintenanceOwner,
  type RetentionMaintenanceScheduler,
} from '../src/retention/maintenance.ts'
import { ChatRetentionStore } from '../src/store/chat-retention.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { downgradeRetentionLifecycleToV14 } from './fixtures/retention-lifecycle-migration.ts'

const DAY_MS = 24 * 60 * 60 * 1_000
const NOW = '2026-08-11T12:00:00.000Z'
const EXACT_BOUNDARY = new Date(Date.parse(NOW) - 7 * DAY_MS).toISOString()
const OLD = new Date(Date.parse(NOW) - 8 * DAY_MS).toISOString()
const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'off' as const }

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function lifecycleColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>)
    .map((column) => column.name)
    .filter((name) => name.includes('lifecycle') || name.includes('tombstone') || name === 'last_user_restore_at')
}

function lifecycleSchemaObjects(db: DatabaseSync): Array<{ type: string; name: string }> {
  return (db.prepare(
    `SELECT type, name
     FROM sqlite_master
     WHERE name IN (
       'chat_lifecycle_audit',
       'idx_chat_lifecycle_audit_chat',
       'idx_threads_chat_ttl_eligibility',
       'idx_threads_chat_trash_scope',
       'threads_chat_lifecycle_insert_valid',
       'threads_chat_lifecycle_update_valid'
     )
     ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string }>).map(({ type, name }) => ({ type, name }))
}

const EXPECTED_LIFECYCLE_SCHEMA_OBJECTS = [
  { type: 'index', name: 'idx_chat_lifecycle_audit_chat' },
  { type: 'index', name: 'idx_threads_chat_trash_scope' },
  { type: 'index', name: 'idx_threads_chat_ttl_eligibility' },
  { type: 'table', name: 'chat_lifecycle_audit' },
  { type: 'trigger', name: 'threads_chat_lifecycle_insert_valid' },
  { type: 'trigger', name: 'threads_chat_lifecycle_update_valid' },
]

function nonLifecycleThreadPayload(db: DatabaseSync): string {
  return JSON.stringify(db.prepare(
    `SELECT id, title, mode, model, workspace_id, project_id, num_ctx, temperature, think,
            created_at, updated_at, retention_policy, retention_policy_source,
            retention_policy_updated_at, last_user_activity_at, last_user_activity_source,
            last_user_restore_at
     FROM threads ORDER BY id`,
  ).all())
}

function downgradeToV14(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
}

function createChat(threads: ThreadStore, title: string, projectId: string | null = null) {
  return projectId
    ? threads.createWithOwnership({ title, model: 'fixture', projectId, options: OPTIONS })
    : threads.create({
        title,
        mode: 'chat',
        model: 'fixture',
        workspaceId: null,
        options: OPTIONS,
      })
}

function setBasis(db: DatabaseSync, chatId: string, basis: string, policy = 'ttl'): void {
  db.prepare(
    `UPDATE threads
     SET retention_policy = ?, last_user_activity_at = ?,
         retention_policy_updated_at = ?, last_user_activity_source = 'user_message',
         last_user_restore_at = NULL
     WHERE id = ?`,
  ).run(policy, basis, basis, chatId)
}

function allTablesPayload(db: DatabaseSync, excluded: ReadonlySet<string>): string {
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name)
    .filter((name) => !excluded.has(name)
      && name !== 'artifact_blobs'
      && name !== 'artifacts'
      && name !== 'artifact_attachments')
  return JSON.stringify(Object.fromEntries(names.map((name) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  ])))
}

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

describe('P3-E Chat TTL Maintenance and recoverable Trash', () => {
  it('keeps lifecycle, Trash scope and Restore contracts strict and sourced', () => {
    const item = {
      lifecycleVersion: CHAT_LIFECYCLE_VERSION,
      chatId: 'chat-1',
      title: 'Expired',
      projectId: null,
      state: 'trash',
      reason: 'ttl_expired',
      tombstonedAt: NOW,
      activityBasis: { at: OLD, source: 'user_message' },
      source: 'server_maintenance',
      hardDeletion: 'not_implemented',
    }
    assert.equal(chatTrashItemSchema.safeParse(item).success, true)
    assert.equal(restoredChatLifecycleSchema.safeParse({
      lifecycleVersion: 1,
      chatId: 'chat-1',
      projectId: null,
      state: 'active',
      restored: true,
      restoredAt: NOW,
      activityBasis: { at: NOW, source: 'chat_restored' },
      source: 'user_restore',
      hardDeletion: 'not_implemented',
    }).success, true)
    assert.equal(restoredChatDeletionLifecycleSchema.safeParse({
      lifecycleVersion: 1,
      deletionVersion: 1,
      chatId: 'chat-1',
      projectId: null,
      state: 'active',
      restored: true,
      restoredAt: NOW,
      activityBasis: { at: NOW, source: 'chat_restored' },
      source: 'user_restore',
      hardDeletion: 'session_metadata_after_recovery_not_scheduled',
    }).success, true)
    for (const invalid of [
      { lifecycleVersion: 2, scope: 'projectless' },
      { lifecycleVersion: 1, scope: 'projectless', projectId: 'leak' },
      { lifecycleVersion: 1, scope: 'project' },
      { lifecycleVersion: 1, scope: 'project', projectId: 'p', limit: 101 },
      { lifecycleVersion: 1, scope: 'future' },
      { lifecycleVersion: 1, scope: 'projectless', limit: 20 },
    ]) assert.equal(listChatTrashQuery.safeParse(invalid).success, false)
    assert.equal(restoreChatBody.safeParse({ lifecycleVersion: 1 }).success, true)
    assert.equal(restoreChatBody.safeParse({ lifecycleVersion: 1, deletionVersion: 1 }).success, true)
    assert.equal(restoreChatBody.safeParse({ lifecycleVersion: 1, deletionVersion: 2 }).success, false)
    assert.equal(restoreChatBody.safeParse({ lifecycleVersion: 2 }).success, false)
    assert.equal(restoreChatBody.safeParse({ lifecycleVersion: 1, future: true }).success, false)
    assert.equal(listChatTrashResponse.safeParse({
      lifecycleVersion: 1,
      scope: 'project',
      projectId: 'project-a',
      chats: [{ ...item, projectId: 'project-b' }],
      hasMore: false,
      deletionVersion: 1,
      deletions: [],
      deletionsHaveMore: false,
    }).success, false)
  })

  it('applies v15 once on fresh, v14 upgrade, reopen and failed retry without data loss', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-retention-v15-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const fixture = openDb(path)
    const threads = new ThreadStore(fixture)
    const project = new ProjectStore(fixture).create('Owner', '2026-08-01T00:00:00.000Z')
    const projectless = createChat(threads, 'Legacy projectless')
    const owned = createChat(threads, 'Legacy owned', project.id)
    threads.addMessage({ threadId: projectless.id, role: 'user', content: 'preserve one' })
    threads.addMessage({ threadId: owned.id, role: 'assistant', content: 'preserve two' })
    downgradeToV14(fixture)
    const before = allTablesPayload(fixture, new Set(['threads']))
    const beforeThreads = JSON.stringify(fixture.prepare(
      `SELECT id, title, mode, model, workspace_id, num_ctx, temperature, think,
              created_at, updated_at, project_id, retention_policy,
              retention_policy_source, retention_policy_updated_at,
              last_user_activity_at, last_user_activity_source
       FROM threads ORDER BY id`,
    ).all())
    fixture.exec('CREATE TABLE chat_lifecycle_audit (collision TEXT)')
    fixture.close()

    assert.throws(() => openDb(path), /Миграция 15 не применилась/)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 14)
    assert.deepEqual(lifecycleColumns(rolledBack), [])
    assert.deepEqual(lifecycleSchemaObjects(rolledBack), [{ type: 'table', name: 'chat_lifecycle_audit' }])
    rolledBack.exec('DROP TABLE chat_lifecycle_audit')
    assert.equal(allTablesPayload(rolledBack, new Set(['threads'])), before)
    assert.equal(JSON.stringify(rolledBack.prepare(
      `SELECT id, title, mode, model, workspace_id, num_ctx, temperature, think,
              created_at, updated_at, project_id, retention_policy,
              retention_policy_source, retention_policy_updated_at,
              last_user_activity_at, last_user_activity_source
       FROM threads ORDER BY id`,
    ).all()), beforeThreads)
    rolledBack.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 27)
    assert.equal(lifecycleColumns(upgraded).length, 6)
    assert.deepEqual(lifecycleSchemaObjects(upgraded), EXPECTED_LIFECYCLE_SCHEMA_OBJECTS)
    assert.equal((upgraded.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE chat_lifecycle_state = 'active'",
    ).get() as { count: number }).count, 2)
    assert.equal((upgraded.prepare('SELECT COUNT(*) AS count FROM chat_lifecycle_audit').get() as { count: number }).count, 0)
    assert.equal(
      allTablesPayload(upgraded, new Set([
        'threads',
        'chat_lifecycle_audit',
        'chat_deletion_audit',
        'reasoning_artifacts',
        'reasoning_artifact_deletion_audit',
        'quick_runs',
        'recipes',
        'recipe_revisions',
        'recipe_job_snapshots',
        'context_checkpoints',
      ])),
      before,
    )
    upgraded.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 27)
    assert.deepEqual(lifecycleSchemaObjects(reopened), EXPECTED_LIFECYCLE_SCHEMA_OBJECTS)
    reopened.close()

    const fresh = openDb(':memory:')
    assert.equal(version(fresh), 27)
    assert.equal(lifecycleColumns(fresh).length, 6)
    assert.deepEqual(lifecycleSchemaObjects(fresh), EXPECTED_LIFECYCLE_SCHEMA_OBJECTS)
    fresh.close()
  })

  it('uses the injected clock, exact inclusive boundary and excludes Keep, Session and unexpired Chats', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const projects = new ProjectStore(db)
    const project = projects.create('Boundary', NOW)
    const older = createChat(threads, 'Older')
    const exactProjectless = createChat(threads, 'Exact projectless')
    const exactProject = createChat(threads, 'Exact Project', project.id)
    const unexpired = createChat(threads, 'Fresh')
    const keep = createChat(threads, 'Keep')
    const session = createChat(threads, 'Session')
    setBasis(db, older.id, OLD)
    setBasis(db, exactProjectless.id, EXACT_BOUNDARY)
    setBasis(db, exactProject.id, EXACT_BOUNDARY)
    setBasis(db, unexpired.id, new Date(Date.parse(EXACT_BOUNDARY) + 1).toISOString())
    setBasis(db, keep.id, OLD, 'keep')
    setBasis(db, session.id, OLD, 'session')
    const store = new ChatRetentionStore(db)
    const eligibleIds = store.eligiblePage(NOW, null, 20).map(({ chatId }) => chatId)
    assert.equal(eligibleIds[0], older.id)
    assert.deepEqual(eligibleIds.slice(1).sort(), [exactProjectless.id, exactProject.id].sort())
    assert.equal(store.tombstoneEligible(store.eligiblePage(NOW, null, 20), NOW), 3)
    assert.equal(store.get(older.id).status, 'in_trash')
    assert.equal(store.get(exactProjectless.id).status, 'in_trash')
    assert.equal(store.get(exactProject.id).status, 'in_trash')
    assert.equal(store.get(unexpired.id).status, 'ok')
    assert.equal(store.get(keep.id).status, 'ok')
    assert.equal(store.get(session.id).status, 'ok')
    db.close()
  })

  it('blocks every canonical non-terminal Chat Job and admits terminal state on the next pass', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const jobs = new JobStore(db)
    const states = [
      'queued', 'reserving', 'loading', 'prefill', 'thinking', 'generating',
      'waiting_tool', 'waiting_approval', 'finalizing', 'cancelling',
    ] as const
    const blocked: string[] = []
    for (const [index, state] of states.entries()) {
      const chat = createChat(threads, `Blocked ${state}`)
      const created = jobs.createChat({
        threadId: chat.id,
        idempotencyScope: `chat:${chat.id}:send:v1`,
        idempotencyKey: `blocked-${index}`,
        requestFingerprint: `fingerprint-${index}`,
        input: { content: state, attachments: [], autoApprove: null },
        derivedTitle: state,
      })
      db.prepare('UPDATE jobs SET status = ?, phase = ? WHERE id = ?').run(state, state, created.job.id)
      setBasis(db, chat.id, OLD)
      blocked.push(chat.id)
    }
    const terminalStates = ['completed', 'failed', 'cancelled', 'interrupted'] as const
    const terminalIds: string[] = []
    for (const [index, state] of terminalStates.entries()) {
      const terminal = createChat(threads, `Terminal ${state}`)
      const terminalJob = jobs.createChat({
        threadId: terminal.id,
        idempotencyScope: `chat:${terminal.id}:send:v1`,
        idempotencyKey: `terminal-${index}`,
        requestFingerprint: `terminal-fingerprint-${index}`,
        input: { content: state, attachments: [], autoApprove: null },
        derivedTitle: state,
      })
      db.prepare('UPDATE jobs SET status = ?, phase = ?, finished_at = ? WHERE id = ?')
        .run(state, state, NOW, terminalJob.job.id)
      setBasis(db, terminal.id, OLD)
      terminalIds.push(terminal.id)
    }
    const store = new ChatRetentionStore(db)
    assert.deepEqual(store.eligiblePage(NOW, null, 100).map(({ chatId }) => chatId).sort(), terminalIds.sort())
    assert.equal(store.tombstoneEligible(store.eligiblePage(NOW, null, 100), NOW), 4)
    assert.deepEqual(terminalIds.map((id) => store.get(id).status), terminalStates.map(() => 'in_trash'))
    assert.deepEqual(blocked.map((id) => store.get(id).status), states.map(() => 'ok'))
    db.close()
  })

  it('bounds stable batches, coalesces one owner, converges once and clears periodic work on close', async () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const chatIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const chat = createChat(threads, `Batch ${index}`)
      setBasis(db, chat.id, OLD)
      chatIds.push(chat.id)
    }
    const pagingStore = new ChatRetentionStore(db)
    const expectedOrder = chatIds.toSorted()
    const firstPage = pagingStore.eligiblePage(NOW, null, 2)
    const secondPage = pagingStore.eligiblePage(NOW, firstPage.at(-1)!, 2)
    const thirdPage = pagingStore.eligiblePage(NOW, secondPage.at(-1)!, 2)
    assert.deepEqual([...firstPage, ...secondPage, ...thirdPage].map(({ chatId }) => chatId), expectedOrder)
    const scheduler = new FakeScheduler()
    const owner = new RetentionMaintenanceOwner(new ChatRetentionStore(db), {
      clock: () => new Date(NOW),
      batchSize: 2,
      maxBatchesPerRun: 1,
      intervalMs: 10,
      scheduler,
    })
    const first = await owner.start()
    assert.deepEqual({ scanned: first.scanned, tombstoned: first.tombstoned, batches: first.batches }, {
      scanned: 2, tombstoned: 2, batches: 1,
    })
    assert.equal(await owner.start(), first)
    assert.equal(scheduler.callbacks.length, 1)
    const second = await owner.runOnce()
    const third = await owner.runOnce()
    const converged = await owner.runOnce()
    assert.deepEqual([second.tombstoned, third.tombstoned, converged.tombstoned], [2, 1, 0])
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE chat_lifecycle_state = 'trash'",
    ).get() as { count: number }).count, 5)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_lifecycle_audit').get() as { count: number }).count, 5)
    await owner.close()
    assert.equal(scheduler.cleared.length, 1)
    scheduler.callbacks[0]!()
    await assert.rejects(owner.runOnce(), /closed/)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_lifecycle_audit').get() as { count: number }).count, 5)
    db.close()
  })

  it('rolls lifecycle and audit back together on failure, then retry converges without duplicate effects', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const first = createChat(threads, 'Atomic first')
    const second = createChat(threads, 'Atomic second')
    setBasis(db, first.id, OLD)
    setBasis(db, second.id, OLD)
    const store = new ChatRetentionStore(db)
    const eligible = store.eligiblePage(NOW, null, 10)
    db.exec(`
      CREATE TRIGGER fail_tombstone_audit
      BEFORE INSERT ON chat_lifecycle_audit
      WHEN NEW.event_type = 'tombstoned'
      BEGIN
        SELECT RAISE(ABORT, 'injected lifecycle audit failure');
      END;
    `)
    assert.throws(() => store.tombstoneEligible(eligible, NOW), /injected lifecycle audit failure/)
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE chat_lifecycle_state = 'trash'",
    ).get() as { count: number }).count, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_lifecycle_audit').get() as { count: number }).count, 0)
    db.exec('DROP TRIGGER fail_tombstone_audit')
    assert.equal(store.tombstoneEligible(eligible, NOW), 2)
    assert.equal(store.tombstoneEligible(eligible, NOW), 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_lifecycle_audit').get() as { count: number }).count, 2)
    db.close()
  })

  it('isolates active and Trash scopes with exact order while preserving every non-lifecycle table', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const projects = new ProjectStore(db)
    const projectA = projects.create('A', NOW)
    const projectB = projects.create('B', NOW)
    const projectless = createChat(threads, 'Projectless Trash')
    const ownedAOld = createChat(threads, 'A old', projectA.id)
    const ownedANew = createChat(threads, 'A new', projectA.id)
    const ownedB = createChat(threads, 'B Trash', projectB.id)
    const active = createChat(threads, 'Active', projectA.id)
    const activeProjectless = createChat(threads, 'Active projectless')
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run('2026-08-11T11:00:00.000Z', active.id)
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run('2026-08-11T11:01:00.000Z', activeProjectless.id)
    threads.addMessage({ threadId: ownedANew.id, role: 'assistant', content: 'retained metadata' })
    for (const chat of [projectless, ownedAOld, ownedANew, ownedB]) setBasis(db, chat.id, OLD)
    const store = new ChatRetentionStore(db)
    const candidates = store.eligiblePage(NOW, null, 20)
    const before = allTablesPayload(db, new Set(['threads', 'chat_lifecycle_audit']))
    const beforeThreads = nonLifecycleThreadPayload(db)
    const projectlessCandidate = candidates.find(({ chatId }) => chatId === projectless.id)!
    const aOldCandidate = candidates.find(({ chatId }) => chatId === ownedAOld.id)!
    const aNewCandidate = candidates.find(({ chatId }) => chatId === ownedANew.id)!
    const bCandidate = candidates.find(({ chatId }) => chatId === ownedB.id)!
    store.tombstoneEligible([projectlessCandidate, aOldCandidate], '2026-08-11T11:58:00.000Z')
    store.tombstoneEligible([bCandidate], '2026-08-11T11:59:00.000Z')
    store.tombstoneEligible([aNewCandidate], NOW)

    assert.deepEqual(threads.list().map(({ id }) => id), [activeProjectless.id, active.id])
    assert.deepEqual(threads.listProjectless().map(({ id }) => id), [activeProjectless.id])
    assert.deepEqual(threads.listByProject(projectA.id).map(({ id }) => id), [active.id])
    assert.deepEqual(threads.listByProject(projectB.id), [])
    assert.equal(threads.get(ownedANew.id), null)
    assert.equal(threads.getWithOwnership(ownedANew.id), null)
    assert.deepEqual(store.listTrash({ scope: 'project', projectId: projectA.id }, 20).chats.map(({ chatId }) => chatId), [
      ownedANew.id,
      ownedAOld.id,
    ])
    assert.deepEqual(store.listTrash({ scope: 'project', projectId: projectB.id }, 20).chats.map(({ chatId }) => chatId), [ownedB.id])
    assert.deepEqual(store.listTrash({ scope: 'projectless' }, 20).chats.map(({ chatId }) => chatId), [projectless.id])
    assert.equal(allTablesPayload(db, new Set(['threads', 'chat_lifecycle_audit'])), before)
    assert.equal(nonLifecycleThreadPayload(db), beforeThreads)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(ownedANew.id) as { count: number }).count, 1)
    db.close()
  })

  it('restores atomically once, renews the rolling basis, and policy change restores only Keep/7 days', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const explicit = createChat(threads, 'Explicit restore')
    const policyKeep = createChat(threads, 'Keep policy restore')
    const policyTtl = createChat(threads, 'TTL policy restore')
    const sessionBlocked = createChat(threads, 'Session blocked')
    for (const chat of [explicit, policyKeep, policyTtl, sessionBlocked]) setBasis(db, chat.id, OLD)
    const store = new ChatRetentionStore(db, { clock: () => new Date('2026-08-11T13:00:00.000Z') })
    store.tombstoneEligible(store.eligiblePage(NOW, null, 20), NOW)
    const beforeOtherTables = allTablesPayload(db, new Set(['threads', 'chat_lifecycle_audit']))
    db.exec(`
      CREATE TRIGGER fail_restore_audit
      BEFORE INSERT ON chat_lifecycle_audit
      WHEN NEW.event_type = 'restored'
      BEGIN
        SELECT RAISE(ABORT, 'injected restore audit failure');
      END;
    `)
    assert.throws(() => store.restore(explicit.id), /injected restore audit failure/)
    assert.equal(store.get(explicit.id).status, 'in_trash')
    db.exec('DROP TRIGGER fail_restore_audit')

    const restored = store.restore(explicit.id)
    assert.equal(restored.status, 'ok')
    if (restored.status === 'ok') {
      assert.equal(restored.lifecycle.restored, true)
      assert.equal(restored.lifecycle.activityBasis.source, 'chat_restored')
      assert.equal(restored.lifecycle.restoredAt, '2026-08-11T13:00:00.000Z')
      assert.equal(restored.lifecycle.hardDeletion, 'not_implemented')
    }
    const repeated = store.restore(explicit.id)
    assert.equal(repeated.status, 'ok')
    if (repeated.status === 'ok') assert.equal(repeated.lifecycle.restored, false)
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE chat_id = ? AND event_type = 'restored'",
    ).get(explicit.id) as { count: number }).count, 1)
    const projection = store.get(explicit.id)
    assert.equal(projection.status, 'ok')
    if (projection.status === 'ok') {
      assert.equal(projection.retention.lastUserActivity.source, 'chat_restored')
      assert.equal(projection.retention.expiresAt, '2026-08-18T13:00:00.000Z')
    }

    const keep = store.update(policyKeep.id, { mode: 'keep' })
    assert.equal(keep.status, 'ok')
    if (keep.status === 'ok') {
      assert.deepEqual(keep.retention.policy, { mode: 'keep' })
      assert.equal(keep.retention.lastUserActivity.source, 'chat_restored')
    }
    const ttl = store.update(policyTtl.id, { mode: 'ttl', expiresAfterDays: 7 })
    assert.equal(ttl.status, 'ok')
    if (ttl.status === 'ok') {
      assert.deepEqual(ttl.retention.policy, { mode: 'ttl', expiresAfterDays: 7 })
      assert.equal(ttl.retention.lastUserActivity.at, '2026-08-11T13:00:00.000Z')
      assert.equal(ttl.retention.lastUserActivity.source, 'chat_restored')
      assert.equal(ttl.retention.expiresAt, '2026-08-18T13:00:00.000Z')
    }
    assert.equal(store.update(policyTtl.id, { mode: 'ttl', expiresAfterDays: 7 }).status, 'ok')
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE chat_id = ? AND event_type = 'restored' AND reason = 'policy_change'",
    ).get(policyTtl.id) as { count: number }).count, 1)
    assert.equal(store.update(sessionBlocked.id, { mode: 'session' }).status, 'in_trash')
    assert.equal(store.get(sessionBlocked.id).status, 'in_trash')
    assert.equal(allTablesPayload(db, new Set(['threads', 'chat_lifecycle_audit'])), beforeOtherTables)
    db.close()
  })

  it('runs startup Maintenance once after construction and exposes strict scoped read/restore routes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-retention-startup-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const seed = openDb(path)
    const project = new ProjectStore(seed).create('Startup owner', NOW)
    const projectless = createChat(new ThreadStore(seed), 'Startup projectless')
    const owned = createChat(new ThreadStore(seed), 'Startup owned', project.id)
    setBasis(seed, projectless.id, OLD)
    setBasis(seed, owned.id, OLD)
    seed.close()
    const scheduler = new FakeScheduler()
    const context = await createAppContext({
      dbPath: path,
      appVersion: 'test',
      retentionMaintenance: {
        clock: () => new Date(NOW),
        scheduler,
        intervalMs: 10,
        batchSize: 10,
        maxBatchesPerRun: 1,
      },
    })
    test.after(async () => {
      await context.maintenance?.close()
      await context.chatExecution.shutdown()
      context.jobService.closeSubscriptions()
      context.db.close()
    })
    assert.equal(scheduler.callbacks.length, 1)
    let ollamaCalls = 0
    let modelCalls = 0
    context.ollama = () => {
      ollamaCalls += 1
      throw new Error('Retention must not call Ollama')
    }
    context.models = () => {
      modelCalls += 1
      throw new Error('Retention must not call model services')
    }
    const governorBefore = JSON.stringify(context.governor.snapshot(NOW))
    const laterExpired = createChat(context.threads, 'Post-start Maintenance')
    setBasis(context.db, laterExpired.id, OLD)
    assert.equal((await context.maintenance!.runOnce()).tombstoned, 1)
    assert.deepEqual({ ollamaCalls, modelCalls }, { ollamaCalls: 0, modelCalls: 0 })
    assert.equal(JSON.stringify(context.governor.snapshot(NOW)), governorBefore)
    assert.equal(context.retention.restore(laterExpired.id).status, 'ok')
    const app = createApp(context)
    assert.equal((await app.request(`/api/threads/${projectless.id}`)).status, 404)
    assert.deepEqual(
      (await (await app.request('/api/threads/trash?lifecycleVersion=1&deletionVersion=1&scope=projectless&limit=20')).json() as { chats: Array<{ chatId: string }> }).chats.map(({ chatId }) => chatId),
      [projectless.id],
    )
    assert.deepEqual(
      (await (await app.request(`/api/threads/trash?lifecycleVersion=1&deletionVersion=1&scope=project&projectId=${project.id}&limit=20`)).json() as { chats: Array<{ chatId: string }> }).chats.map(({ chatId }) => chatId),
      [owned.id],
    )
    assert.equal((await app.request(`/api/threads/trash?lifecycleVersion=1&deletionVersion=1&scope=project&projectId=missing&limit=20`)).status, 404)
    for (const query of [
      'lifecycleVersion=1&scope=projectless',
      'lifecycleVersion=2&deletionVersion=1&scope=projectless',
      'lifecycleVersion=1&deletionVersion=bad&scope=projectless',
      'lifecycleVersion=1&deletionVersion=2&scope=projectless',
      'lifecycleVersion=1&deletionVersion=1&deletionVersion=1&scope=projectless',
      'lifecycleVersion=1&deletionVersion=1&scope=projectless&projectId=leak',
      'lifecycleVersion=1&deletionVersion=1&scope=projectless&scope=project',
      'lifecycleVersion=1&deletionVersion=1&scope=project&projectId=x&future=1',
    ]) assert.equal((await app.request(`/api/threads/trash?${query}`)).status, 400)
    const ownedBeforeInvalid = JSON.stringify(context.db.prepare('SELECT * FROM threads WHERE id = ?').get(owned.id))
    for (const body of [
      { retentionVersion: 2, policy: { mode: 'keep' } },
      { retentionVersion: 1, policy: { mode: 'future' } },
      { retentionVersion: 1, policy: { mode: 'keep' }, future: true },
    ]) {
      assert.equal((await app.request(`/api/threads/${owned.id}/retention`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).status, 400)
    }
    assert.equal((await app.request(`/api/threads/${owned.id}/retention`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retentionVersion: 1, policy: { mode: 'session' } }),
    })).status, 409)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM threads WHERE id = ?').get(owned.id)), ownedBeforeInvalid)
    const policyRestore = await app.request(`/api/threads/${owned.id}/retention`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retentionVersion: 1, policy: { mode: 'keep' } }),
    })
    assert.equal(policyRestore.status, 200)
    assert.equal((await app.request(`/api/projects/${project.id}/chats/${owned.id}`)).status, 200)
    assert.equal((context.db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE chat_id = ? AND reason = 'policy_change'",
    ).get(owned.id) as { count: number }).count, 1)
    const beforeInvalid = JSON.stringify(context.db.prepare('SELECT * FROM threads ORDER BY id').all())
    assert.equal((await app.request(`/api/threads/${projectless.id}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lifecycleVersion: 2 }),
    })).status, 400)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM threads ORDER BY id').all()), beforeInvalid)
    const restore = await app.request(`/api/threads/${projectless.id}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lifecycleVersion: 1 }),
    })
    assert.equal(restore.status, 200)
    assert.equal((await app.request(`/api/threads/${projectless.id}`)).status, 200)
    assert.equal((await app.request(`/api/threads/${projectless.id}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lifecycleVersion: 1 }),
    })).status, 200)
    assert.equal((context.db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE chat_id = ? AND event_type = 'restored'",
    ).get(projectless.id) as { count: number }).count, 1)
  })
})
