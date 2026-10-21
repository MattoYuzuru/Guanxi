/**
 * Migration 29 — the session event log (K2, ADR-0023). Additive: it creates new
 * tables only and never touches an earlier table.
 *
 * The database itself enforces the log's shape:
 * - an event is inserted only at `last_seq + 1` and only under the session's
 *   current unreleased writer epoch, so a fenced writer cannot append;
 * - inserting the event advances the head (trigger), and the head can move
 *   only onto an event that exists, so a gap or a duplicate cannot be
 *   committed, even by a caller that catches an error and commits anyway;
 * - events are immutable except one transition: retention purges a reasoning
 *   event's content (payload and search text become NULL, `purged_at` is set);
 * - a writer epoch only moves forward, a released epoch cannot resume, and
 *   writer rows, events and sessions disappear only with their owning Thread;
 * - `session_mirror_backlog` names Chat Jobs whose trace is still to be
 *   reconstructed from the Job store (no payload).
 *
 * CHECK constraints hold only structural facts. Policy that later stages may
 * change (event versions, which types are reasoning, what may be purged) lives
 * in triggers, which an append-only migration can drop and recreate without
 * rebuilding the table.
 *
 * The FTS5 index follows `session_events` through triggers in the same
 * statement, so an event and its index entry commit or roll back together.
 */
export const SESSION_LOG_MIGRATION = `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    kind        TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
    thread_id   TEXT UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
  );

  CREATE TRIGGER sessions_policy_insert
    BEFORE INSERT ON sessions
    WHEN NEW.kind NOT IN ('chat','agent') OR NEW.last_seq <> 0
    BEGIN
      SELECT RAISE(ABORT, 'A session starts empty with a known kind');
    END;

  CREATE TRIGGER sessions_identity_immutable
    BEFORE UPDATE OF id, kind, thread_id, created_at ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'Session identity is immutable');
    END;

  CREATE TRIGGER sessions_head_follows_events
    BEFORE UPDATE OF last_seq ON sessions
    WHEN NEW.last_seq <> OLD.last_seq + 1
      OR NOT EXISTS (
        SELECT 1 FROM session_events event
        WHERE event.session_id = NEW.id AND event.seq = NEW.last_seq
      )
    BEGIN
      SELECT RAISE(ABORT, 'A session head moves only onto its next event');
    END;

  CREATE TRIGGER sessions_delete_with_thread_only
    BEFORE DELETE ON sessions
    WHEN OLD.thread_id IS NULL
      OR EXISTS (SELECT 1 FROM threads owner WHERE owner.id = OLD.thread_id)
    BEGIN
      SELECT RAISE(ABORT, 'A session is deleted only with its Thread');
    END;

  CREATE TABLE session_writers (
    session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    writer_id   TEXT NOT NULL CHECK (length(writer_id) BETWEEN 1 AND 200),
    epoch       INTEGER NOT NULL CHECK (epoch >= 1),
    pid         INTEGER,
    host        TEXT,
    acquired_at TEXT NOT NULL,
    renewed_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    released_at TEXT
  );

  CREATE TRIGGER session_writers_epoch_monotonic
    BEFORE UPDATE ON session_writers
    WHEN NEW.epoch < OLD.epoch
      OR (NEW.epoch = OLD.epoch AND NEW.writer_id <> OLD.writer_id)
      OR (NEW.epoch > OLD.epoch + 1)
      OR (NEW.epoch = OLD.epoch AND OLD.released_at IS NOT NULL AND NEW.released_at IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'A writer change must begin the next epoch, and a released epoch cannot resume');
    END;

  CREATE TRIGGER session_writers_delete_with_session_only
    BEFORE DELETE ON session_writers
    WHEN EXISTS (SELECT 1 FROM sessions owner WHERE owner.id = OLD.session_id)
    BEGIN
      SELECT RAISE(ABORT, 'A writer row is deleted only with its session');
    END;

  CREATE TABLE session_events (
    row_id          INTEGER PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL CHECK (seq >= 1),
    id              TEXT NOT NULL UNIQUE,
    event_version   INTEGER NOT NULL CHECK (event_version >= 1),
    type            TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
    class           TEXT NOT NULL CHECK (class IN ('standard','reasoning')),
    span_id         TEXT,
    parent_span_id  TEXT,
    job_id          TEXT,
    job_sequence    INTEGER CHECK (job_sequence IS NULL OR job_sequence >= 1),
    writer_epoch    INTEGER NOT NULL CHECK (writer_epoch >= 1),
    idempotency_key TEXT,
    payload         TEXT,
    payload_sha256  TEXT NOT NULL CHECK (
      length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    search_text     TEXT,
    redactions      INTEGER NOT NULL DEFAULT 0 CHECK (redactions >= 0),
    created_at      TEXT NOT NULL,
    expires_at      TEXT,
    purged_at       TEXT,
    UNIQUE (session_id, seq),
    UNIQUE (session_id, idempotency_key)
  );
  CREATE INDEX idx_session_events_job
    ON session_events(job_id, job_sequence) WHERE job_id IS NOT NULL;
  CREATE INDEX idx_session_events_reasoning_expiry
    ON session_events(expires_at) WHERE class = 'reasoning' AND purged_at IS NULL;

  CREATE TRIGGER session_events_placement
    BEFORE INSERT ON session_events
    WHEN NEW.seq IS NOT (SELECT head.last_seq + 1 FROM sessions head WHERE head.id = NEW.session_id)
      OR NEW.writer_epoch IS NOT (
        SELECT writer.epoch FROM session_writers writer
        WHERE writer.session_id = NEW.session_id AND writer.released_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'A session event must be appended at the next seq of the session head by its current writer');
    END;

  CREATE TRIGGER session_events_policy_insert
    BEFORE INSERT ON session_events
    WHEN NEW.event_version <> 1
      OR NEW.payload IS NULL
      OR NEW.purged_at IS NOT NULL
      OR (NEW.class = 'reasoning') <> (NEW.type = 'reasoning')
      OR (NEW.class = 'reasoning') <> (NEW.expires_at IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'A session event must carry its payload and match the event policy');
    END;

  CREATE TRIGGER session_events_advance_head
    AFTER INSERT ON session_events
    BEGIN
      UPDATE sessions SET last_seq = NEW.seq WHERE id = NEW.session_id;
    END;

  CREATE TRIGGER session_events_append_only_update
    BEFORE UPDATE ON session_events
    WHEN NOT (
      OLD.class = 'reasoning'
      AND OLD.purged_at IS NULL
      AND NEW.purged_at IS NOT NULL
      AND NEW.payload IS NULL
      AND NEW.search_text IS NULL
      AND NEW.row_id = OLD.row_id
      AND NEW.session_id = OLD.session_id
      AND NEW.seq = OLD.seq
      AND NEW.id = OLD.id
      AND NEW.event_version = OLD.event_version
      AND NEW.type = OLD.type
      AND NEW.class = OLD.class
      AND NEW.span_id IS OLD.span_id
      AND NEW.parent_span_id IS OLD.parent_span_id
      AND NEW.job_id IS OLD.job_id
      AND NEW.job_sequence IS OLD.job_sequence
      AND NEW.writer_epoch = OLD.writer_epoch
      AND NEW.idempotency_key IS OLD.idempotency_key
      AND NEW.payload_sha256 = OLD.payload_sha256
      AND NEW.redactions = OLD.redactions
      AND NEW.created_at = OLD.created_at
      AND NEW.expires_at IS OLD.expires_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'Session events are append-only');
    END;

  CREATE TRIGGER session_events_delete_with_session_only
    BEFORE DELETE ON session_events
    WHEN EXISTS (SELECT 1 FROM sessions owner WHERE owner.id = OLD.session_id)
    BEGIN
      SELECT RAISE(ABORT, 'Session events are append-only');
    END;

  -- Chat Jobs whose trace the mirror deferred because the egress scrubber was not
  -- ready. No payload: the trace is reconstructed from job_events and
  -- chat_job_inputs once the scrubber is ready, so nothing secret-bearing is
  -- queued and a crash before readiness loses nothing.
  CREATE TABLE session_mirror_backlog (
    job_id      TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    deferred_at TEXT NOT NULL
  );
  CREATE INDEX idx_session_mirror_backlog_order ON session_mirror_backlog(deferred_at, job_id);

  CREATE VIRTUAL TABLE session_events_fts USING fts5(
    search_text,
    content = 'session_events',
    content_rowid = 'row_id',
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER session_events_fts_insert
    AFTER INSERT ON session_events
    WHEN NEW.search_text IS NOT NULL
    BEGIN
      INSERT INTO session_events_fts(rowid, search_text) VALUES (NEW.row_id, NEW.search_text);
    END;

  CREATE TRIGGER session_events_fts_purge
    AFTER UPDATE OF search_text ON session_events
    WHEN OLD.search_text IS NOT NULL
    BEGIN
      INSERT INTO session_events_fts(session_events_fts, rowid, search_text)
        VALUES ('delete', OLD.row_id, OLD.search_text);
    END;

  CREATE TRIGGER session_events_fts_delete
    AFTER DELETE ON session_events
    WHEN OLD.search_text IS NOT NULL
    BEGIN
      INSERT INTO session_events_fts(session_events_fts, rowid, search_text)
        VALUES ('delete', OLD.row_id, OLD.search_text);
    END;
`

/**
 * Migration 33 — session-owned input artifacts (K4 bounded input slice). Additive:
 * it creates one table/index and replaces only the event-policy trigger.
 *
 * A v2 event is allowed only for `prompt`/`tool.call`, must carry an `artifact`
 * object instead of inline `text`/`arguments`, and its referenced row must
 * exist for the same session with the same checksum, size and media type. The
 * metadata row is inserted in the same transaction as its event, so a crash
 * leaves both or neither; a published blob without a row is an orphan.
 */
export const SESSION_INPUT_ARTIFACTS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS session_input_artifacts (
    artifact_id TEXT PRIMARY KEY CHECK (length(artifact_id) BETWEEN 1 AND 200),
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    checksum     TEXT NOT NULL CHECK (
      length(checksum) = 71 AND substr(checksum, 1, 7) = 'sha256:'
      AND substr(checksum, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    byte_size    INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 9007199254740991),
    media_type   TEXT NOT NULL CHECK (media_type IN ('text/plain; charset=utf-8', 'application/json')),
    created_at   TEXT NOT NULL,
    UNIQUE (session_id, checksum)
  );
  CREATE INDEX IF NOT EXISTS idx_session_input_artifacts_session
    ON session_input_artifacts(session_id);

  DROP TRIGGER IF EXISTS session_events_policy_insert;
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
