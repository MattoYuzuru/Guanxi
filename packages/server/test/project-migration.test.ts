import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { projectSchema } from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import { ProjectStore } from '../src/store/projects.ts'

const CREATED_AT = '2026-08-09T10:00:00.000Z'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

async function temporaryDbPath(test: { after: (fn: () => unknown) => void }, label: string) {
  const root = await mkdtemp(join(tmpdir(), `alamo-project-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'alamo.db')
}

function downgradeToV9(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE project_filesystem_bindings;
    DROP TABLE projects;
    PRAGMA user_version = 9;
  `)
}

describe('SQLite logical Project migration 10', () => {
  it('keeps the public Project projection strict and timestamped', () => {
    const valid = {
      id: 'project-1',
      name: 'Project',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      filesystemBindings: [],
    }
    assert.equal(projectSchema.safeParse(valid).success, true)
    for (const invalid of [
      { ...valid, id: '' },
      { ...valid, name: '   ' },
      { ...valid, name: ' Project ' },
      { ...valid, name: 'x'.repeat(121) },
      { ...valid, createdAt: '' },
      { ...valid, updatedAt: 'not-a-time' },
      { ...valid, rootPath: '/must-not-exist' },
      {
        ...valid,
        filesystemBindings: [{ id: '', workspaceId: 'workspace-1', createdAt: CREATED_AT }],
      },
    ]) {
      assert.equal(projectSchema.safeParse(invalid).success, false)
    }
  })

  it('keeps fresh and reopened projection identical without inventing a binding', async (test) => {
    const path = await temporaryDbPath(test, 'fresh')
    const first = openDb(path)
    assert.equal(version(first), 10)
    assert.equal(count(first, 'projects'), 0)
    assert.equal(count(first, 'project_filesystem_bindings'), 0)
    first.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 10)
    assert.deepEqual(new ProjectStore(reopened).list(), [])
    reopened.close()
  })

  it('backfills exact legacy identity once and never merges normalized names or paths', async (test) => {
    const path = await temporaryDbPath(test, 'upgrade')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES (?, ?, ?, ?, NULL), (?, ?, ?, ?, NULL), (?, ?, ?, ?, NULL)`,
    ).run(
      'workspace-a', 'Same', '/tmp/project', CREATED_AT,
      'workspace-b', 'Same', '/tmp/../tmp/project', CREATED_AT,
      'workspace-whitespace', '\t\u00a0', '/tmp/whitespace', CREATED_AT,
    )
    downgradeToV9(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 10)
    const projection = new ProjectStore(upgraded).list()
    assert.deepEqual(
      projection.map((project) => ({
        id: project.id,
        name: project.name,
        bindings: project.filesystemBindings.map((binding) => binding.workspaceId),
      })),
      [
        { id: 'workspace-a', name: 'Same', bindings: ['workspace-a'] },
        { id: 'workspace-b', name: 'Same', bindings: ['workspace-b'] },
        {
          id: 'workspace-whitespace',
          name: 'Untitled Project',
          bindings: ['workspace-whitespace'],
        },
      ],
    )
    assert.equal(count(upgraded, 'projects'), 3)
    assert.equal(count(upgraded, 'project_filesystem_bindings'), 3)
    new ProjectStore(upgraded).reconcileLegacyWorkspaces()
    new ProjectStore(upgraded).reconcileLegacyWorkspaces()
    assert.equal(count(upgraded, 'projects'), 3)
    assert.equal(count(upgraded, 'project_filesystem_bindings'), 3)
    upgraded.close()

    const reopened = openDb(path)
    assert.deepEqual(new ProjectStore(reopened).list(), projection)
    reopened.close()
  })

  it('rolls back a mid-backfill failure and recovers from unchanged v9', async (test) => {
    const path = await temporaryDbPath(test, 'rollback')
    const broken = new DatabaseSync(path)
    broken.exec(`
      CREATE TABLE workspaces (
        id TEXT UNIQUE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      INSERT INTO workspaces VALUES
        ('valid-workspace', 'Valid', '/tmp/valid', '${CREATED_AT}', NULL),
        (NULL, 'Broken', '/tmp/broken', '${CREATED_AT}', NULL);
      PRAGMA user_version = 9;
    `)
    broken.close()

    assert.throws(() => openDb(path), /Миграция 10 не применилась/u)

    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 9)
    assert.equal(
      (repair.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name IN ('projects', 'project_filesystem_bindings')`,
      ).get() as { count: number }).count,
      0,
    )
    assert.equal(count(repair, 'workspaces'), 2)
    repair.prepare('UPDATE workspaces SET id = ? WHERE id IS NULL').run('repaired-workspace')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 10)
    assert.equal(count(recovered, 'projects'), 2)
    assert.equal(count(recovered, 'project_filesystem_bindings'), 2)
    recovered.close()
  })

  it('rolls back malformed legacy timestamps without partial Project tables', async (test) => {
    const path = await temporaryDbPath(test, 'timestamp-rollback')
    const broken = new DatabaseSync(path)
    broken.exec(`
      CREATE TABLE workspaces (
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      INSERT INTO workspaces VALUES
        ('valid-workspace', 'Valid', '/tmp/valid', '${CREATED_AT}', NULL),
        ('broken-workspace', 'Broken', '/tmp/broken', '', NULL);
      PRAGMA user_version = 9;
    `)
    broken.close()

    assert.throws(() => openDb(path), /Миграция 10 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 9)
    assert.equal(
      (repair.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name IN ('projects', 'project_filesystem_bindings')`,
      ).get() as { count: number }).count,
      0,
    )
    assert.equal(count(repair, 'workspaces'), 2)
    repair.close()
  })

  it('rejects a conflicting duplicate bridge and rolls reconciliation back atomically', () => {
    const db = openDb(':memory:')
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES ('workspace-a', 'A', '/tmp/a', ?, NULL),
              ('workspace-b', 'B', '/tmp/b', ?, NULL)`,
    ).run(CREATED_AT, CREATED_AT)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES ('wrong-project', 'Wrong', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT)
    db.prepare(
      `INSERT INTO project_filesystem_bindings (id, project_id, workspace_id, created_at)
       VALUES ('wrong-binding', 'wrong-project', 'workspace-b', ?)`,
    ).run(CREATED_AT)

    assert.throws(
      () => new ProjectStore(db).reconcileLegacyWorkspaces(),
      /Conflicting Project binding for legacy Workspace workspace-b/u,
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get('workspace-a') as { count: number }).count,
      0,
    )
    assert.equal(count(db, 'project_filesystem_bindings'), 1)
    db.close()
  })

  it('fails closed on a colliding Project identity without partial reconciliation', () => {
    const db = openDb(':memory:')
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES ('workspace-a', 'A', '/tmp/a', ?, NULL),
              ('workspace-b', 'B', '/tmp/b', ?, NULL)`,
    ).run(CREATED_AT, CREATED_AT)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES ('workspace-b', 'Unrelated', '2026-08-08T00:00:00.000Z', ?)`,
    ).run(CREATED_AT)

    assert.throws(
      () => new ProjectStore(db).reconcileLegacyWorkspaces(),
      /Conflicting Project identity for legacy Workspace workspace-b/u,
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get('workspace-a') as { count: number }).count,
      0,
    )
    assert.equal(count(db, 'project_filesystem_bindings'), 0)
    db.close()
  })
})
