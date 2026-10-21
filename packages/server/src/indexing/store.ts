import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync } from 'node:fs'
import type { TreeSnapshot, SymbolEntry } from './types.ts'
import type { AllowContent } from './snapshot.ts'
import { PARSER_VERSION } from './parser.ts'

export interface CachedMap { entries: SymbolEntry[]; source: 'tree-sitter' | 'markdown' | 'file' }
export interface RootRow { commit_id: string | null; indexed_at: string; fingerprint: string }
/** Independent, disposable schema; never claims a shared node migration number. */
export class IndexStore {
  readonly db: DatabaseSync
  constructor(path: string, writable = false) {
    if (!writable && !existsSync(path)) throw new Error('index_not_built')
    this.db = new DatabaseSync(path, { readOnly: !writable })
    this.db.exec('PRAGMA busy_timeout = 250')
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > 1) { this.db.close(); throw new Error('index_schema_unsupported') }
    if (!writable) {
      if (version !== 1) { this.db.close(); throw new Error('index_not_built') }
      try {
        this.db.prepare('SELECT root_key, commit_id, indexed_at, fingerprint FROM roots LIMIT 0').all()
        this.db.prepare('SELECT root_key, path, hash FROM files LIMIT 0').all()
        this.db.prepare('SELECT hash, language, parser, symbols, source FROM maps LIMIT 0').all()
      } catch { this.db.close(); throw new Error('index_not_built') }
    }
    if (writable) {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 1000;')
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE contents (hash TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT;
        CREATE TABLE maps (hash TEXT NOT NULL REFERENCES contents(hash) ON DELETE CASCADE, language TEXT NOT NULL, parser TEXT NOT NULL, symbols TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(hash, language, parser)) STRICT;
        CREATE TABLE roots (root_key TEXT PRIMARY KEY, commit_id TEXT, indexed_at TEXT NOT NULL, fingerprint TEXT NOT NULL) STRICT;
        CREATE TABLE files (root_key TEXT NOT NULL REFERENCES roots(root_key) ON DELETE CASCADE, path TEXT NOT NULL, hash TEXT NOT NULL REFERENCES contents(hash), PRIMARY KEY(root_key, path)) STRICT;
        CREATE VIRTUAL TABLE fulltext USING fts5(hash UNINDEXED, text, tokenize='trigram case_sensitive 1');
        PRAGMA user_version = 1; COMMIT;`)
    } else this.db.exec('PRAGMA query_only = ON')
  }
  root(key: string): RootRow | undefined { return this.db.prepare('SELECT commit_id, indexed_at, fingerprint FROM roots WHERE root_key = ?').get(key) as unknown as RootRow | undefined }
  map(hash: string, language: string): CachedMap | undefined {
    const row = this.db.prepare('SELECT symbols, source FROM maps WHERE hash = ? AND language = ? AND parser = ?').get(hash, language, PARSER_VERSION) as { symbols: string; source: CachedMap['source'] } | undefined
    return row && { entries: JSON.parse(row.symbols), source: row.source }
  }
  put(hash: string, text: string, language: string, map: CachedMap, fts: boolean) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR IGNORE INTO contents(hash, text) VALUES (?, ?)').run(hash, text)
      this.db.prepare('INSERT OR REPLACE INTO maps(hash, language, parser, symbols, source) VALUES (?, ?, ?, ?, ?)').run(hash, language, PARSER_VERSION, JSON.stringify(map.entries), map.source)
      if (fts && !this.db.prepare('SELECT 1 FROM fulltext WHERE hash = ?').get(hash)) this.db.prepare('INSERT INTO fulltext(hash, text) VALUES (?, ?)').run(hash, text)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  async purgeUnsafe(allow: AllowContent): Promise<void> {
    for (const row of this.db.prepare('SELECT root_key, path FROM files').all() as { root_key: string; path: string }[]) {
      if (!(await allow(row.path))) this.db.prepare('DELETE FROM files WHERE root_key = ? AND path = ?').run(row.root_key, row.path)
    }
    for (const row of this.db.prepare('SELECT hash, text FROM contents').all() as { hash: string; text: string }[]) {
      if (await allow(row.text)) continue
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare('DELETE FROM files WHERE hash = ?').run(row.hash)
        this.db.prepare('DELETE FROM fulltext WHERE hash = ?').run(row.hash)
        this.db.prepare('DELETE FROM contents WHERE hash = ?').run(row.hash)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }
  publish(tree: TreeSnapshot, crash?: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR REPLACE INTO roots(root_key, commit_id, indexed_at, fingerprint) VALUES (?, ?, ?, ?)').run(tree.rootKey, tree.commit, tree.observedAt, tree.fingerprint)
      this.db.prepare('DELETE FROM files WHERE root_key = ?').run(tree.rootKey)
      const insert = this.db.prepare('INSERT INTO files(root_key, path, hash) VALUES (?, ?, ?)')
      tree.files.forEach(f => insert.run(tree.rootKey, f.path, f.hash))
      crash?.()
      this.db.exec('DELETE FROM fulltext WHERE hash NOT IN (SELECT hash FROM files); DELETE FROM contents WHERE hash NOT IN (SELECT hash FROM files);')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  indexed(key: string): Map<string, string> { return new Map((this.db.prepare('SELECT path, hash FROM files WHERE root_key = ?').all(key) as { path: string; hash: string }[]).map(r => [r.path, r.hash])) }
  fts(text: string): Set<string> {
    return new Set((this.db.prepare('SELECT hash FROM fulltext WHERE fulltext MATCH ?').all(`"${text.replaceAll('"', '""')}"`) as { hash: string }[]).map(r => r.hash))
  }
  hasFts(hash: string): boolean { return !!this.db.prepare('SELECT 1 FROM fulltext WHERE hash = ?').get(hash) }
  close() { this.db.close() }
}
