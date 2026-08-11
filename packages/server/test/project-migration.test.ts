import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DEFAULT_PROJECT_COLOR_TOKEN,
  DEFAULT_PROJECT_ICON_KEY,
  PROJECT_COLOR_PALETTE,
  PROJECT_COLOR_TOKENS,
  PROJECT_ICON_KEYS,
  PROJECT_ICON_MANIFEST,
  PROJECT_ICON_SOURCE,
  PROJECT_PRESENTATION_VERSION,
  listProjectsResponse,
  listProjectsWithPresentationResponse,
  projectSchema,
  projectWithPresentationSchema,
  updateProjectPresentationBody,
} from '@alamo/contract'
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
    DROP TABLE project_filesystem_bindings;
    DROP TABLE projects;
    PRAGMA user_version = 9;
  `)
}

function downgradeToV10(db: DatabaseSync): void {
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
    ALTER TABLE projects DROP COLUMN color_token;
    ALTER TABLE projects DROP COLUMN icon_key;
    PRAGMA user_version = 10;
  `)
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

function sqliteCheckValues(db: DatabaseSync, column: string): string[] {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'projects'").get() as {
    sql: string
  }
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(
    `CHECK \\(${escaped} IN \\(\\s*([\\s\\S]*?)\\s*\\)\\)`,
    'u',
  ).exec(row.sql)
  assert.ok(match, `Missing ${column} CHECK allowlist`)
  return Array.from(match[1]!.matchAll(/'([^']+)'/gu), (value) => value[1]!)
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
    assert.equal(version(first), 14)
    assert.equal(count(first, 'projects'), 0)
    assert.equal(count(first, 'project_filesystem_bindings'), 0)
    first.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 14)
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
    assert.equal(version(upgraded), 14)
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
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('chat','agent')),
        model TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        num_ctx INTEGER NOT NULL,
        temperature REAL NOT NULL,
        think TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    assert.equal(version(recovered), 14)
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

describe('SQLite Project presentation migration 11', () => {
  it('keeps manifest v1 stable, unique, sourced and AA-contrasting in both themes', () => {
    assert.equal(PROJECT_PRESENTATION_VERSION, 1)
    assert.equal(PROJECT_ICON_MANIFEST.length, 48)
    assert.equal(new Set(PROJECT_ICON_KEYS).size, PROJECT_ICON_KEYS.length)
    assert.equal(
      createHash('sha256').update(JSON.stringify(PROJECT_ICON_KEYS)).digest('hex'),
      '8df658dfaa467520ab007309b3d4167afd74cd89fbe61a2401ba3f34eed2ddde',
    )
    assert.equal(PROJECT_ICON_SOURCE.library, 'Lucide')
    assert.equal(PROJECT_ICON_SOURCE.license, 'ISC')
    assert.match(PROJECT_ICON_SOURCE.licenseUrl, /^https:\/\/github\.com\/lucide-icons\/lucide/u)
    for (const icon of PROJECT_ICON_MANIFEST) {
      assert.equal(icon.nameKey.startsWith('projects.icon.'), true)
    }
    assert.equal(new Set(PROJECT_COLOR_PALETTE.map((color) => color.token)).size, 8)
    for (const color of PROJECT_COLOR_PALETTE) {
      assert.equal(contrastRatio(color.light.foreground, color.light.background) >= 4.5, true)
      assert.equal(contrastRatio(color.dark.foreground, color.dark.background) >= 4.5, true)
    }
  })

  it('uses an explicit projection version while preserving the strict legacy response', () => {
    const legacy = {
      id: 'project-1',
      name: 'Project',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      filesystemBindings: [],
    }
    const current = {
      ...legacy,
      presentationVersion: PROJECT_PRESENTATION_VERSION,
      iconKey: DEFAULT_PROJECT_ICON_KEY,
      colorToken: DEFAULT_PROJECT_COLOR_TOKEN,
    }
    assert.equal(projectSchema.safeParse(legacy).success, true)
    assert.equal(projectSchema.safeParse(current).success, false)
    assert.equal(projectWithPresentationSchema.safeParse(current).success, true)
    assert.equal(listProjectsResponse.safeParse({ projects: [legacy] }).success, true)
    assert.equal(
      listProjectsWithPresentationResponse.safeParse({
        presentationVersion: PROJECT_PRESENTATION_VERSION,
        projects: [current],
      }).success,
      true,
    )
    for (const invalid of [
      { ...current, iconKey: 'future-icon' },
      { ...current, colorToken: 'future-color' },
      { ...current, iconKey: 'x'.repeat(10_000) },
      { ...current, extra: true },
    ]) {
      assert.equal(projectWithPresentationSchema.safeParse(invalid).success, false)
    }
    for (const invalid of [
      { presentationVersion: 2, iconKey: 'folder', colorToken: 'slate' },
      { presentationVersion: 1, iconKey: 'future-icon', colorToken: 'slate' },
      { presentationVersion: 1, iconKey: 'folder', colorToken: 'future-color' },
      { presentationVersion: 1, iconKey: 'folder', colorToken: 'slate', extra: true },
    ]) {
      assert.equal(updateProjectPresentationBody.safeParse(invalid).success, false)
    }
  })

  it('backfills v10 once with deterministic defaults and preserves them across reopen and retry', async (test) => {
    const path = await temporaryDbPath(test, 'presentation-upgrade')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES ('project-v10', 'Existing', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT)
    downgradeToV10(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 14)
    const projects = new ProjectStore(upgraded)
    assert.deepEqual(projects.listWithPresentation().map((project) => ({
      id: project.id,
      iconKey: project.iconKey,
      colorToken: project.colorToken,
      bindings: project.filesystemBindings.length,
    })), [{ id: 'project-v10', iconKey: 'folder', colorToken: 'slate', bindings: 0 }])
    projects.reconcileLegacyWorkspaces()
    projects.reconcileLegacyWorkspaces()
    assert.equal(count(upgraded, 'projects'), 1)
    assert.equal(count(upgraded, 'project_filesystem_bindings'), 0)
    upgraded.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 14)
    const reopenedProject = new ProjectStore(reopened).getWithPresentation('project-v10')
    assert.deepEqual(
      reopenedProject && {
        iconKey: reopenedProject.iconKey,
        colorToken: reopenedProject.colorToken,
      },
      { iconKey: 'folder', colorToken: 'slate' },
    )
    assert.equal(count(reopened, 'projects'), 1)
    reopened.close()
  })

  it('keeps the canonical manifest and SQLite allowlists in lockstep', () => {
    const db = openDb(':memory:')
    const projects = new ProjectStore(db)
    const project = projects.create('Manifest boundary', CREATED_AT)
    assert.deepEqual(
      sqliteCheckValues(db, 'icon_key').sort(),
      [...PROJECT_ICON_KEYS].sort(),
    )
    assert.deepEqual(
      sqliteCheckValues(db, 'color_token').sort(),
      [...PROJECT_COLOR_TOKENS].sort(),
    )
    for (const icon of PROJECT_ICON_MANIFEST) {
      assert.equal(
        projects.updatePresentation(project.id, icon.key, 'slate', CREATED_AT)?.iconKey,
        icon.key,
      )
    }
    for (const color of PROJECT_COLOR_PALETTE) {
      assert.equal(
        projects.updatePresentation(project.id, 'folder', color.token, CREATED_AT)?.colorToken,
        color.token,
      )
    }
    assert.throws(
      () => db.prepare("UPDATE projects SET icon_key = 'future-icon' WHERE id = ?").run(project.id),
      /CHECK constraint failed/u,
    )
    assert.throws(
      () => db.prepare("UPDATE projects SET color_token = 'future-color' WHERE id = ?").run(project.id),
      /CHECK constraint failed/u,
    )
    assert.deepEqual(
      { ...db.prepare('SELECT icon_key, color_token FROM projects WHERE id = ?').get(project.id) },
      { icon_key: 'folder', color_token: 'violet' },
    )
    db.close()
  })

  it('rolls back a mid-migration failure and recovers from unchanged v10', async (test) => {
    const path = await temporaryDbPath(test, 'presentation-rollback')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES ('project-v10', 'Existing', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT)
    downgradeToV10(fixture)
    fixture.exec("ALTER TABLE projects ADD COLUMN color_token TEXT DEFAULT 'rogue'")
    fixture.close()

    assert.throws(() => openDb(path), /Миграция 11 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 10)
    const columns = repair.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
    assert.equal(columns.some((column) => column.name === 'icon_key'), false)
    assert.equal(columns.some((column) => column.name === 'color_token'), true)
    assert.equal(count(repair, 'projects'), 1)
    repair.exec('ALTER TABLE projects DROP COLUMN color_token')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 14)
    assert.deepEqual(
      { ...recovered.prepare('SELECT icon_key, color_token FROM projects WHERE id = ?').get('project-v10') },
      { icon_key: 'folder', color_token: 'slate' },
    )
    assert.equal(count(recovered, 'projects'), 1)
    recovered.close()
  })
})
