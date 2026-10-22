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
  if (versions[0]?.version !== 1 || versions.some((row, i) => row.version !== i + 1) || versions.length > 2) throw new Error('Unsupported layout storage version')
}

/** Additive replication metadata. Called after F1 exists, including when a local
 * LayoutStore initialized the v1 tables before federation was enabled. */
export function initializeLayoutReplicationSchema(db: Db): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!db.prepare('SELECT 1 FROM layout_migrations WHERE version=2').get()) {
      db.exec(`CREATE TABLE layout_activation_clock (
        scope_key TEXT PRIMARY KEY, wall INTEGER NOT NULL, logical INTEGER NOT NULL,
        origin TEXT NOT NULL, counter INTEGER NOT NULL
      );
      INSERT INTO layout_activation_clock
      SELECT scope_key, wall, logical, origin, counter FROM (
        SELECT *, row_number() OVER (PARTITION BY scope_key ORDER BY wall DESC, logical DESC, origin DESC, counter DESC) AS rank
        FROM (
          SELECT json_array(
            json_extract(data,'$.operation.value.document.scope.account'),
            json_extract(data,'$.operation.value.document.scope.project'),
            json_extract(data,'$.operation.value.document.scope.mode'),
            json_extract(data,'$.operation.value.document.scope.deviceClass'),
            json_extract(data,'$.operation.value.document.scope.device')
          ) AS scope_key, json_extract(data,'$.operation.clock.wall') AS wall,
          json_extract(data,'$.operation.clock.logical') AS logical, origin, counter
          FROM federation_operations WHERE json_extract(data,'$.operation.value.kind')='layout'
          AND json_extract(data,'$.operation.value.activate')=1
        )
      ) WHERE rank=1;
      INSERT INTO layout_migrations VALUES (2);`)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
