import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  PROJECT_CHAT_OWNERSHIP_VERSION,
  createProjectChatBody,
  getProjectChatResponse,
  listProjectChatsResponse,
  listProjectlessChatsResponse,
  threadSchema,
  threadWithOwnershipSchema,
} from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { downgradeRetentionLifecycleToV14 } from './fixtures/retention-lifecycle-migration.ts'

const CREATED_AT = '2026-08-10T10:00:00.000Z'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function columnNames(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

function downgradeToV11(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
  db.exec(`
    DROP INDEX idx_threads_retention_policy;
    ALTER TABLE threads DROP COLUMN last_user_activity_source;
    ALTER TABLE threads DROP COLUMN last_user_activity_at;
    ALTER TABLE threads DROP COLUMN retention_policy_updated_at;
    ALTER TABLE threads DROP COLUMN retention_policy_source;
    ALTER TABLE threads DROP COLUMN retention_policy;
    DROP TRIGGER threads_project_chat_update_valid;
    DROP TRIGGER threads_project_chat_insert_valid;
    DROP TRIGGER threads_project_ownership_immutable;
    DROP INDEX idx_threads_project_updated;
    ALTER TABLE threads DROP COLUMN project_id;
    PRAGMA user_version = 11;
  `)
}

function downgradeToV12(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
  db.exec(`
    DROP INDEX idx_threads_retention_policy;
    ALTER TABLE threads DROP COLUMN last_user_activity_source;
    ALTER TABLE threads DROP COLUMN last_user_activity_at;
    ALTER TABLE threads DROP COLUMN retention_policy_updated_at;
    ALTER TABLE threads DROP COLUMN retention_policy_source;
    ALTER TABLE threads DROP COLUMN retention_policy;
    DROP TRIGGER threads_project_chat_update_valid;
    DROP TRIGGER threads_project_chat_insert_valid;
    DROP TRIGGER threads_project_ownership_immutable;
    PRAGMA user_version = 12;
  `)
}

async function temporaryDbPath(test: { after: (fn: () => unknown) => void }, label: string) {
  const root = await mkdtemp(join(tmpdir(), `alamo-project-chat-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'alamo.db')
}

describe('SQLite Project Chat ownership migrations 12–13', () => {
  it('uses a strict versioned projection while preserving the legacy Thread shape', () => {
    const legacy = {
      id: 'thread-1',
      title: 'Legacy',
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      messageCount: 0,
    }
    const owned = {
      ...legacy,
      ownershipVersion: PROJECT_CHAT_OWNERSHIP_VERSION,
      projectId: 'project-1',
    }
    assert.equal(threadSchema.safeParse(legacy).success, true)
    assert.equal(threadWithOwnershipSchema.safeParse(owned).success, true)
    assert.equal(threadWithOwnershipSchema.safeParse({ ...owned, extra: true }).success, false)
    assert.equal(
      threadWithOwnershipSchema.safeParse({
        ...owned,
        options: { ...owned.options, futureField: true },
      }).success,
      false,
    )
    assert.equal(createProjectChatBody.safeParse({ model: 'model' }).success, true)
    for (const invalid of [
      { model: 'model', projectId: 'project-2' },
      { model: 'model', workspaceId: 'workspace-1' },
      { model: 'model', mode: 'agent' },
      { model: 'model', extra: true },
      { model: 'model', options: { futureField: true } },
    ]) {
      assert.equal(createProjectChatBody.safeParse(invalid).success, false)
    }
    assert.equal(
      listProjectChatsResponse.safeParse({
        ownershipVersion: 1,
        project: {
          id: 'project-1',
          name: 'Project',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          filesystemBindings: [],
        },
        chats: [owned],
      }).success,
      true,
    )
    assert.equal(
      listProjectChatsResponse.safeParse({
        ownershipVersion: 1,
        project: {
          id: 'project-2',
          name: 'Other Project',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          filesystemBindings: [],
        },
        chats: [owned],
      }).success,
      false,
    )
    assert.equal(
      getProjectChatResponse.safeParse({
        ownershipVersion: 1,
        project: {
          id: 'project-2',
          name: 'Other Project',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          filesystemBindings: [],
        },
        thread: owned,
        messages: [],
        context: {
          usedTokens: 0,
          allocatedTokens: 8192,
          percent: 0,
          cacheHit: false,
          cachedTokens: 0,
          compactable: false,
          estimatedRepefillMs: 0,
        },
      }).success,
      false,
    )
    assert.equal(
      listProjectlessChatsResponse.safeParse({
        ownershipVersion: 1,
        scope: 'projectless',
        chats: [{ ...owned, projectId: null }],
      }).success,
      true,
    )
  })

  it('keeps fresh, v11 upgrade, reopen and retry nullable without rewriting Threads', async (test) => {
    const path = await temporaryDbPath(test, 'upgrade')
    const fixture = openDb(path)
    const threads = new ThreadStore(fixture)
    const legacy = threads.create({
      title: 'Existing',
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    downgradeToV11(fixture)
    const before = JSON.stringify(fixture.prepare('SELECT * FROM threads').all())
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 23)
    assert.equal(columnNames(upgraded).filter((name) => name === 'project_id').length, 1)
    assert.equal(new ThreadStore(upgraded).getWithOwnership(legacy.id)?.projectId, null)
    const afterRows = upgraded.prepare('SELECT * FROM threads').all() as Array<
      Record<string, unknown> & { project_id: unknown; retention_policy: unknown }
    >
    const withoutAdditiveFields = afterRows.map(({
      project_id: projectId,
      retention_policy: retentionPolicy,
      retention_policy_source: retentionPolicySource,
      retention_policy_updated_at: _retentionPolicyUpdatedAt,
      last_user_activity_at: _lastUserActivityAt,
      last_user_activity_source: _lastUserActivitySource,
      chat_lifecycle_state: lifecycleState,
      chat_tombstoned_at: tombstonedAt,
      chat_tombstone_reason: tombstoneReason,
      chat_tombstone_activity_at: tombstoneActivityAt,
      last_user_restore_at: lastUserRestoreAt,
      session_leave_at: sessionLeaveAt,
      session_leave_source: sessionLeaveSource,
      chat_lifecycle_reason: lifecycleReason,
      ...row
    }) => {
      assert.equal(projectId, null)
      assert.equal(retentionPolicy, 'keep')
      assert.equal(retentionPolicySource, 'legacy_compatibility')
      assert.equal(lifecycleState, 'active')
      assert.equal(tombstonedAt, null)
      assert.equal(tombstoneReason, null)
      assert.equal(tombstoneActivityAt, null)
      assert.equal(lastUserRestoreAt, null)
      assert.equal(sessionLeaveAt, null)
      assert.equal(sessionLeaveSource, null)
      assert.equal(lifecycleReason, null)
      return row
    })
    assert.equal(JSON.stringify(withoutAdditiveFields), before)
    upgraded.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 23)
    assert.equal(columnNames(reopened).filter((name) => name === 'project_id').length, 1)
    assert.equal(
      (reopened.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'threads_project_%'",
      ).get() as { count: number }).count,
      3,
    )
    assert.equal(
      (reopened.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
      1,
    )
    reopened.close()
  })

  it('hardens an already-applied v12 database and recovers a mid-v13 failure', async (test) => {
    const path = await temporaryDbPath(test, 'v13-hardening')
    const fixture = openDb(path)
    const project = new ProjectStore(fixture).create('V12 owner', CREATED_AT)
    const owned = new ThreadStore(fixture).createWithOwnership({
      title: 'Existing v12 ownership',
      model: 'model',
      projectId: project.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    downgradeToV12(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 23)
    assert.equal(new ThreadStore(upgraded).getWithOwnership(owned.id)?.projectId, project.id)
    assert.equal(
      (upgraded.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'threads_project_%'",
      ).get() as { count: number }).count,
      3,
    )
    upgraded.close()

    const conflicted = new DatabaseSync(path)
    downgradeToV12(conflicted)
    conflicted.exec(`
      CREATE TRIGGER threads_project_chat_insert_valid
        BEFORE INSERT ON threads
        BEGIN
          SELECT 1;
        END;
    `)
    conflicted.close()

    assert.throws(() => openDb(path), /Миграция 13 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 12)
    assert.equal(
      (repair.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'threads_project_%'",
      ).get() as { count: number }).count,
      1,
    )
    assert.equal(
      (repair.prepare('SELECT project_id FROM threads WHERE id = ?').get(owned.id) as {
        project_id: string
      }).project_id,
      project.id,
    )
    repair.exec('DROP TRIGGER threads_project_chat_insert_valid')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 23)
    assert.equal(new ThreadStore(recovered).getWithOwnership(owned.id)?.projectId, project.id)
    assert.throws(
      () => recovered.prepare('UPDATE threads SET project_id = NULL WHERE id = ?').run(owned.id),
      /thread project ownership is immutable/u,
    )
    recovered.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 23)
    assert.equal(new ThreadStore(reopened).getWithOwnership(owned.id)?.projectId, project.id)
    reopened.close()
  })

  it('rolls back a mid-migration failure and recovers from unchanged v11', async (test) => {
    const path = await temporaryDbPath(test, 'rollback')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO threads (
        id, title, mode, model, workspace_id, num_ctx, temperature, think, created_at, updated_at
      ) VALUES ('legacy-thread', 'Legacy', 'chat', 'model', NULL, 8192, 0.7, 'off', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT)
    downgradeToV11(fixture)
    fixture.exec('CREATE INDEX idx_threads_project_updated ON threads(updated_at)')
    fixture.close()

    assert.throws(() => openDb(path), /Миграция 12 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 11)
    assert.equal(columnNames(repair).includes('project_id'), false)
    assert.equal(
      (repair.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'threads_project_%'",
      ).get() as { count: number }).count,
      0,
    )
    assert.equal(
      (repair.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
      1,
    )
    repair.exec('DROP INDEX idx_threads_project_updated')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 23)
    assert.equal(new ThreadStore(recovered).getWithOwnership('legacy-thread')?.projectId, null)
    recovered.close()
  })

  it('enforces exact ownership, restrictive deletion and filesystem separation', () => {
    const db = openDb(':memory:')
    const projects = new ProjectStore(db)
    const threads = new ThreadStore(db)
    const first = projects.create('First', CREATED_AT)
    const second = projects.create('Second', CREATED_AT)
    const owned = threads.createWithOwnership({
      title: 'Owned',
      model: 'model',
      projectId: first.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    const tied = threads.createWithOwnership({
      title: 'Tied',
      model: 'model',
      projectId: first.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    db.prepare('UPDATE threads SET updated_at = ? WHERE id IN (?, ?)').run(
      CREATED_AT,
      owned.id,
      tied.id,
    )
    const projectlessOlder = threads.create({
      title: 'Projectless older',
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    const projectlessNewer = threads.create({
      title: 'Projectless newer',
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(
      CREATED_AT,
      projectlessOlder.id,
    )
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(
      '2026-08-10T11:00:00.000Z',
      projectlessNewer.id,
    )
    assert.equal(owned.projectId, first.id)
    assert.equal(owned.workspaceId, null)
    assert.deepEqual(
      threads.listByProject(first.id).map((thread) => thread.id),
      [owned.id, tied.id].sort(),
    )
    assert.deepEqual(threads.listByProject(second.id), [])
    assert.deepEqual(
      threads.listProjectless().map((thread) => thread.id),
      [projectlessNewer.id, projectlessOlder.id],
    )
    assert.throws(
      () => db.prepare(
        `INSERT INTO threads (
          id, title, mode, model, workspace_id, project_id,
          num_ctx, temperature, think, created_at, updated_at
        ) VALUES ('missing-owner', 'Missing', 'chat', 'model', NULL, 'missing', 8192, 0.7, 'off', ?, ?)`,
      ).run(CREATED_AT, CREATED_AT),
      /FOREIGN KEY constraint failed/u,
    )
    assert.throws(
      () => db.prepare('UPDATE threads SET project_id = ? WHERE id = ?').run(second.id, owned.id),
      /thread project ownership is immutable/u,
    )
    assert.throws(
      () => db.prepare('UPDATE threads SET project_id = NULL WHERE id = ?').run(owned.id),
      /thread project ownership is immutable/u,
    )
    assert.throws(
      () => db.prepare("UPDATE threads SET mode = 'agent' WHERE id = ?").run(owned.id),
      /Project-owned thread must be a Chat without Workspace scope/u,
    )
    assert.throws(
      () => db.prepare("UPDATE threads SET workspace_id = 'scope' WHERE id = ?").run(owned.id),
      /Project-owned thread must be a Chat without Workspace scope/u,
    )
    assert.throws(
      () => db.prepare(
        `INSERT INTO threads (
          id, title, mode, model, workspace_id, project_id,
          num_ctx, temperature, think, created_at, updated_at
        ) VALUES ('invalid-owned', 'Invalid', 'agent', 'model', NULL, ?, 8192, 0.7, 'off', ?, ?)`,
      ).run(first.id, CREATED_AT, CREATED_AT),
      /Project-owned thread must be a Chat without Workspace scope/u,
    )
    assert.throws(
      () => db.prepare('DELETE FROM projects WHERE id = ?').run(first.id),
      /FOREIGN KEY constraint failed/u,
    )
    assert.equal(threads.getWithOwnership(owned.id)?.projectId, first.id)
    db.close()
  })
})
