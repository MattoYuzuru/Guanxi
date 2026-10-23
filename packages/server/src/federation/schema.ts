import type { Db } from '../store/db.ts'

/** Independent ledger: leaves main user_version and K4's slots 32–33 untouched. */
export const FEDERATION_MIGRATION_34 = `
  CREATE TABLE federation_local (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
  CREATE TABLE federation_peers (id TEXT PRIMARY KEY, identity TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE federation_devices (device_hash TEXT PRIMARY KEY, user_hash TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL, expires_at INTEGER NOT NULL, next_poll INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
    state TEXT NOT NULL, identity TEXT);
  CREATE TABLE federation_nonces (node_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(node_id,nonce));
  CREATE TABLE federation_clock (id INTEGER PRIMARY KEY CHECK(id=1), wall INTEGER NOT NULL, logical INTEGER NOT NULL);
  INSERT INTO federation_clock VALUES (1,0,0);
  CREATE TABLE federation_operations (origin TEXT NOT NULL, counter INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(origin,counter));
  CREATE TABLE federation_streams (id TEXT PRIMARY KEY, binding TEXT NOT NULL);
  CREATE TABLE federation_replicas (stream_id TEXT NOT NULL REFERENCES federation_streams(id),
    seq INTEGER NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(stream_id,seq));
  CREATE TRIGGER federation_remote_session_read_only BEFORE INSERT ON sessions
  WHEN EXISTS (SELECT 1 FROM federation_streams WHERE json_extract(binding,'$.sessionId')=NEW.id
    AND json_extract(binding,'$.homeNodeId')<>(SELECT json_extract(identity,'$.id') FROM federation_local WHERE id=1))
  BEGIN SELECT RAISE(ABORT, 'replica_is_read_only'); END;
  CREATE TRIGGER federation_remote_run_read_only BEFORE INSERT ON durable_runs
  WHEN EXISTS (SELECT 1 FROM federation_streams WHERE json_extract(binding,'$.sessionId')=NEW.session_id
    AND json_extract(binding,'$.homeNodeId')<>(SELECT json_extract(identity,'$.id') FROM federation_local WHERE id=1))
  BEGIN SELECT RAISE(ABORT, 'replica_is_read_only'); END;
  CREATE TABLE federation_telemetry (node_id TEXT PRIMARY KEY REFERENCES federation_peers(id), data TEXT NOT NULL);
  CREATE TABLE federation_outbox (id TEXT PRIMARY KEY, command TEXT NOT NULL, result TEXT);
  CREATE TABLE federation_prompts (node_id TEXT NOT NULL, command_id TEXT NOT NULL, run_id TEXT NOT NULL, command TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(node_id,command_id));
  CREATE TABLE federation_command_receipts (node_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL,
    result TEXT NOT NULL, PRIMARY KEY(node_id,command_id));
`
/** F2-reap: the home's durable record of the relay pins it asked executors to make, and the executor's bounded lease per pin. */
export const FEDERATION_MIGRATION_42 = `
  CREATE TABLE federation_relay_pin_migrations (version INTEGER PRIMARY KEY);
  INSERT INTO federation_relay_pin_migrations VALUES (42);
  CREATE TABLE federation_relay_pin_journal (run_id TEXT PRIMARY KEY, executor_node_id TEXT NOT NULL, model TEXT NOT NULL,
    session_id TEXT NOT NULL, epoch INTEGER NOT NULL, journaled_at INTEGER NOT NULL);
  CREATE TABLE federation_relay_pin_leases (stream_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`
// Table-rebuilding main migrations drop attached triggers. Restore these guards on every boot.
const FEDERATION_READ_ONLY_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS federation_remote_session_read_only BEFORE INSERT ON sessions
  WHEN EXISTS (SELECT 1 FROM federation_streams WHERE json_extract(binding,'$.sessionId')=NEW.id
    AND json_extract(binding,'$.homeNodeId')<>(SELECT json_extract(identity,'$.id') FROM federation_local WHERE id=1))
  BEGIN SELECT RAISE(ABORT, 'replica_is_read_only'); END;
  CREATE TRIGGER IF NOT EXISTS federation_remote_run_read_only BEFORE INSERT ON durable_runs
  WHEN EXISTS (SELECT 1 FROM federation_streams WHERE json_extract(binding,'$.sessionId')=NEW.session_id
    AND json_extract(binding,'$.homeNodeId')<>(SELECT json_extract(identity,'$.id') FROM federation_local WHERE id=1))
  BEGIN SELECT RAISE(ABORT, 'replica_is_read_only'); END;
`
export function migrateFederation(db: Db): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS federation_migrations(version INTEGER PRIMARY KEY)')
    if (!db.prepare('SELECT 1 FROM federation_migrations WHERE version=34').get()) {
      db.exec(FEDERATION_MIGRATION_34)
      db.prepare('INSERT INTO federation_migrations VALUES (34)').run()
    }
    // Its own ledger, like the other F2 slices: `federation_migrations` keeps exactly [34].
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='federation_relay_pin_migrations'").get()) db.exec(FEDERATION_MIGRATION_42)
    db.exec(FEDERATION_READ_ONLY_TRIGGERS)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
