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
import type { Workspace } from '@alamo/contract'
import type { Db } from './db.ts'

interface WorkspaceRow {
  id: string
  name: string
  root_path: string
  created_at: string
  last_used_at: string | null
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
    if (existing) return toWorkspace(existing)

    const id = randomUUID()
    this.db
      .prepare('INSERT INTO workspaces (id, name, root_path, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)')
      .run(id, name ?? basename(absolute), absolute, new Date().toISOString())

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
}
