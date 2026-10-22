/**
 * Per-account/per-project glossary storage with an append-only revision chain.
 *
 * The sidecar database is separate from the legacy store and owns its own `v1_migrations` table.
 * Version 1 is frozen: never rewrite it once a user database may have applied it.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  compileGlossary,
  type GlossaryEntry,
} from './glossary.ts'

export type GlossaryScope = 'account' | 'project'
export type GlossaryRevisionSource = 'user' | 'import' | 'candidate'
export type GlossaryRevisionOp = 'create' | 'update' | 'deactivate' | 'reactivate' | 'revert'

export interface StoredGlossaryEntry {
  id: string
  accountId: string
  scope: GlossaryScope
  projectId: string | null
  entry: GlossaryEntry
  active: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

export interface GlossaryRevision {
  entryId: string
  revision: number
  op: GlossaryRevisionOp
  entry: GlossaryEntry | null
  source: GlossaryRevisionSource
  createdAt: number
}

export interface GlossaryMutation {
  accountId: string
  scope: GlossaryScope
  projectId: string | null
}

export interface GlossaryListOptions {
  /** Restrict project-scope rows to this project; account-scope rows are always included. */
  projectId?: string | null
  includeInactive?: boolean
}

export type GlossaryStoreErrorCode =
  | 'account_mismatch'
  | 'already_active'
  | 'already_inactive'
  | 'entry_exists'
  | 'entry_inactive'
  | 'entry_not_found'
  | 'id_mismatch'
  | 'invalid_clock'
  | 'invalid_scope'
  | 'invalid_source'
  | 'project_required'
  | 'store_closed'

/** Typed store failure; account isolation is reported separately from a missing entry. */
export class GlossaryStoreError extends Error {
  readonly code: GlossaryStoreErrorCode
  constructor(code: GlossaryStoreErrorCode, message: string) {
    super(message)
    this.name = 'GlossaryStoreError'
    this.code = code
  }
}

interface EntryRow {
  id: string
  account_id: string
  scope: string
  project_id: string | null
  entry: string
  active: number
  revision: number
  created_at: number
  updated_at: number
}

interface RevisionRow {
  entry_id: string
  revision: number
  op: string
  entry: string | null
  source: string
  created_at: number
}

/** Version 1. Append-only; later versions may add tables, not edit these bytes. */
const MIGRATION_V1 = `
  CREATE TABLE glossary_entries(
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('account','project')),
    project_id TEXT,
    entry TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((scope='project') = (project_id IS NOT NULL))
  );
  CREATE TABLE glossary_revisions(
    entry_id TEXT NOT NULL REFERENCES glossary_entries(id),
    revision INTEGER NOT NULL,
    op TEXT NOT NULL CHECK(op IN ('create','update','deactivate','reactivate','revert')),
    entry TEXT,
    source TEXT NOT NULL CHECK(source IN ('user','import','candidate')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(entry_id, revision)
  );
  CREATE INDEX glossary_entries_scope
    ON glossary_entries(account_id, scope, project_id, active);
  INSERT INTO v1_migrations VALUES(1);`

const SOURCES: ReadonlySet<string> = new Set(['user', 'import', 'candidate'])

/** Canonical equality used by the project-over-account override rule. */
export function canonicalEntryKey(entry: GlossaryEntry): string {
  return entry.canonical.trim().normalize('NFC').toLowerCase()
}

function parseEntry(value: string): GlossaryEntry {
  return JSON.parse(value) as GlossaryEntry
}

function normalizeEntry(entry: GlossaryEntry): GlossaryEntry {
  const compiled = compileGlossary([entry])
  const normalized = compiled.entries[0]
  if (normalized === undefined) {
    throw new TypeError('Glossary entry could not be compiled')
  }
  return {
    id: normalized.id,
    canonical: normalized.canonical,
    variants: [...normalized.variants],
    language: normalized.language,
    caseSensitive: normalized.caseSensitive,
    inflect: normalized.inflect,
  }
}

function toStored(row: EntryRow): StoredGlossaryEntry {
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope === 'project' ? 'project' : 'account',
    projectId: row.project_id,
    entry: parseEntry(row.entry),
    active: row.active === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRevision(row: RevisionRow): GlossaryRevision {
  return {
    entryId: row.entry_id,
    revision: row.revision,
    op: row.op as GlossaryRevisionOp,
    entry: row.entry === null ? null : parseEntry(row.entry),
    source: row.source as GlossaryRevisionSource,
    createdAt: row.created_at,
  }
}

/**
 * A separate SQLite file for voice glossaries. Mutations are synchronous and serialised by
 * SQLite; every successful mutation appends exactly one revision row in the same transaction.
 */
export class GlossaryStore {
  readonly db: DatabaseSync
  private readonly clock: () => number
  private readonly listeners = new Set<(event: GlossaryMutation) => void>()
  private closed = false

  constructor(path: string, clock: () => number = Date.now) {
    this.clock = clock
    const memory = path === ':memory:'
    if (!memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (!memory) chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS v1_migrations(version INTEGER PRIMARY KEY);`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare('SELECT version FROM v1_migrations WHERE version=1').get()) {
        this.db.exec(MIGRATION_V1)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* The closing handle below is the rollback boundary. */ }
      this.db.close()
      this.closed = true
      throw error
    }
    if (!memory) {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try { chmodSync(file, 0o600) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.db.close()
  }

  /** Observe committed mutations. Listeners never run inside the SQLite transaction. */
  onChange(listener: (event: GlossaryMutation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  create(
    accountId: string,
    scope: GlossaryScope,
    projectId: string | null,
    entry: GlossaryEntry,
    source: GlossaryRevisionSource,
  ): StoredGlossaryEntry {
    this.ready()
    this.assertSource(source)
    if (scope === 'account') {
      if (projectId !== null) {
        throw new GlossaryStoreError('invalid_scope', 'Account entries cannot have a project id')
      }
    } else if (scope === 'project') {
      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new GlossaryStoreError('project_required', 'Project entries require a project id')
      }
    } else {
      throw new GlossaryStoreError('invalid_scope', `Unknown glossary scope "${String(scope)}"`)
    }

    const normalized = normalizeEntry(entry)
    const timestamp = this.now()
    const affectedProject = scope === 'project' ? projectId : null
    const stored = this.transaction(() => {
      const existing = this.db.prepare('SELECT account_id FROM glossary_entries WHERE id=?')
        .get(normalized.id) as { account_id?: string } | undefined
      if (existing !== undefined) {
        throw new GlossaryStoreError('entry_exists', `Glossary entry "${normalized.id}" already exists`)
      }
      this.db.prepare(`INSERT INTO glossary_entries
        (id,account_id,scope,project_id,entry,active,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        normalized.id,
        accountId,
        scope,
        projectId,
        JSON.stringify(normalized),
        1,
        1,
        timestamp,
        timestamp,
      )
      this.appendRevision(normalized.id, 1, 'create', normalized, source, timestamp)
      this.validateAffected(accountId, affectedProject)
      return this.requireRow(accountId, normalized.id)
    })
    this.emit({ accountId, scope, projectId: affectedProject })
    return stored
  }

  update(
    accountId: string,
    id: string,
    entry: GlossaryEntry,
    source: GlossaryRevisionSource,
  ): StoredGlossaryEntry {
    this.ready()
    this.assertSource(source)
    if (entry.id !== id) {
      throw new GlossaryStoreError('id_mismatch', `Entry id "${entry.id}" does not match "${id}"`)
    }
    const normalized = normalizeEntry(entry)
    const timestamp = this.now()
    const stored = this.transaction(() => {
      const current = this.requireRow(accountId, id)
      if (!current.active) {
        throw new GlossaryStoreError('entry_inactive', `Glossary entry "${id}" is inactive`)
      }
      const revision = current.revision + 1
      this.db.prepare('UPDATE glossary_entries SET entry=?, revision=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(normalized), revision, timestamp, id)
      this.appendRevision(id, revision, 'update', normalized, source, timestamp)
      this.validateAffected(accountId, current.scope === 'project' ? current.projectId : null)
      return this.requireRow(accountId, id)
    })
    this.emit({
      accountId,
      scope: stored.scope,
      projectId: stored.scope === 'project' ? stored.projectId : null,
    })
    return stored
  }

  deactivate(accountId: string, id: string): StoredGlossaryEntry {
    this.ready()
    const timestamp = this.now()
    const stored = this.transaction(() => {
      const current = this.requireRow(accountId, id)
      if (!current.active) {
        throw new GlossaryStoreError('already_inactive', `Glossary entry "${id}" is already inactive`)
      }
      const revision = current.revision + 1
      this.db.prepare('UPDATE glossary_entries SET active=0, revision=?, updated_at=? WHERE id=?')
        .run(revision, timestamp, id)
      this.appendRevision(id, revision, 'deactivate', current.entry, 'user', timestamp)
      this.validateAffected(accountId, current.scope === 'project' ? current.projectId : null)
      return this.requireRow(accountId, id)
    })
    this.emit({
      accountId,
      scope: stored.scope,
      projectId: stored.scope === 'project' ? stored.projectId : null,
    })
    return stored
  }

  reactivate(accountId: string, id: string): StoredGlossaryEntry {
    this.ready()
    const timestamp = this.now()
    const stored = this.transaction(() => {
      const current = this.requireRow(accountId, id)
      if (current.active) {
        throw new GlossaryStoreError('already_active', `Glossary entry "${id}" is already active`)
      }
      const revision = current.revision + 1
      this.db.prepare('UPDATE glossary_entries SET active=1, revision=?, updated_at=? WHERE id=?')
        .run(revision, timestamp, id)
      this.appendRevision(id, revision, 'reactivate', current.entry, 'user', timestamp)
      this.validateAffected(accountId, current.scope === 'project' ? current.projectId : null)
      return this.requireRow(accountId, id)
    })
    this.emit({
      accountId,
      scope: stored.scope,
      projectId: stored.scope === 'project' ? stored.projectId : null,
    })
    return stored
  }

  /**
   * One-click revert to the previous revision's entry. Reverting a `create` deactivates the
   * entry; reverting a `deactivate` restores the previous active state.
   */
  revert(accountId: string, id: string): StoredGlossaryEntry {
    this.ready()
    const timestamp = this.now()
    const stored = this.transaction(() => {
      const current = this.requireRow(accountId, id)
      const revision = current.revision + 1
      let target: GlossaryRevision | null = null
      if (current.revision > 1) {
        const rows = this.db.prepare(
          'SELECT * FROM glossary_revisions WHERE entry_id=? AND revision<? ORDER BY revision DESC',
        ).all(id, current.revision) as unknown as RevisionRow[]
        for (const row of rows) {
          if (row.entry === null) continue
          target = toRevision(row)
          break
        }
      }

      const entry = target?.entry ?? current.entry
      const active = target !== null && target.op !== 'deactivate'
      this.db.prepare(
        'UPDATE glossary_entries SET entry=?, active=?, revision=?, updated_at=? WHERE id=?',
      ).run(JSON.stringify(entry), active ? 1 : 0, revision, timestamp, id)
      this.appendRevision(id, revision, 'revert', entry, 'user', timestamp)
      this.validateAffected(accountId, current.scope === 'project' ? current.projectId : null)
      return this.requireRow(accountId, id)
    })
    this.emit({
      accountId,
      scope: stored.scope,
      projectId: stored.scope === 'project' ? stored.projectId : null,
    })
    return stored
  }

  history(accountId: string, id: string): GlossaryRevision[] {
    this.ready()
    this.requireRow(accountId, id)
    const rows = this.db.prepare(
      'SELECT * FROM glossary_revisions WHERE entry_id=? ORDER BY revision ASC',
    ).all(id) as unknown as RevisionRow[]
    return rows.map(toRevision)
  }

  list(accountId: string, options: GlossaryListOptions = {}): StoredGlossaryEntry[] {
    this.ready()
    let sql = 'SELECT * FROM glossary_entries WHERE account_id=?'
    const parameters: Array<string | number> = [accountId]
    if (options.projectId !== undefined && options.projectId !== null) {
      sql += " AND (scope='account' OR (scope='project' AND project_id=?))"
      parameters.push(options.projectId)
    }
    if (options.includeInactive !== true) sql += ' AND active=1'
    sql += " ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END, created_at, id"
    const rows = this.db.prepare(sql).all(...parameters) as unknown as EntryRow[]
    return rows.map(toStored)
  }

  private ready(): void {
    if (this.closed) throw new GlossaryStoreError('store_closed', 'Glossary store is closed')
  }

  private now(): number {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GlossaryStoreError('invalid_clock', 'Glossary clock must return a non-negative integer')
    }
    return value
  }

  private assertSource(source: GlossaryRevisionSource): void {
    if (!SOURCES.has(source)) {
      throw new GlossaryStoreError('invalid_source', `Unknown glossary revision source "${String(source)}"`)
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
  }

  private appendRevision(
    entryId: string,
    revision: number,
    op: GlossaryRevisionOp,
    entry: GlossaryEntry,
    source: GlossaryRevisionSource,
    timestamp: number,
  ): void {
    this.db.prepare(`INSERT INTO glossary_revisions
      (entry_id,revision,op,entry,source,created_at) VALUES(?,?,?,?,?,?)`).run(
      entryId,
      revision,
      op,
      JSON.stringify(entry),
      source,
      timestamp,
    )
  }

  private requireRow(accountId: string, id: string): StoredGlossaryEntry {
    const row = this.db.prepare('SELECT * FROM glossary_entries WHERE id=?')
      .get(id) as unknown as EntryRow | undefined
    if (row === undefined) {
      throw new GlossaryStoreError('entry_not_found', `Glossary entry "${id}" not found`)
    }
    if (row.account_id !== accountId) {
      throw new GlossaryStoreError(
        'account_mismatch',
        `Glossary entry "${id}" does not belong to account "${accountId}"`,
      )
    }
    return toStored(row)
  }

  private projectIds(accountId: string): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT project_id FROM glossary_entries WHERE account_id=? AND scope='project'",
    ).all(accountId) as unknown as Array<{ project_id: string }>
    return rows.map((row) => row.project_id)
  }

  /**
   * Validate every effective set a mutation could have changed. Account-scope mutations affect
   * all known projects; project-scope mutations affect only their project.
   */
  private validateAffected(accountId: string, projectId: string | null): void {
    this.compileEffective(accountId, null)
    const projects = projectId === null ? this.projectIds(accountId) : [projectId]
    for (const project of projects) this.compileEffective(accountId, project)
  }

  /** Compile active account entries plus active project entries with the override applied. */
  private compileEffective(accountId: string, projectId: string | null): void {
    const rows = projectId === null
      ? this.list(accountId, { includeInactive: false }).filter((row) => row.scope === 'account')
      : this.list(accountId, { projectId, includeInactive: false })
    const projectRows = projectId === null
      ? []
      : rows.filter((row) => row.scope === 'project' && row.projectId === projectId)
    const accountRows = rows.filter((row) => row.scope === 'account')
    const overridden = new Set(projectRows.map((row) => canonicalEntryKey(row.entry)))
    const entries = [
      ...projectRows.map((row) => row.entry),
      ...accountRows.filter((row) => !overridden.has(canonicalEntryKey(row.entry)))
        .map((row) => row.entry),
    ]
    compileGlossary(entries)
  }

  private emit(event: GlossaryMutation): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* A listener must not fail a committed mutation. */ }
    }
  }
}
