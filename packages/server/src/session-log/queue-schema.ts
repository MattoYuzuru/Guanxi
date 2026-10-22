/**
 * Independent session-queue ledger (migration 40, K4 queue v3).
 *
 * Main migrations 1–33 and independent ledgers 34–39 belong to other owners.
 * This file owns one additive component ledger in the same database:
 *
 * - `session_queue_migrations` records the one version this component applied;
 * - migration 40 replaces only `session_events_policy_insert`, preserving the
 *   v1/v2/reasoning conditions verbatim and adding the strict v3 queue shape.
 *
 * The installer runs in `SessionLog` construction, after `openDb` has applied
 * global 33. It takes `BEGIN IMMEDIATE`, re-reads the component ledger and the
 * trigger shape, rejects unknown/future versions or incompatible shapes, and
 * commits the trigger change together with the ledger row. Competing
 * initializers therefore observe the committed version instead of applying
 * DDL twice. DDL errors are not swallowed; the transaction rolls back.
 */
import type { Db } from '../store/db.ts'

export const SESSION_QUEUE_MIGRATION_VERSION = 40
export const SESSION_QUEUE_MIGRATIONS_TABLE = 'session_queue_migrations'
const POLICY_TRIGGER = 'session_events_policy_insert'
/** The global schema version this component expects (`openDb` applies 1–33). */
const REQUIRED_GLOBAL_VERSION = 33

export type SessionQueueSchemaErrorCode =
  | 'queue_schema_incompatible'
  | 'queue_schema_future'
  | 'queue_schema_failed'

export class SessionQueueSchemaError extends Error {
  readonly code: SessionQueueSchemaErrorCode

  constructor(code: SessionQueueSchemaErrorCode, message: string) {
    super(message)
    this.name = 'SessionQueueSchemaError'
    this.code = code
  }
}

/** The exact trigger created by global migration 33; the installer may replace only this shape. */
export const V33_POLICY_TRIGGER_SQL = `
  CREATE TRIGGER session_events_policy_insert
    BEFORE INSERT ON session_events
    WHEN NEW.event_version NOT IN (1,2)
      OR NEW.payload IS NULL
      OR NEW.purged_at IS NOT NULL
      OR (NEW.class = 'reasoning') <> (NEW.type = 'reasoning')
      OR (NEW.class = 'reasoning') <> (NEW.expires_at IS NOT NULL)
      OR (NEW.event_version = 2 AND (
        NEW.type NOT IN ('prompt','tool.call')
        OR json_type(NEW.payload, '$.artifact') IS NOT 'object'
        OR json_type(NEW.payload, '$.text') IS NOT NULL
        OR json_type(NEW.payload, '$.arguments') IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM session_input_artifacts artifact
          WHERE artifact.session_id = NEW.session_id
            AND artifact.artifact_id = json_extract(NEW.payload, '$.artifact.artifactId')
            AND artifact.checksum = json_extract(NEW.payload, '$.artifact.checksum')
            AND artifact.byte_size = json_extract(NEW.payload, '$.artifact.byteSize')
            AND artifact.media_type = json_extract(NEW.payload, '$.artifact.mediaType')
        )
      ))
    BEGIN
      SELECT RAISE(ABORT, 'A session event must carry its payload and match the event policy');
    END;
`

/**
 * Migration 40's trigger. The v1/v2/reasoning clauses are the migration-33
 * clauses verbatim; only the accepted version set and the v3 queue branch are
 * added. SQLite's `json_each` checks every queue item, and the metadata
 * subquery is the database backstop against a foreign or mismatched reference.
 */
export const SESSION_QUEUE_POLICY_TRIGGER_SQL = `
  CREATE TRIGGER session_events_policy_insert
    BEFORE INSERT ON session_events
    WHEN NEW.event_version NOT IN (1,2,3)
      OR NEW.payload IS NULL
      OR NEW.purged_at IS NOT NULL
      OR (NEW.class = 'reasoning') <> (NEW.type = 'reasoning')
      OR (NEW.class = 'reasoning') <> (NEW.expires_at IS NOT NULL)
      OR (NEW.event_version = 2 AND (
        NEW.type NOT IN ('prompt','tool.call')
        OR json_type(NEW.payload, '$.artifact') IS NOT 'object'
        OR json_type(NEW.payload, '$.text') IS NOT NULL
        OR json_type(NEW.payload, '$.arguments') IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM session_input_artifacts artifact
          WHERE artifact.session_id = NEW.session_id
            AND artifact.artifact_id = json_extract(NEW.payload, '$.artifact.artifactId')
            AND artifact.checksum = json_extract(NEW.payload, '$.artifact.checksum')
            AND artifact.byte_size = json_extract(NEW.payload, '$.artifact.byteSize')
            AND artifact.media_type = json_extract(NEW.payload, '$.artifact.mediaType')
        )
      ))
      OR (NEW.event_version = 3 AND (
        NEW.type IS NOT 'agent.queue'
        OR NEW.class IS NOT 'standard'
        OR NEW.expires_at IS NOT NULL
        OR json_type(NEW.payload, '$.items') IS NOT 'array'
        OR EXISTS (
          SELECT 1 FROM json_each(NEW.payload, '$.items') item
          WHERE json_type(item.value) IS NOT 'object'
            OR json_type(item.value, '$.id') IS NOT 'text'
            OR json_type(item.value, '$.kind') IS NOT 'text'
            OR json_extract(item.value, '$.kind') NOT IN ('inline','artifact')
            OR (json_extract(item.value, '$.kind') = 'inline' AND (
              json_type(item.value, '$.text') IS NOT 'text'
              OR length(CAST(json_extract(item.value, '$.text') AS BLOB)) > 16384
              OR json_type(item.value, '$.artifact') IS NOT NULL
              OR json_type(item.value, '$.input') IS NOT NULL
            ))
            OR (json_extract(item.value, '$.kind') = 'artifact' AND (
              json_type(item.value, '$.text') IS NOT NULL
              OR json_type(item.value, '$.input') IS NOT NULL
              OR json_type(item.value, '$.artifact') IS NOT 'object'
              OR json_type(item.value, '$.artifact.artifactId') IS NOT 'text'
              OR json_type(item.value, '$.artifact.checksum') IS NOT 'text'
              OR json_type(item.value, '$.artifact.byteSize') IS NOT 'integer'
              OR json_type(item.value, '$.artifact.mediaType') IS NOT 'text'
              OR json_type(item.value, '$.artifact.excerpt') IS NOT 'text'
              OR json_type(item.value, '$.artifact.excerptBytes') IS NOT 'integer'
              OR length(CAST(json_extract(item.value, '$.artifact.artifactId') AS BLOB)) NOT BETWEEN 1 AND 200
              OR length(CAST(json_extract(item.value, '$.artifact.checksum') AS BLOB)) <> 71
              OR substr(json_extract(item.value, '$.artifact.checksum'), 1, 7) <> 'sha256:'
              OR substr(json_extract(item.value, '$.artifact.checksum'), 8) GLOB '*[^0-9a-f]*'
              OR json_extract(item.value, '$.artifact.byteSize') <= 16384
              OR json_extract(item.value, '$.artifact.byteSize') > 9007199254740991
              OR json_extract(item.value, '$.artifact.mediaType') IS NOT 'text/plain; charset=utf-8'
              OR json_extract(item.value, '$.artifact.excerptBytes') < 0
              OR json_extract(item.value, '$.artifact.excerptBytes') > 8192
              OR length(CAST(json_extract(item.value, '$.artifact.excerpt') AS BLOB))
                 <> json_extract(item.value, '$.artifact.excerptBytes')
              OR NOT EXISTS (
                SELECT 1 FROM session_input_artifacts artifact
                WHERE artifact.session_id = NEW.session_id
                  AND artifact.artifact_id = json_extract(item.value, '$.artifact.artifactId')
                  AND artifact.checksum = json_extract(item.value, '$.artifact.checksum')
                  AND artifact.byte_size = json_extract(item.value, '$.artifact.byteSize')
                  AND artifact.media_type = json_extract(item.value, '$.artifact.mediaType')
              )
            ))
        )
        OR (SELECT COUNT(*) FROM json_each(NEW.payload, '$.items'))
           <> (SELECT COUNT(DISTINCT json_extract(value, '$.id'))
               FROM json_each(NEW.payload, '$.items'))
      ))
    BEGIN
      SELECT RAISE(ABORT, 'A session event must carry its payload and match the event policy');
    END;
`

/** Pretty-printed migration text for evidence; the installer executes the same statements. */
export const SESSION_QUEUE_MIGRATION = `
  DROP TRIGGER IF EXISTS session_events_policy_insert;
${SESSION_QUEUE_POLICY_TRIGGER_SQL}
`

export type SessionQueueSchemaPoint = 'before_install' | 'after_trigger' | 'after_ledger'

export interface SessionQueueSchemaOptions {
  /** Test seam: throwing at a point must roll the whole component change back. */
  fault?: (point: SessionQueueSchemaPoint) => void
}

function normalizeSql(sql: string | undefined): string {
  return (sql ?? '').replace(/\s+/gu, ' ').trim().replace(/;$/u, '')
}

function userVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function triggerSql(db: Db, name: string): string | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as
    | { sql: string | null }
    | undefined
  return row?.sql ?? undefined
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name)
}

function assertLedgerShape(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(${SESSION_QUEUE_MIGRATIONS_TABLE})`).all() as unknown as {
    name: string
    type: string
    pk: number
  }[]
  if (
    columns.length !== 1
    || columns[0]!.name !== 'version'
    || !/^INTEGER$/iu.test(columns[0]!.type)
    || columns[0]!.pk !== 1
  ) {
    throw new SessionQueueSchemaError(
      'queue_schema_incompatible',
      'The session queue ledger has an incompatible shape',
    )
  }
}

function ledgerVersions(db: Db): number[] {
  return (db.prepare(`SELECT version FROM ${SESSION_QUEUE_MIGRATIONS_TABLE} ORDER BY version`).all() as unknown as {
    version: number
  }[]).map((row) => Number(row.version))
}

function assertGlobalPrerequisites(db: Db): void {
  if (userVersion(db) < REQUIRED_GLOBAL_VERSION) {
    throw new SessionQueueSchemaError(
      'queue_schema_incompatible',
      'The session queue ledger requires the global schema through migration 33',
    )
  }
  if (!tableExists(db, 'session_events') || triggerSql(db, POLICY_TRIGGER) === undefined) {
    throw new SessionQueueSchemaError(
      'queue_schema_incompatible',
      'The session event table or policy trigger is missing',
    )
  }
  const eventColumns = columnNames(db, 'session_events')
  for (const required of [
    'session_id', 'seq', 'id', 'event_version', 'type', 'class', 'writer_epoch',
    'payload', 'payload_sha256', 'search_text', 'redactions', 'created_at',
    'expires_at', 'purged_at',
  ]) {
    if (!eventColumns.includes(required)) {
      throw new SessionQueueSchemaError(
        'queue_schema_incompatible',
        'The session event table has an incompatible shape',
      )
    }
  }
  const artifactColumns = columnNames(db, 'session_input_artifacts')
  for (const required of ['artifact_id', 'session_id', 'checksum', 'byte_size', 'media_type', 'created_at']) {
    if (!artifactColumns.includes(required)) {
      throw new SessionQueueSchemaError(
        'queue_schema_incompatible',
        'The session input artifact table has an incompatible shape',
      )
    }
  }
}

/**
 * Installs migration 40 exactly once. It may run after global 33 and before the
 * log provides its service; it never runs inside the caller's transaction.
 */
export function installSessionQueueSchema(db: Db, options: SessionQueueSchemaOptions = {}): void {
  if ((db as unknown as { isTransaction?: boolean }).isTransaction === true) {
    throw new SessionQueueSchemaError(
      'queue_schema_incompatible',
      'The session queue ledger cannot be installed inside an open transaction',
    )
  }
  if (userVersion(db) < REQUIRED_GLOBAL_VERSION) {
    throw new SessionQueueSchemaError(
      'queue_schema_incompatible',
      'The session queue ledger requires the global schema through migration 33',
    )
  }
  let began = false
  try {
    db.exec('BEGIN IMMEDIATE')
    began = true

    const hasLedger = tableExists(db, SESSION_QUEUE_MIGRATIONS_TABLE)
    if (hasLedger) assertLedgerShape(db)
    const versions = hasLedger ? ledgerVersions(db) : []
    const currentTrigger = triggerSql(db, POLICY_TRIGGER)

    if (versions.some((version) => version > SESSION_QUEUE_MIGRATION_VERSION)) {
      throw new SessionQueueSchemaError(
        'queue_schema_future',
        'The session queue schema is newer than this node understands',
      )
    }
    if (versions.length > 0) {
      if (versions.length !== 1 || versions[0] !== SESSION_QUEUE_MIGRATION_VERSION) {
        throw new SessionQueueSchemaError(
          'queue_schema_incompatible',
          'The session queue ledger names an unknown version',
        )
      }
      if (normalizeSql(currentTrigger) !== normalizeSql(SESSION_QUEUE_POLICY_TRIGGER_SQL)) {
        throw new SessionQueueSchemaError(
          'queue_schema_incompatible',
          'The session queue ledger does not match the installed policy trigger',
        )
      }
      assertGlobalPrerequisites(db)
      db.exec('COMMIT')
      began = false
      return
    }

    // Empty/absent ledger: only the exact post-33 trigger may be replaced. A
    // ledger-less v40 trigger is a partial state, not something to adopt.
    if (normalizeSql(currentTrigger) === normalizeSql(SESSION_QUEUE_POLICY_TRIGGER_SQL)) {
      throw new SessionQueueSchemaError(
        'queue_schema_incompatible',
        'The session queue policy trigger exists without its ledger row',
      )
    }
    if (normalizeSql(currentTrigger) !== normalizeSql(V33_POLICY_TRIGGER_SQL)) {
      throw new SessionQueueSchemaError(
        'queue_schema_incompatible',
        'The session event policy trigger has an incompatible shape',
      )
    }
    assertGlobalPrerequisites(db)

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SESSION_QUEUE_MIGRATIONS_TABLE} (
        version INTEGER PRIMARY KEY CHECK (version >= 1)
      );
    `)
    assertLedgerShape(db)
    options.fault?.('before_install')

    db.exec(SESSION_QUEUE_MIGRATION)
    options.fault?.('after_trigger')

    db.prepare(`INSERT INTO ${SESSION_QUEUE_MIGRATIONS_TABLE} (version) VALUES (?)`)
      .run(SESSION_QUEUE_MIGRATION_VERSION)
    options.fault?.('after_ledger')

    db.exec('COMMIT')
    began = false
  } catch (error) {
    if (began) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // SQLite may already have ended the transaction; the original error stands.
      }
    }
    throw error
  }
}
