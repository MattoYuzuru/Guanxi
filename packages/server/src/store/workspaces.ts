/**
 * Воркспейсы — зарегистрированные рабочие директории.
 *
 * Наружу воркспейс существует как `id`, а не как путь. Клиент никогда не оперирует
 * путями файловой системы: это тот инвариант, который позволит потом поднять сервер
 * на другой машине, ничего не переписывая.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Workspace } from '@guanxi/contract'
import type { Db } from './db.ts'

interface WorkspaceRow {
  id: string
  name: string
  root_path: string
  created_at: string
  last_used_at: string | null
}

function legacyProjectName(name: string): string {
  const normalized = name.trim()
  return normalized.length > 0 && normalized.length <= 120 ? normalized : 'Untitled Project'
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    exists: existsSync(row.root_path),
  }
}

export class WorkspaceStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY COALESCE(last_used_at, created_at) DESC')
      .all() as unknown as WorkspaceRow[]
    return rows.map(toWorkspace)
  }

  get(id: string): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as unknown as
      | WorkspaceRow
      | undefined
    return row ? toWorkspace(row) : null
  }

  /**
   * Регистрирует директорию. Путь нормализуется до абсолютного, повторная
   * регистрация того же пути возвращает существующую запись.
   */
  create(rootPath: string, name?: string): Workspace {
    const absolute = resolve(rootPath)

    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Не директория: ${absolute}`)
    }

    const existing = this.db
      .prepare('SELECT * FROM workspaces WHERE root_path = ?')
      .get(absolute) as unknown as WorkspaceRow | undefined
    if (existing) {
      this.ensureProjectBridge(existing)
      return toWorkspace(existing)
    }

    const id = randomUUID()
    const workspaceName = name ?? basename(absolute)
    const createdAt = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare('INSERT INTO workspaces (id, name, root_path, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)')
        .run(id, workspaceName, absolute, createdAt)
      this.insertProjectBridge({
        id,
        name: workspaceName,
        root_path: absolute,
        created_at: createdAt,
        last_used_at: null,
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return this.get(id)!
  }

  touch(id: string): void {
    this.db
      .prepare('UPDATE workspaces SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0
  }

  private ensureProjectBridge(workspace: WorkspaceRow): void {
    this.db.exec('BEGIN')
    try {
      this.insertProjectBridge(workspace)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insertProjectBridge(workspace: WorkspaceRow): void {
    const projectName = legacyProjectName(workspace.name)
    this.db
      .prepare(
        `INSERT INTO projects (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(workspace.id, projectName, workspace.created_at, workspace.created_at)
    const project = this.db
      .prepare('SELECT created_at FROM projects WHERE id = ?')
      .get(workspace.id) as { created_at: string } | undefined
    if (!project || project.created_at !== workspace.created_at) {
      throw new Error(`Conflicting Project identity for legacy Workspace ${workspace.id}`)
    }
    this.db
      .prepare(
        `INSERT INTO project_filesystem_bindings (id, project_id, workspace_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO NOTHING`,
      )
      .run(`workspace:${workspace.id}`, workspace.id, workspace.id, workspace.created_at)

    const mapping = this.db
      .prepare(
        `SELECT id, project_id FROM project_filesystem_bindings
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
}
