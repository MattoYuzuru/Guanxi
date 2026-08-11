import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  PROJECT_CHAT_OWNERSHIP_VERSION,
  createProjectChatBody,
  listProjectChatsResponse,
  listProjectlessChatsResponse,
  threadSchema,
  threadWithOwnershipSchema,
} from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ThreadStore } from '../src/store/threads.ts'

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
  db.exec(`
    DROP INDEX idx_threads_project_updated;
    ALTER TABLE threads DROP COLUMN project_id;
    PRAGMA user_version = 11;
  `)
}

async function temporaryDbPath(test: { after: (fn: () => unknown) => void }, label: string) {
  const root = await mkdtemp(join(tmpdir(), `alamo-project-chat-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'alamo.db')
}

describe('SQLite Project Chat ownership migration 12', () => {
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
    assert.equal(createProjectChatBody.safeParse({ model: 'model' }).success, true)
    for (const invalid of [
      { model: 'model', projectId: 'project-2' },
      { model: 'model', workspaceId: 'workspace-1' },
      { model: 'model', mode: 'agent' },
      { model: 'model', extra: true },
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
    assert.equal(version(upgraded), 12)
    assert.equal(columnNames(upgraded).filter((name) => name === 'project_id').length, 1)
    assert.equal(new ThreadStore(upgraded).getWithOwnership(legacy.id)?.projectId, null)
    const afterRows = upgraded.prepare('SELECT * FROM threads').all() as Array<
      Record<string, unknown> & { project_id: unknown }
    >
    const withoutOwnership = afterRows.map(({ project_id: projectId, ...row }) => {
      assert.equal(projectId, null)
      return row
    })
    assert.equal(JSON.stringify(withoutOwnership), before)
    upgraded.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 12)
    assert.equal(columnNames(reopened).filter((name) => name === 'project_id').length, 1)
    assert.equal(
      (reopened.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
      1,
    )
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
      (repair.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
      1,
    )
    repair.exec('DROP INDEX idx_threads_project_updated')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 12)
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
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      projectId: first.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    assert.equal(owned.projectId, first.id)
    assert.equal(owned.workspaceId, null)
    assert.deepEqual(threads.listByProject(first.id).map((thread) => thread.id), [owned.id])
    assert.deepEqual(threads.listByProject(second.id), [])
    assert.deepEqual(threads.listProjectless(), [])
    assert.throws(
      () => db.prepare('UPDATE threads SET project_id = ? WHERE id = ?').run('missing', owned.id),
      /FOREIGN KEY constraint failed/u,
    )
    assert.throws(
      () => db.prepare('DELETE FROM projects WHERE id = ?').run(first.id),
      /FOREIGN KEY constraint failed/u,
    )
    assert.equal(threads.getWithOwnership(owned.id)?.projectId, first.id)
    db.close()
  })
})
