/**
 * Every row of a table in a stable order, for byte-exact database snapshots.
 * Rowid tables are ordered by rowid; WITHOUT ROWID tables (for example the
 * FTS5 shadow tables of the K2 session log) by all of their columns.
 */
import type { DatabaseSync } from 'node:sqlite'

export function orderedRows(db: DatabaseSync, table: string): unknown[] {
  const listed = db.prepare('SELECT wr FROM pragma_table_list WHERE name = ?').get(table) as
    | { wr: number }
    | undefined
  if (!listed || listed.wr === 0) return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()
  const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
  const order = columns.map((_column, index) => String(index + 1)).join(', ')
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all()
}
