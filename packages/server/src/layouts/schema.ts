import type { Db } from '../store/db.ts'

/** Component-owned, append-only schema; global migrations 32–33 belong to K4. */
export const LAYOUT_SCHEMA_V1 = `CREATE TABLE layout_migrations (version INTEGER PRIMARY KEY);
INSERT INTO layout_migrations VALUES (1);
CREATE TABLE layout_documents (
    scope_key TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
    PRIMARY KEY (scope_key, id)
  );
  CREATE TABLE layout_active (
    scope_key TEXT PRIMARY KEY, layout_id TEXT NOT NULL
  );
  CREATE TABLE layout_recoveries (
    scope_key TEXT NOT NULL, layout_id TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY (scope_key, layout_id, digest)
  );
  CREATE TABLE layout_geometry (
    scope_key TEXT NOT NULL, device TEXT NOT NULL, layout_id TEXT NOT NULL, geometry TEXT NOT NULL,
    PRIMARY KEY (scope_key, device, layout_id)
  );`

export function initializeLayoutSchema(db: Db): void {
  const exists = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='layout_migrations'").get()
  if (!exists()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // Another node process may have initialized the ledger while this one waited.
      if (!exists()) db.exec(LAYOUT_SCHEMA_V1)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const versions = db.prepare('SELECT version FROM layout_migrations ORDER BY version').all() as { version: number }[]
  if (versions.length !== 1 || versions[0]?.version !== 1) throw new Error('Unsupported layout storage version')
}
