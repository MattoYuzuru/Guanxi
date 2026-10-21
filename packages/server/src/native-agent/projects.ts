import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { z } from 'zod'
import type { NativeHost } from './service.ts'

/** K4-owned sidecar: does not claim a shared node migration number while R1 runs. */
export class NativeProjectRoots {
  private db: DatabaseSync
  private host: NativeHost
  constructor(path: string, host: NativeHost) {
    this.host = host
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > 1) { this.db.close(); throw new Error('native_projects_schema_unsupported') }
    if (version === 0) {
      try {
        this.db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS project_roots (project_id TEXT PRIMARY KEY, workspace_ids TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; PRAGMA user_version = 1; COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    }
  }
  list() {
    return this.host.projects.list().map(project => {
      const row = this.db.prepare('SELECT workspace_ids, updated_at FROM project_roots WHERE project_id = ?').get(project.id) as { workspace_ids: string; updated_at: string } | undefined
      if (!row) return project
      const ids = z.array(z.string()).parse(JSON.parse(row.workspace_ids))
      return { ...project, filesystemBindings: ids.map(id => ({ id: `native:${id}`, workspaceId: id, createdAt: row.updated_at })) }
    })
  }
  get(id: string) { return this.list().find(p => p.id === id) ?? null }
  set(id: string, ids: string[]) {
    if (!this.host.projects.get(id)) throw new Error('project_not_found')
    if (ids.some(id => !this.host.workspaces.get(id))) throw new Error('workspace_not_found')
    this.db.prepare('INSERT INTO project_roots (project_id, workspace_ids, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET workspace_ids = excluded.workspace_ids, updated_at = excluded.updated_at')
      .run(id, JSON.stringify([...new Set(ids)]), new Date().toISOString())
    return this.get(id)!
  }
  close() { this.db.close() }
}
