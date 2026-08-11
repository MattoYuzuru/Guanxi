import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CHAT_RETENTION_VERSION,
  chatRetentionProjectionSchema,
  updateChatRetentionBody,
} from '@alamo/contract'
import { ChatRetentionStore } from '../src/store/chat-retention.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { downgradeRetentionLifecycleToV14 } from './fixtures/retention-lifecycle-migration.ts'

const DAY_MS = 24 * 60 * 60 * 1_000
const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'off' as const }

function dbVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function retentionColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>)
    .map((column) => column.name)
    .filter((name) => name.includes('retention') || name.includes('user_activity'))
}

function migrationPayload(db: DatabaseSync): string {
  return JSON.stringify({
    threads: db.prepare(
      `SELECT id, title, mode, model, workspace_id, project_id, num_ctx,
              temperature, think, created_at, updated_at
       FROM threads ORDER BY id`,
    ).all(),
    messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
    projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
    workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    bindings: db.prepare('SELECT * FROM project_filesystem_bindings ORDER BY id').all(),
  })
}

function tablesPayload(db: DatabaseSync, names: string[]): string {
  return JSON.stringify(Object.fromEntries(names.map((name) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  ])))
}

function downgradeToV13(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
  db.exec(`
    DROP INDEX idx_threads_retention_policy;
    ALTER TABLE threads DROP COLUMN last_user_activity_source;
    ALTER TABLE threads DROP COLUMN last_user_activity_at;
    ALTER TABLE threads DROP COLUMN retention_policy_updated_at;
    ALTER TABLE threads DROP COLUMN retention_policy_source;
    ALTER TABLE threads DROP COLUMN retention_policy;
    PRAGMA user_version = 13;
  `)
}

async function temporaryDbPath(test: { after: (fn: () => unknown) => void }, label: string) {
  const root = await mkdtemp(join(tmpdir(), `alamo-retention-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'alamo.db')
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

describe('P3-D Chat retention contract and migration 14', () => {
  it('keeps the versioned policy/projection strict and requires exact sourced expiry', () => {
    const activityAt = '2026-08-11T10:00:00.000Z'
    const projection = {
      retentionVersion: CHAT_RETENTION_VERSION,
      chatId: 'chat-1',
      projectId: null,
      policy: { mode: 'ttl', expiresAfterDays: 7 },
      policySource: 'default',
      policyUpdatedAt: activityAt,
      lastUserActivity: { at: activityAt, source: 'chat_created' },
      expiresAt: '2026-08-18T10:00:00.000Z',
      expirySource: 'server_calculated',
      enforcement: 'not_implemented',
    }
    assert.equal(chatRetentionProjectionSchema.safeParse(projection).success, true)
    for (const invalid of [
      { retentionVersion: 1, policy: { mode: 'future' } },
      { retentionVersion: 1, policy: { mode: 'keep', future: true } },
      { retentionVersion: 1, policy: { mode: 'ttl', expiresAfterDays: 30 } },
      { retentionVersion: 1, policy: { mode: 'session' }, future: true },
    ]) {
      assert.equal(updateChatRetentionBody.safeParse(invalid).success, false)
    }
    assert.equal(
      chatRetentionProjectionSchema.safeParse({ ...projection, future: true }).success,
      false,
    )
    assert.equal(
      chatRetentionProjectionSchema.safeParse({
        ...projection,
        lastUserActivity: { ...projection.lastUserActivity, future: true },
      }).success,
      false,
    )
    assert.equal(
      chatRetentionProjectionSchema.safeParse({ ...projection, expiresAt: 'not-a-date' }).success,
      false,
    )
    assert.equal(
      chatRetentionProjectionSchema.safeParse({
        ...projection,
        expiresAt: '2026-08-18T09:59:59.999Z',
      }).success,
      false,
    )
    for (const policy of [{ mode: 'keep' }, { mode: 'session' }] as const) {
      assert.equal(
        chatRetentionProjectionSchema.safeParse({
          ...projection,
          policy,
          expiresAt: null,
          expirySource: 'policy_without_time_expiry',
        }).success,
        true,
      )
    }
  })

  it('applies v14 once on fresh, v13 upgrade, reopen and retry without losing history', async (test) => {
    const path = await temporaryDbPath(test, 'migration')
    const fixture = openDb(path)
    const threads = new ThreadStore(fixture)
    const legacy = createChat(threads, 'Existing history')
    const message = threads.addMessage({ threadId: legacy.id, role: 'user', content: 'preserve me' })
    const owner = new ProjectStore(fixture).create('Existing owner', '2026-08-01T00:00:00.000Z')
    const owned = createChat(threads, 'Existing owned history', owner.id)
    threads.addMessage({ threadId: owned.id, role: 'user', content: 'preserve ownership' })
    fixture.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES ('workspace-extra', 'Extra root', '/fixture/root', ?, NULL)`,
    ).run('2026-08-01T00:00:00.000Z')
    const boundProject = new ProjectStore(fixture).create('Bound project', '2026-08-02T00:00:00.000Z')
    fixture.prepare(
      `INSERT INTO project_filesystem_bindings (id, project_id, workspace_id, created_at)
       VALUES ('binding-extra', ?, 'workspace-extra', ?)`,
    ).run(boundProject.id, '2026-08-02T00:00:00.000Z')
    downgradeToV13(fixture)
    const exactLegacyPayload = migrationPayload(fixture)
    fixture.exec('CREATE INDEX idx_threads_retention_policy ON threads(title)')
    fixture.close()

    assert.throws(() => openDb(path), /Миграция 14 не применилась/)
    const rolledBack = new DatabaseSync(path)
    assert.equal(dbVersion(rolledBack), 13)
    assert.deepEqual(retentionColumns(rolledBack), [])
    assert.equal(migrationPayload(rolledBack), exactLegacyPayload)
    assert.equal(
      (rolledBack.prepare('SELECT content FROM messages WHERE id = ?').get(message.id) as { content: string }).content,
      'preserve me',
    )
    assert.equal(
      (rolledBack.prepare('SELECT project_id FROM threads WHERE id = ?').get(owned.id) as { project_id: string }).project_id,
      owner.id,
    )
    rolledBack.exec('DROP INDEX idx_threads_retention_policy')
    rolledBack.close()

    const upgraded = openDb(path)
    assert.equal(dbVersion(upgraded), 16)
    assert.equal(retentionColumns(upgraded).length, 5)
    assert.equal(migrationPayload(upgraded), exactLegacyPayload)
    assert.equal(
      (upgraded.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_threads_retention_policy'").get() as { count: number }).count,
      1,
    )
    const safe = new ChatRetentionStore(upgraded).get(legacy.id)
    assert.equal(safe.status, 'ok')
    if (safe.status === 'ok') {
      assert.deepEqual(safe.retention.policy, { mode: 'keep' })
      assert.equal(safe.retention.policySource, 'legacy_compatibility')
      assert.equal(safe.retention.expiresAt, null)
    }
    const ownedSafe = new ChatRetentionStore(upgraded).get(owned.id)
    assert.equal(ownedSafe.status, 'ok')
    if (ownedSafe.status === 'ok') {
      assert.equal(ownedSafe.retention.projectId, owner.id)
      assert.deepEqual(ownedSafe.retention.policy, { mode: 'keep' })
      assert.equal(ownedSafe.retention.expiresAt, null)
    }
    upgraded.close()

    const reopened = openDb(path)
    assert.equal(dbVersion(reopened), 16)
    assert.equal(retentionColumns(reopened).length, 5)
    assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count, 2)
    assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 2)
    reopened.close()

    const fresh = openDb(':memory:')
    assert.equal(dbVersion(fresh), 16)
    assert.equal(retentionColumns(fresh).length, 5)
    fresh.close()
  })

  it('uses one seven-day default for projectless and Project Chat without extra work', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const projects = new ProjectStore(db)
    const ownerA = projects.create('A', '2026-08-11T10:00:00.000Z')
    const ownerB = projects.create('B', '2026-08-11T10:00:00.000Z')
    const chats = [
      createChat(threads, 'Projectless'),
      createChat(threads, 'Owned A', ownerA.id),
      createChat(threads, 'Owned B', ownerB.id),
    ]
    const store = new ChatRetentionStore(db)
    const projections = chats.map((chat) => store.get(chat.id))
    for (const result of projections) {
      assert.equal(result.status, 'ok')
      if (result.status === 'ok') {
        assert.deepEqual(result.retention.policy, { mode: 'ttl', expiresAfterDays: 7 })
        assert.equal(result.retention.policySource, 'default')
        assert.equal(result.retention.lastUserActivity.source, 'chat_created')
        assert.equal(
          Date.parse(result.retention.expiresAt!),
          Date.parse(result.retention.lastUserActivity.at) + 7 * DAY_MS,
        )
      }
    }
    assert.deepEqual(
      projections.map((result) => result.status === 'ok' ? result.retention.projectId : 'invalid'),
      [null, ownerA.id, ownerB.id],
    )
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 0)
    db.close()
  })

  it('moves rolling activity once inside accepted Chat command and ignores duplicate/background work', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const chat = createChat(threads, 'Activity')
    const oldBasis = '2026-08-01T00:00:00.000Z'
    db.prepare(
      "UPDATE threads SET last_user_activity_at = ?, last_user_activity_source = 'chat_created' WHERE id = ?",
    ).run(oldBasis, chat.id)
    const jobs = new JobStore(db)
    const command = {
      threadId: chat.id,
      idempotencyScope: `chat:${chat.id}:send:v1`,
      idempotencyKey: 'same-command',
      requestFingerprint: 'fingerprint',
      input: { content: 'hello', attachments: [], autoApprove: null },
      derivedTitle: 'hello',
    }
    const created = jobs.createChat(command)
    assert.equal(created.created, true)
    const afterUser = new ChatRetentionStore(db).get(chat.id)
    assert.equal(afterUser.status, 'ok')
    if (afterUser.status !== 'ok') throw new Error('retention missing')
    assert.equal(afterUser.retention.lastUserActivity.source, 'user_message')
    assert.equal(afterUser.retention.lastUserActivity.at, created.createdAt)
    assert.equal(
      afterUser.retention.expiresAt,
      new Date(Date.parse(created.createdAt) + 7 * DAY_MS).toISOString(),
    )

    const duplicate = jobs.createChat(command)
    assert.equal(duplicate.created, false)
    assert.equal(new ChatRetentionStore(db).get(chat.id).status, 'ok')
    assert.equal(
      (new ChatRetentionStore(db).get(chat.id) as typeof afterUser).retention.lastUserActivity.at,
      created.createdAt,
    )
    jobs.transition({
      jobId: created.job.id,
      expectedStatus: 'queued',
      status: 'reserving',
      phase: 'background-progress',
    })
    threads.updateMessage(created.assistantMessageId, { content: 'model output' })
    threads.recordToolRun(chat.id, created.assistantMessageId, {
      id: 'tool-1',
      name: 'noop',
      arguments: {},
      status: 'ok',
      result: 'done',
      error: null,
      durationMs: 1,
      source: 'builtin',
      parsedFrom: 'native',
      diff: null,
    })
    const reopened = new ChatRetentionStore(db).get(chat.id)
    assert.equal(reopened.status, 'ok')
    if (reopened.status === 'ok') {
      assert.equal(reopened.retention.lastUserActivity.at, created.createdAt)
      assert.equal(reopened.retention.expiresAt, afterUser.retention.expiresAt)
    }
    db.close()
  })

  it('rolls back Job, Message and activity together when accepted command persistence fails', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const chat = createChat(threads, 'Atomic title')
    const jobs = new JobStore(db)
    const command = {
      threadId: chat.id,
      idempotencyScope: `chat:${chat.id}:send:v1`,
      idempotencyKey: 'atomic-command',
      requestFingerprint: 'atomic-fingerprint',
      input: { content: 'atomic hello', attachments: [], autoApprove: null },
      derivedTitle: 'changed title',
    }
    const tables = ['threads', 'messages', 'jobs', 'job_events', 'chat_job_inputs']
    const before = tablesPayload(db, tables)
    const retentionBefore = new ChatRetentionStore(db).get(chat.id)
    db.exec(`
      CREATE TRIGGER fail_chat_activity_update
      BEFORE UPDATE OF last_user_activity_at ON threads
      WHEN NEW.last_user_activity_source = 'user_message'
      BEGIN
        SELECT RAISE(ABORT, 'injected activity persistence failure');
      END;
    `)

    assert.throws(() => jobs.createChat(command), /injected activity persistence failure/)
    assert.equal(tablesPayload(db, tables), before)
    assert.deepEqual(new ChatRetentionStore(db).get(chat.id), retentionBefore)

    db.exec('DROP TRIGGER fail_chat_activity_update')
    const recovered = jobs.createChat(command)
    assert.equal(recovered.created, true)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM job_events').get() as { count: number }).count, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_job_inputs').get() as { count: number }).count, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 2)
    const retentionAfter = new ChatRetentionStore(db).get(chat.id)
    assert.equal(retentionAfter.status, 'ok')
    if (retentionAfter.status === 'ok') {
      assert.equal(retentionAfter.retention.lastUserActivity.source, 'user_message')
      assert.equal(retentionAfter.retention.lastUserActivity.at, recovered.createdAt)
    }
    db.close()
  })

  it('round-trips policies per Chat while mutating only retention policy fields', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const project = new ProjectStore(db).create('Owner', '2026-08-11T10:00:00.000Z')
    const projectless = createChat(threads, 'Projectless')
    const owned = createChat(threads, 'Owned', project.id)
    const untouched = createChat(threads, 'Untouched', project.id)
    threads.addMessage({ threadId: projectless.id, role: 'user', content: 'history' })
    const beforeThread = db.prepare('SELECT * FROM threads WHERE id = ?').get(projectless.id) as Record<string, unknown>
    const beforeMessages = JSON.stringify(db.prepare('SELECT * FROM messages').all())
    const beforeProjects = JSON.stringify(db.prepare('SELECT * FROM projects').all())

    const retention = new ChatRetentionStore(db)
    const keep = retention.update(projectless.id, { mode: 'keep' })
    const session = retention.update(owned.id, { mode: 'session' })
    assert.equal(keep.status, 'ok')
    assert.equal(session.status, 'ok')
    if (keep.status === 'ok') {
      assert.deepEqual(keep.retention.policy, { mode: 'keep' })
      assert.ok(Date.parse(keep.retention.policyUpdatedAt) > Date.parse(beforeThread['retention_policy_updated_at'] as string))
    }
    if (session.status === 'ok') assert.deepEqual(session.retention.policy, { mode: 'session' })
    const untouchedProjection = retention.get(untouched.id)
    assert.equal(untouchedProjection.status, 'ok')
    if (untouchedProjection.status === 'ok') {
      assert.deepEqual(untouchedProjection.retention.policy, { mode: 'ttl', expiresAfterDays: 7 })
    }

    const afterThread = db.prepare('SELECT * FROM threads WHERE id = ?').get(projectless.id) as Record<string, unknown>
    const allowed = new Set(['retention_policy', 'retention_policy_source', 'retention_policy_updated_at'])
    for (const key of Object.keys(beforeThread)) {
      if (!allowed.has(key)) assert.deepEqual(afterThread[key], beforeThread[key], key)
    }
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages').all()), beforeMessages)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM projects').all()), beforeProjects)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM settings').get() as { count: number }).count, 0)
    db.close()
  })
})
