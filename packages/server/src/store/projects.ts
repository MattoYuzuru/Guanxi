import { randomUUID } from 'node:crypto'
import {
  PROJECT_PRESENTATION_VERSION,
  projectSchema,
  projectWithPresentationSchema,
  type Project,
  type ProjectColorToken,
  type ProjectFilesystemBinding,
  type ProjectIconKey,
  type ProjectWithPresentation,
} from '@alamo/contract'
import type { Db } from './db.ts'

interface ProjectRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  icon_key: string
  color_token: string
}

interface BindingRow {
  id: string
  project_id: string
  workspace_id: string
  created_at: string
}

function toBinding(row: BindingRow): ProjectFilesystemBinding {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
  }
}

function legacyProjectName(name: string): string {
  const normalized = name.trim()
  return normalized.length > 0 && normalized.length <= 120 ? normalized : 'Untitled Project'
}

export class ProjectStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC, id')
      .all() as unknown as ProjectRow[]
    return rows.map((row) => this.toProject(row))
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as
      | ProjectRow
      | undefined
    return row ? this.toProject(row) : null
  }

  listWithPresentation(): ProjectWithPresentation[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC, id')
      .all() as unknown as ProjectRow[]
    return rows.map((row) => this.toProjectWithPresentation(row))
  }

  getWithPresentation(id: string): ProjectWithPresentation | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as
      | ProjectRow
      | undefined
    return row ? this.toProjectWithPresentation(row) : null
  }

  create(name: string, now = new Date().toISOString()): Project {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name, now, now)
    return this.get(id)!
  }

  rename(id: string, name: string, now = new Date().toISOString()): Project | null {
    const result = this.db
      .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, now, id)
    return result.changes === 0 ? null : this.get(id)
  }

  updatePresentation(
    id: string,
    iconKey: ProjectIconKey,
    colorToken: ProjectColorToken,
    now = new Date().toISOString(),
  ): ProjectWithPresentation | null {
    const existing = this.getWithPresentation(id)
    if (!existing) return null
    if (existing.iconKey === iconKey && existing.colorToken === colorToken) return existing

    this.db
      .prepare(
        `UPDATE projects
         SET icon_key = ?, color_token = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(iconKey, colorToken, now, id)
    return this.getWithPresentation(id)
  }

  /**
   * Repairs rows written by a rolled-back legacy binary after schema migration.
   * The whole reconciliation is atomic and validates pre-existing mappings before
   * accepting them as the deterministic one-to-one compatibility bridge.
   */
  reconcileLegacyWorkspaces(): void {
    this.db.exec('BEGIN')
    try {
      const workspaces = this.db
        .prepare('SELECT id, name, created_at FROM workspaces ORDER BY id')
        .all() as Array<{ id: string; name: string; created_at: string }>
      const insertProject = this.db.prepare(
        `INSERT INTO projects (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      const insertBinding = this.db.prepare(
        `INSERT INTO project_filesystem_bindings (
           id, project_id, workspace_id, created_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO NOTHING`,
      )

      for (const workspace of workspaces) {
        const projectName = legacyProjectName(workspace.name)
        insertProject.run(workspace.id, projectName, workspace.created_at, workspace.created_at)
        const project = this.db
          .prepare('SELECT created_at FROM projects WHERE id = ?')
          .get(workspace.id) as { created_at: string } | undefined
        if (!project || project.created_at !== workspace.created_at) {
          throw new Error(`Conflicting Project identity for legacy Workspace ${workspace.id}`)
        }
        insertBinding.run(
          `workspace:${workspace.id}`,
          workspace.id,
          workspace.id,
          workspace.created_at,
        )

        const mapping = this.db
          .prepare(
            `SELECT id, project_id
             FROM project_filesystem_bindings
             WHERE workspace_id = ?`,
          )
          .get(workspace.id) as { id: string; project_id: string } | undefined
        if (
          !mapping ||
          mapping.id !== `workspace:${workspace.id}` ||
          mapping.project_id !== workspace.id
        ) {
          throw new Error(`Conflicting Project binding for legacy Workspace ${workspace.id}`)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private toProject(row: ProjectRow): Project {
    const bindings = this.db
      .prepare(
        `SELECT * FROM project_filesystem_bindings
         WHERE project_id = ?
         ORDER BY created_at, id`,
      )
      .all(row.id) as unknown as BindingRow[]
    return projectSchema.parse({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      filesystemBindings: bindings.map(toBinding),
    })
  }

  private toProjectWithPresentation(row: ProjectRow): ProjectWithPresentation {
    return projectWithPresentationSchema.parse({
      ...this.toProject(row),
      presentationVersion: PROJECT_PRESENTATION_VERSION,
      iconKey: row.icon_key,
      colorToken: row.color_token,
    })
  }
}
