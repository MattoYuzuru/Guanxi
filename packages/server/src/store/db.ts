/**
 * SQLite поверх встроенного в Node `node:sqlite`.
 *
 * Никаких нативных зависимостей и сборки — именно это позволяет `npx guanxi`
 * запускаться на чистой машине без компилятора.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DURABLE_RUNS_MIGRATION } from '../runs/schema.ts'
import { SESSION_LOG_MIGRATION } from '../session-log/schema.ts'

export type Db = DatabaseSync

/**
 * Миграции применяются по порядку и однократно. Номер последней применённой
 * лежит в `user_version` — это встроенный счётчик SQLite, отдельная таблица не нужна.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — базовые сущности
  `
  CREATE TABLE workspaces (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    root_path    TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE threads (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('chat','agent')),
    model        TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    num_ctx      INTEGER NOT NULL,
    temperature  REAL NOT NULL,
    think        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_threads_updated ON threads(updated_at DESC);

  CREATE TABLE messages (
    id            TEXT PRIMARY KEY,
    thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content       TEXT NOT NULL,
    thinking      TEXT,
    tool_calls    TEXT NOT NULL DEFAULT '[]',
    usage         TEXT,
    is_compaction INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_messages_thread ON messages(thread_id, seq);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Замеры «окно контекста → занятая память» для уточнения вердикта по железу.
  CREATE TABLE model_calibration (
    model          TEXT NOT NULL,
    context_length INTEGER NOT NULL,
    size_bytes     INTEGER NOT NULL,
    size_vram_bytes INTEGER NOT NULL,
    measured_at    TEXT NOT NULL,
    PRIMARY KEY (model, context_length)
  );

  -- Журнал вызовов инструментов: из него строится таймлайн выполнения в UI.
  CREATE TABLE tool_runs (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id  TEXT,
    name        TEXT NOT NULL,
    arguments   TEXT NOT NULL,
    status      TEXT NOT NULL,
    result      TEXT,
    error       TEXT,
    duration_ms INTEGER,
    source      TEXT NOT NULL,
    parsed_from TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_tool_runs_thread ON tool_runs(thread_id, created_at);
  `,
  // 2 — последовательность сообщений внутри треда должна быть однозначной.
  `
  CREATE UNIQUE INDEX idx_messages_thread_seq ON messages(thread_id, seq);
  `,
  // 3 — additive bridge: truthful terminal outcome for current assistant turns.
  `
  ALTER TABLE messages ADD COLUMN turn_status TEXT
    CHECK (turn_status IN ('pending','completed','failed','cancelled'));
  ALTER TABLE messages ADD COLUMN turn_error TEXT;
  ALTER TABLE messages ADD COLUMN stop_reason TEXT
    CHECK (stop_reason IN (
      'stop',
      'length',
      'tool_calls',
      'tool_limit',
      'stopped_by_user',
      'connection_aborted',
      'provider_error',
      'protocol_error',
      'storage_error',
      'internal_error',
      'legacy_terminal_chunk',
      'error'
    ));

  -- Before P0-B, usage was only produced from an observed terminal Ollama chunk.
  -- That is sufficient evidence for completed, but the exact old done_reason was
  -- not stored. Rows without usage remain NULL/legacy-unknown, especially empty
  -- assistants left by aborts and protocol failures.
  UPDATE messages
  SET turn_status = 'completed',
      stop_reason = 'legacy_terminal_chunk'
  WHERE role = 'assistant'
    AND usage IS NOT NULL;
  `,
  // 4 — durable Job/event-store foundation. Current Chat routes do not use it yet.
  `
  CREATE TABLE jobs (
    id                    TEXT PRIMARY KEY,
    kind                  TEXT NOT NULL
      CHECK (kind IN ('inference','agent','tool','pipeline')),
    operation             TEXT NOT NULL,
    status                TEXT NOT NULL
      CHECK (status IN (
        'queued','reserving','loading','prefill','thinking','generating',
        'waiting_tool','waiting_approval','finalizing','cancelling',
        'completed','failed','cancelled','interrupted'
      )),
    phase                 TEXT,
    idempotency_scope     TEXT NOT NULL,
    idempotency_key       TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    error                 TEXT CHECK (error IS NULL OR json_valid(error)),
    outcome               TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
    stop_reason           TEXT,
    last_event_sequence   INTEGER NOT NULL CHECK (last_event_sequence >= 1),
    UNIQUE (idempotency_scope, idempotency_key),
    CHECK (
      (status IN ('completed','failed','cancelled','interrupted') AND finished_at IS NOT NULL)
      OR
      (status NOT IN ('completed','failed','cancelled','interrupted') AND finished_at IS NULL)
    )
  );

  CREATE TABLE job_events (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    sequence    INTEGER NOT NULL CHECK (sequence >= 1),
    type        TEXT NOT NULL
      CHECK (type IN (
        'lifecycle','output','tool','resource','usage','warning','error','checkpoint'
      )),
    state       TEXT NOT NULL
      CHECK (state IN (
        'queued','reserving','loading','prefill','thinking','generating',
        'waiting_tool','waiting_approval','finalizing','cancelling',
        'completed','failed','cancelled','interrupted'
      )),
    phase       TEXT,
    metadata    TEXT NOT NULL CHECK (json_valid(metadata)),
    created_at  TEXT NOT NULL,
    UNIQUE (job_id, sequence)
  );

  CREATE INDEX idx_job_events_replay ON job_events(job_id, sequence);
  CREATE UNIQUE INDEX idx_job_events_terminal
    ON job_events(job_id)
    WHERE state IN ('completed','failed','cancelled','interrupted');
  `,
  // 5 — durable Chat Job input, Message projection and private replay payload bridge.
  `
  ALTER TABLE messages ADD COLUMN job_id TEXT
    REFERENCES jobs(id) ON DELETE SET NULL;
  CREATE INDEX idx_messages_job ON messages(job_id, seq);
  CREATE UNIQUE INDEX idx_messages_job_user
    ON messages(job_id)
    WHERE job_id IS NOT NULL AND role = 'user';

  ALTER TABLE job_events ADD COLUMN output TEXT
    CHECK (output IS NULL OR json_valid(output));
  ALTER TABLE job_events ADD COLUMN output_privacy TEXT
    CHECK (output_privacy IS NULL OR output_privacy = 'private_chat');

  CREATE TABLE chat_job_inputs (
    job_id               TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    assistant_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    request_fingerprint  TEXT NOT NULL,
    input_json           TEXT NOT NULL CHECK (json_valid(input_json)),
    created_at           TEXT NOT NULL
  );
  CREATE INDEX idx_chat_job_inputs_thread ON chat_job_inputs(thread_id, job_id);
  `,
  // 6 — exact model/runtime/hardware/context calibration observations.
  // Legacy name/context rows remain intact, but are never promoted to exact evidence.
  `
  CREATE TABLE model_calibration_observations (
    observation_key              TEXT PRIMARY KEY
      CHECK (observation_key GLOB 'sha256:*' AND length(observation_key) = 71),
    key_version                  INTEGER NOT NULL CHECK (key_version = 1),
    provider                     TEXT NOT NULL CHECK (provider = 'ollama'),
    normalized_model_reference  TEXT NOT NULL,
    artifact_digest             TEXT NOT NULL,
    context_length              INTEGER NOT NULL CHECK (context_length > 0),
    runtime_backend_fingerprint TEXT NOT NULL,
    hardware_fingerprint        TEXT NOT NULL,
    size_bytes                  INTEGER NOT NULL CHECK (size_bytes > 0),
    size_vram_bytes             INTEGER NOT NULL CHECK (size_vram_bytes >= 0),
    measured_at                 TEXT NOT NULL
  );
  CREATE INDEX idx_model_calibration_observation_family
    ON model_calibration_observations (
      provider,
      normalized_model_reference,
      artifact_digest,
      runtime_backend_fingerprint,
      hardware_fingerprint,
      context_length
    );
  `,
  // 7 — exact, minimized installed provider-evidence cache.
  // The cache is additive and has no backfill: old code safely ignores this table.
  `
  CREATE TABLE installed_model_evidence_cache (
    cache_key                  TEXT PRIMARY KEY
      CHECK (cache_key GLOB 'sha256:*' AND length(cache_key) = 71),
    key_version                INTEGER NOT NULL CHECK (key_version = 1),
    evidence_schema_version    INTEGER NOT NULL CHECK (evidence_schema_version = 1),
    provider                   TEXT NOT NULL CHECK (provider = 'ollama'),
    normalized_model_reference TEXT NOT NULL,
    artifact_digest            TEXT NOT NULL,
    runtime_version            TEXT NOT NULL,
    safe_evidence_json         TEXT NOT NULL CHECK (json_valid(safe_evidence_json)),
    observed_at                TEXT NOT NULL,
    fetched_at                 TEXT NOT NULL,
    validated_at               TEXT NOT NULL,
    expires_at                 TEXT NOT NULL,
    stale_until                TEXT NOT NULL,
    CHECK (expires_at <= stale_until)
  );
  CREATE INDEX idx_installed_model_evidence_family
    ON installed_model_evidence_cache (
      provider,
      normalized_model_reference,
      artifact_digest,
      runtime_version,
      evidence_schema_version
    );
  `,
  // 8 — exact latest projection for the explicit completion probe.
  // No provider declaration is backfilled or promoted to runtime evidence.
  `
  CREATE TABLE completion_probe_evidence (
    probe_key                   TEXT PRIMARY KEY
      CHECK (probe_key GLOB 'sha256:*' AND length(probe_key) = 71),
    key_version                 INTEGER NOT NULL CHECK (key_version = 1),
    probe_definition_version    INTEGER NOT NULL CHECK (probe_definition_version = 1),
    provider                    TEXT NOT NULL CHECK (provider = 'ollama'),
    normalized_model_reference TEXT NOT NULL,
    artifact_digest             TEXT NOT NULL,
    runtime_version             TEXT NOT NULL,
    context_length              INTEGER NOT NULL CHECK (context_length > 0),
    outcome                     TEXT NOT NULL
      CHECK (outcome IN ('verified','degraded','unknown')),
    reason                      TEXT NOT NULL CHECK (reason IN (
      'terminal_response',
      'provider_unavailable',
      'connect_timeout',
      'load_timeout',
      'response_timeout',
      'provider_error',
      'runtime_protocol',
      'empty_response'
    )),
    source                      TEXT NOT NULL CHECK (source = 'runtime_probe'),
    confidence                  TEXT NOT NULL
      CHECK (confidence IN ('verified','degraded','unknown')),
    observed_at                 TEXT NOT NULL,
    completed_at                TEXT NOT NULL,
    duration_ms                 INTEGER NOT NULL CHECK (duration_ms >= 0)
  );
  CREATE INDEX idx_completion_probe_evidence_family
    ON completion_probe_evidence (
      provider,
      normalized_model_reference,
      artifact_digest,
      runtime_version,
      context_length,
      probe_definition_version
    );
  `,
  // 9 — explicit positive user capability assertions for one exact installed artifact.
  // Additive and never backfilled from provider declarations or probe results: old
  // code safely ignores this table, and a schema rollback does not remove user data.
  `
  CREATE TABLE model_capability_user_overrides (
    override_key                TEXT PRIMARY KEY
      CHECK (override_key GLOB 'sha256:*' AND length(override_key) = 71),
    key_version                 INTEGER NOT NULL CHECK (key_version = 1),
    override_schema_version     INTEGER NOT NULL CHECK (override_schema_version = 1),
    provider                    TEXT NOT NULL CHECK (provider = 'ollama'),
    normalized_model_reference  TEXT NOT NULL CHECK (length(normalized_model_reference) > 0),
    artifact_digest             TEXT NOT NULL CHECK (length(artifact_digest) > 0),
    runtime_version             TEXT NOT NULL CHECK (length(runtime_version) > 0),
    capability                  TEXT NOT NULL CHECK (capability IN (
      'completion','tools','vision','insert','thinking','embedding'
    )),
    source                      TEXT NOT NULL CHECK (source = 'user_override'),
    state                       TEXT NOT NULL CHECK (state = 'overridden'),
    value                       TEXT NOT NULL CHECK (value = 'present'),
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    UNIQUE (
      provider,
      normalized_model_reference,
      artifact_digest,
      runtime_version,
      capability,
      override_schema_version
    )
  );
  CREATE INDEX idx_model_capability_user_overrides_identity
    ON model_capability_user_overrides (
      provider,
      normalized_model_reference,
      artifact_digest,
      runtime_version,
      override_schema_version
    );
  `,
  // 10 — logical Project identity and additive legacy Workspace binding bridge.
  // Existing Workspace tables/routes remain authoritative for legacy clients.
  `
  CREATE TABLE projects (
    id         TEXT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    created_at TEXT NOT NULL CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
    updated_at TEXT NOT NULL CHECK (
      updated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(updated_at) IS NOT NULL
    )
  );

  CREATE TABLE project_filesystem_bindings (
    id           TEXT NOT NULL PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    UNIQUE (project_id, workspace_id)
  );
  CREATE INDEX idx_project_filesystem_bindings_project
    ON project_filesystem_bindings(project_id, created_at, id);

  -- Preserve exact legacy identity. Path and normalized name are deliberately
  -- absent from the identity mapping.
  INSERT INTO projects (id, name, created_at, updated_at)
  SELECT id,
         CASE
           WHEN length(trim(name, char(9) || char(10) || char(11) || char(12) ||
             char(13) || ' ' || char(160) || char(5760) || char(8192) || char(8193) ||
             char(8194) || char(8195) || char(8196) || char(8197) || char(8198) ||
             char(8199) || char(8200) || char(8201) || char(8202) || char(8232) ||
             char(8233) || char(8239) || char(8287) || char(12288) || char(65279)))
             BETWEEN 1 AND 120
           THEN trim(name, char(9) || char(10) || char(11) || char(12) ||
             char(13) || ' ' || char(160) || char(5760) || char(8192) || char(8193) ||
             char(8194) || char(8195) || char(8196) || char(8197) || char(8198) ||
             char(8199) || char(8200) || char(8201) || char(8202) || char(8232) ||
             char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
           ELSE 'Untitled Project'
         END,
         created_at,
         created_at
  FROM workspaces;

  INSERT INTO project_filesystem_bindings (id, project_id, workspace_id, created_at)
  SELECT 'workspace:' || id, id, id, created_at
  FROM workspaces;
  `,
  // 11 — versioned Project presentation metadata. Defaults keep old writers
  // compatible and deterministically backfill all v10 rows.
  `
  ALTER TABLE projects ADD COLUMN icon_key TEXT NOT NULL DEFAULT 'folder'
    CHECK (icon_key IN (
      'folder','briefcase','star','home','bookmark','flag','target','rocket',
      'code','terminal','braces','git-branch','database','server','binary','wrench',
      'book-open','search','microscope','flask','graduation-cap','library','telescope','notebook',
      'palette','pen-tool','music','camera','film','shapes','sparkles','wand',
      'settings','gauge','network','cloud','hard-drive','box','layers','workflow',
      'heart','users','user','calendar','coffee','plane','mountain','dumbbell'
    ));

  ALTER TABLE projects ADD COLUMN color_token TEXT NOT NULL DEFAULT 'slate'
    CHECK (color_token IN (
      'slate','blue','cyan','green','amber','orange','rose','violet'
    ));
  `,
  // 12 — immutable nullable Project ownership for Chat. Existing Threads stay
  // projectless and old writers can keep omitting the additive column.
  `
  ALTER TABLE threads ADD COLUMN project_id TEXT
    REFERENCES projects(id) ON DELETE RESTRICT;
  CREATE INDEX idx_threads_project_updated
    ON threads(project_id, updated_at DESC, id);
  `,
  // 13 — append-only integrity hardening for v12 ownership. It prevents local
  // or future writers from reparenting Project Chats or attaching agent scope.
  `
  CREATE TRIGGER threads_project_ownership_immutable
    BEFORE UPDATE OF project_id ON threads
    WHEN OLD.project_id IS NOT NEW.project_id
    BEGIN
      SELECT RAISE(ABORT, 'thread project ownership is immutable');
    END;
  CREATE TRIGGER threads_project_chat_insert_valid
    BEFORE INSERT ON threads
    WHEN NEW.project_id IS NOT NULL
      AND (NEW.mode <> 'chat' OR NEW.workspace_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Project-owned thread must be a Chat without Workspace scope');
    END;
  CREATE TRIGGER threads_project_chat_update_valid
    BEFORE UPDATE OF mode, workspace_id ON threads
    WHEN NEW.project_id IS NOT NULL
      AND (NEW.mode <> 'chat' OR NEW.workspace_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Project-owned thread must be a Chat without Workspace scope');
    END;
  `,
  // 14 — canonical Chat retention foundation. Existing rows are projected as
  // Keep explicitly so no pre-v14 history becomes cleanup-eligible. New Chats
  // are written with the seven-day default by ThreadStore; no cleanup exists yet.
  `
  ALTER TABLE threads ADD COLUMN retention_policy TEXT
    CHECK (retention_policy IN ('keep','ttl','session'));
  ALTER TABLE threads ADD COLUMN retention_policy_source TEXT
    CHECK (retention_policy_source IN ('default','user','legacy_compatibility'));
  ALTER TABLE threads ADD COLUMN retention_policy_updated_at TEXT;
  ALTER TABLE threads ADD COLUMN last_user_activity_at TEXT;
  ALTER TABLE threads ADD COLUMN last_user_activity_source TEXT
    CHECK (last_user_activity_source IN ('chat_created','user_message'));

  UPDATE threads
  SET retention_policy = 'keep',
      retention_policy_source = 'legacy_compatibility',
      retention_policy_updated_at = created_at,
      last_user_activity_at = created_at,
      last_user_activity_source = 'chat_created';
  CREATE INDEX idx_threads_retention_policy
    ON threads(retention_policy, last_user_activity_at, id);
  `,
  // 15 — recoverable Chat lifecycle enforcement. Existing rows remain active;
  // no metadata, Message, Job, Artifact or blob is physically deleted here.
  `
  ALTER TABLE threads ADD COLUMN chat_lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (chat_lifecycle_state IN ('active','trash'));
  ALTER TABLE threads ADD COLUMN chat_tombstoned_at TEXT;
  ALTER TABLE threads ADD COLUMN chat_tombstone_reason TEXT
    CHECK (chat_tombstone_reason IS NULL OR chat_tombstone_reason = 'ttl_expired');
  ALTER TABLE threads ADD COLUMN chat_tombstone_activity_at TEXT;
  ALTER TABLE threads ADD COLUMN last_user_restore_at TEXT;

  CREATE TRIGGER threads_chat_lifecycle_insert_valid
    BEFORE INSERT ON threads
    WHEN NOT (
      (NEW.chat_lifecycle_state = 'active'
        AND NEW.chat_tombstoned_at IS NULL
        AND NEW.chat_tombstone_reason IS NULL
        AND NEW.chat_tombstone_activity_at IS NULL)
      OR
      (NEW.chat_lifecycle_state = 'trash'
        AND NEW.mode = 'chat'
        AND NEW.chat_tombstoned_at IS NOT NULL
        AND NEW.chat_tombstone_reason = 'ttl_expired'
        AND NEW.chat_tombstone_activity_at IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Chat lifecycle state');
    END;
  CREATE TRIGGER threads_chat_lifecycle_update_valid
    BEFORE UPDATE OF chat_lifecycle_state, chat_tombstoned_at,
      chat_tombstone_reason, chat_tombstone_activity_at ON threads
    WHEN NOT (
      (NEW.chat_lifecycle_state = 'active'
        AND NEW.chat_tombstoned_at IS NULL
        AND NEW.chat_tombstone_reason IS NULL
        AND NEW.chat_tombstone_activity_at IS NULL)
      OR
      (NEW.chat_lifecycle_state = 'trash'
        AND NEW.mode = 'chat'
        AND NEW.chat_tombstoned_at IS NOT NULL
        AND NEW.chat_tombstone_reason = 'ttl_expired'
        AND NEW.chat_tombstone_activity_at IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Chat lifecycle state');
    END;

  CREATE TABLE chat_lifecycle_audit (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id           TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    event_type        TEXT NOT NULL CHECK (event_type IN ('tombstoned','restored')),
    reason            TEXT NOT NULL CHECK (reason IN ('ttl_expired','user_restore','policy_change')),
    occurred_at       TEXT NOT NULL,
    activity_basis_at TEXT NOT NULL,
    source            TEXT NOT NULL CHECK (source IN ('server_maintenance','user_action')),
    UNIQUE (chat_id, event_type, occurred_at)
  );
  CREATE INDEX idx_chat_lifecycle_audit_chat
    ON chat_lifecycle_audit(chat_id, id);
  CREATE INDEX idx_threads_chat_ttl_eligibility
    ON threads(chat_lifecycle_state, retention_policy, last_user_activity_at, id);
  CREATE INDEX idx_threads_chat_trash_scope
    ON threads(chat_lifecycle_state, project_id, chat_tombstoned_at DESC, id);
  `,
  // 16 — canonical diagnostic reasoning Artifact metadata/content. Existing
  // messages.thinking remains untouched as a literal compatibility source.
  `
  CREATE TABLE reasoning_artifacts (
    id                         TEXT PRIMARY KEY,
    artifact_version           INTEGER NOT NULL CHECK (artifact_version = 1),
    chat_id                    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    project_id                 TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    source_message_id          TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    source_job_id              TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    media_type                 TEXT NOT NULL CHECK (media_type = 'text/markdown; charset=utf-8'),
    storage_kind               TEXT NOT NULL CHECK (storage_kind = 'sqlite_text'),
    content_text               TEXT NOT NULL CHECK (length(content_text) > 0),
    byte_size                  INTEGER NOT NULL CHECK (byte_size > 0),
    checksum                   TEXT NOT NULL CHECK (
      checksum GLOB 'sha256:*'
      AND length(checksum) = 71
      AND substr(checksum, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    created_at                 TEXT NOT NULL,
    artifact_expires_at        TEXT NOT NULL,
    parent_retention_mode      TEXT NOT NULL CHECK (parent_retention_mode IN ('keep','ttl','session')),
    parent_retention_expires_at TEXT,
    effective_expires_at       TEXT NOT NULL,
    CHECK (effective_expires_at <= artifact_expires_at),
    CHECK (
      (parent_retention_mode = 'ttl' AND parent_retention_expires_at IS NOT NULL)
      OR (parent_retention_mode <> 'ttl' AND parent_retention_expires_at IS NULL)
    )
  );
  CREATE INDEX idx_reasoning_artifacts_chat
    ON reasoning_artifacts(chat_id, created_at, id);

  CREATE TRIGGER reasoning_artifacts_source_insert_valid
    BEFORE INSERT ON reasoning_artifacts
    WHEN NOT EXISTS (
      SELECT 1
      FROM messages m
      JOIN chat_job_inputs i
        ON i.job_id = NEW.source_job_id
       AND i.thread_id = NEW.chat_id
      JOIN threads t ON t.id = NEW.chat_id
      WHERE m.id = NEW.source_message_id
        AND m.thread_id = NEW.chat_id
        AND m.job_id = NEW.source_job_id
        AND m.role = 'assistant'
        AND t.mode = 'chat'
        AND t.project_id IS NEW.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid reasoning Artifact source ownership');
    END;

  CREATE TRIGGER reasoning_artifacts_immutable
    BEFORE UPDATE ON reasoning_artifacts
    BEGIN
      SELECT RAISE(ABORT, 'reasoning Artifact is immutable');
    END;
  `,
  // 17 — redacted crash-safe evidence for automatic diagnostic reasoning
  // expiry. Source content remains absent and v16 Artifact rows are not backfilled.
  `
  CREATE TABLE reasoning_artifact_deletion_audit (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    enforcement_version INTEGER NOT NULL CHECK (enforcement_version = 1),
    artifact_id         TEXT NOT NULL UNIQUE,
    artifact_version    INTEGER NOT NULL CHECK (artifact_version = 1),
    chat_id             TEXT NOT NULL,
    project_id          TEXT,
    source_message_id   TEXT NOT NULL,
    source_job_id       TEXT NOT NULL,
    reason              TEXT NOT NULL CHECK (
      reason IN ('diagnostic_ttl_expired','shorter_parent_ttl_expired')
    ),
    due_at              TEXT NOT NULL,
    occurred_at         TEXT NOT NULL,
    source              TEXT NOT NULL CHECK (source = 'server_maintenance')
  );
  CREATE INDEX idx_reasoning_artifact_deletion_audit_chat
    ON reasoning_artifact_deletion_audit(chat_id, occurred_at, artifact_id);
  `,
  // 18 — explicit Session leave basis and recoverable 24-hour Trash projection.
  // Existing TTL lifecycle bytes stay intact; hard deletion remains unimplemented.
  `
  ALTER TABLE threads ADD COLUMN session_leave_at TEXT;
  ALTER TABLE threads ADD COLUMN session_leave_source TEXT
    CHECK (session_leave_source IS NULL OR session_leave_source = 'explicit_user_action');
  ALTER TABLE threads ADD COLUMN chat_lifecycle_reason TEXT
    CHECK (chat_lifecycle_reason IS NULL OR chat_lifecycle_reason IN ('ttl_expired','session_left'));

  UPDATE threads
  SET chat_lifecycle_reason = chat_tombstone_reason
  WHERE chat_lifecycle_state = 'trash';

  DROP TRIGGER threads_chat_lifecycle_insert_valid;
  DROP TRIGGER threads_chat_lifecycle_update_valid;
  CREATE TRIGGER threads_chat_lifecycle_insert_valid
    BEFORE INSERT ON threads
    WHEN NOT (
      (NEW.chat_lifecycle_state = 'active'
        AND NEW.chat_tombstoned_at IS NULL
        AND NEW.chat_tombstone_reason IS NULL
        AND NEW.chat_tombstone_activity_at IS NULL
        AND NEW.chat_lifecycle_reason IS NULL)
      OR
      (NEW.chat_lifecycle_state = 'trash'
        AND NEW.mode = 'chat'
        AND NEW.chat_tombstoned_at IS NOT NULL
        AND NEW.chat_tombstone_activity_at IS NOT NULL
        AND (
          (NEW.chat_lifecycle_reason = 'ttl_expired'
            AND NEW.chat_tombstone_reason = 'ttl_expired')
          OR
          (NEW.chat_lifecycle_reason = 'session_left'
            AND NEW.chat_tombstone_reason IS NULL)
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Chat lifecycle state');
    END;
  CREATE TRIGGER threads_chat_lifecycle_update_valid
    BEFORE UPDATE OF chat_lifecycle_state, chat_tombstoned_at,
      chat_tombstone_reason, chat_tombstone_activity_at, chat_lifecycle_reason ON threads
    WHEN NOT (
      (NEW.chat_lifecycle_state = 'active'
        AND NEW.chat_tombstoned_at IS NULL
        AND NEW.chat_tombstone_reason IS NULL
        AND NEW.chat_tombstone_activity_at IS NULL
        AND NEW.chat_lifecycle_reason IS NULL)
      OR
      (NEW.chat_lifecycle_state = 'trash'
        AND NEW.mode = 'chat'
        AND NEW.chat_tombstoned_at IS NOT NULL
        AND NEW.chat_tombstone_activity_at IS NOT NULL
        AND (
          (NEW.chat_lifecycle_reason = 'ttl_expired'
            AND NEW.chat_tombstone_reason = 'ttl_expired')
          OR
          (NEW.chat_lifecycle_reason = 'session_left'
            AND NEW.chat_tombstone_reason IS NULL)
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Chat lifecycle state');
    END;

  CREATE TRIGGER threads_session_leave_insert_valid
    BEFORE INSERT ON threads
    WHEN NOT (
      (NEW.session_leave_at IS NULL AND NEW.session_leave_source IS NULL)
      OR
      (NEW.mode = 'chat' AND NEW.retention_policy = 'session'
        AND NEW.session_leave_at IS NOT NULL
        AND NEW.session_leave_source = 'explicit_user_action')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Session leave basis');
    END;
  CREATE TRIGGER threads_session_leave_update_valid
    BEFORE UPDATE OF mode, retention_policy, session_leave_at, session_leave_source ON threads
    WHEN NOT (
      (NEW.session_leave_at IS NULL AND NEW.session_leave_source IS NULL)
      OR
      (NEW.mode = 'chat' AND NEW.retention_policy = 'session'
        AND NEW.session_leave_at IS NOT NULL
        AND NEW.session_leave_source = 'explicit_user_action')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Session leave basis');
    END;

  DROP INDEX idx_chat_lifecycle_audit_chat;
  ALTER TABLE chat_lifecycle_audit RENAME TO chat_lifecycle_audit_v15;
  CREATE TABLE chat_lifecycle_audit (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id           TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    event_type        TEXT NOT NULL CHECK (event_type IN ('tombstoned','restored')),
    reason            TEXT NOT NULL CHECK (
      reason IN ('ttl_expired','session_left','user_restore','policy_change')
    ),
    occurred_at       TEXT NOT NULL,
    activity_basis_at TEXT NOT NULL,
    source            TEXT NOT NULL CHECK (source IN ('server_maintenance','user_action')),
    UNIQUE (chat_id, event_type, occurred_at)
  );
  INSERT INTO chat_lifecycle_audit (
    id, chat_id, event_type, reason, occurred_at, activity_basis_at, source
  )
  SELECT id, chat_id, event_type, reason, occurred_at, activity_basis_at, source
  FROM chat_lifecycle_audit_v15;
  DROP TABLE chat_lifecycle_audit_v15;
  CREATE INDEX idx_chat_lifecycle_audit_chat
    ON chat_lifecycle_audit(chat_id, id);
  CREATE INDEX idx_threads_chat_session_eligibility
    ON threads(chat_lifecycle_state, retention_policy, session_leave_at, id);
  `,
  // 19 — harden already-applied v18 Session Trash integrity append-only.
  `
  CREATE TABLE migration_19_session_lifecycle_validation (
    valid INTEGER NOT NULL CHECK (valid = 1)
  );
  INSERT INTO migration_19_session_lifecycle_validation(valid)
  SELECT 0 FROM threads
  WHERE chat_lifecycle_reason = 'session_left'
    AND (
      mode <> 'chat'
      OR retention_policy <> 'session'
      OR session_leave_at IS NULL
      OR session_leave_source IS NOT 'explicit_user_action'
      OR chat_tombstone_activity_at IS NOT session_leave_at
    )
  LIMIT 1;
  DROP TABLE migration_19_session_lifecycle_validation;

  DROP TRIGGER threads_chat_lifecycle_insert_valid;
  DROP TRIGGER threads_chat_lifecycle_update_valid;
  CREATE TRIGGER threads_chat_lifecycle_insert_valid
    BEFORE INSERT ON threads
    WHEN NOT (
      (NEW.chat_lifecycle_state = 'active'
        AND NEW.chat_tombstoned_at IS NULL
        AND NEW.chat_tombstone_reason IS NULL
        AND NEW.chat_tombstone_activity_at IS NULL
        AND NEW.chat_lifecycle_reason IS NULL)
      OR
      (NEW.chat_lifecycle_state = 'trash'
        AND NEW.mode = 'chat'
        AND NEW.chat_tombstoned_at IS NOT NULL
        AND NEW.chat_tombstone_activity_at IS NOT NULL
        AND (
          (NEW.chat_lifecycle_reason = 'ttl_expired'
            AND NEW.chat_tombstone_reason = 'ttl_expired')
          OR
          (NEW.chat_lifecycle_reason = 'session_left'
            AND NEW.chat_tombstone_reason IS NULL
            AND NEW.retention_policy = 'session'
            AND NEW.session_leave_at IS NOT NULL
            AND NEW.session_leave_source = 'explicit_user_action'
            AND NEW.chat_tombstone_activity_at = NEW.session_leave_at)
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Chat lifecycle state');
    END;
  CREATE TRIGGER threads_chat_lifecycle_update_valid
    BEFORE UPDATE OF chat_lifecycle_state, chat_tombstoned_at,
      chat_tombstone_reason, chat_tombstone_activity_at, chat_lifecycle_reason ON threads
    WHEN NOT (
      (NEW.chat_lifecycle_state = 'active'
        AND NEW.chat_tombstoned_at IS NULL
        AND NEW.chat_tombstone_reason IS NULL
        AND NEW.chat_tombstone_activity_at IS NULL
        AND NEW.chat_lifecycle_reason IS NULL)
      OR
      (NEW.chat_lifecycle_state = 'trash'
        AND NEW.mode = 'chat'
        AND NEW.chat_tombstoned_at IS NOT NULL
        AND NEW.chat_tombstone_activity_at IS NOT NULL
        AND (
          (NEW.chat_lifecycle_reason = 'ttl_expired'
            AND NEW.chat_tombstone_reason = 'ttl_expired')
          OR
          (NEW.chat_lifecycle_reason = 'session_left'
            AND NEW.chat_tombstone_reason IS NULL
            AND NEW.retention_policy = 'session'
            AND NEW.session_leave_at IS NOT NULL
            AND NEW.session_leave_source = 'explicit_user_action'
            AND NEW.chat_tombstone_activity_at = NEW.session_leave_at)
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Chat lifecycle state');
    END;
  CREATE INDEX idx_threads_chat_session_integrity
    ON threads(chat_lifecycle_reason, retention_policy, session_leave_at, id);
  `,
  // 20 — durable content-free evidence for Session Chat metadata deletion.
  // The audit deliberately has no parent FK so it survives the Thread cascade.
  `
  CREATE TABLE chat_deletion_audit (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    deletion_version  INTEGER NOT NULL CHECK (deletion_version = 1),
    chat_id           TEXT NOT NULL UNIQUE,
    scope             TEXT NOT NULL CHECK (scope IN ('projectless','project')),
    project_id        TEXT,
    reason            TEXT NOT NULL CHECK (reason = 'session_recovery_elapsed'),
    tombstoned_at     TEXT NOT NULL,
    recovery_deadline TEXT NOT NULL,
    deleted_at        TEXT NOT NULL,
    source            TEXT NOT NULL CHECK (source = 'server_maintenance'),
    boundary          TEXT NOT NULL CHECK (boundary = 'thread_owned_sqlite_metadata'),
    blob_gc           TEXT NOT NULL CHECK (blob_gc = 'not_applicable'),
    CHECK (
      (scope = 'projectless' AND project_id IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL)
    )
  );
  CREATE INDEX idx_chat_deletion_audit_scope
    ON chat_deletion_audit(scope, project_id, deleted_at DESC, chat_id);
  `,
  // 21 — canonical metadata-only Quick Run identity and shared retention policy.
  // No Job, Artifact, Session leave or cleanup path is introduced here.
  `
  CREATE TABLE quick_runs (
    id                          TEXT PRIMARY KEY,
    quick_run_version           INTEGER NOT NULL CHECK (quick_run_version = 1),
    operation                   TEXT NOT NULL CHECK (operation IN (
      'complete','embed','transcribe','textToSpeech','ocr','caption','generateImage','generateVideo'
    )),
    project_id                  TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    retention_policy           TEXT NOT NULL CHECK (retention_policy IN ('keep','ttl','session')),
    retention_policy_source    TEXT NOT NULL CHECK (retention_policy_source IN ('default','user')),
    retention_policy_updated_at TEXT NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (retention_policy_source <> 'default' OR retention_policy = 'ttl')
  );
  CREATE INDEX idx_quick_runs_scope_updated
    ON quick_runs(project_id, updated_at DESC, id);

  CREATE TRIGGER quick_runs_identity_immutable
    BEFORE UPDATE OF id, quick_run_version, operation, project_id, created_at ON quick_runs
    BEGIN
      SELECT RAISE(ABORT, 'Quick Run identity is immutable');
    END;
  `,
  // 22 — canonical Recipe identity and immutable numbered configuration revisions.
  // Execution, routing policy and Job snapshot wiring deliberately remain absent.
  `
  CREATE TABLE recipes (
    id               TEXT PRIMARY KEY,
    recipe_version   INTEGER NOT NULL CHECK (recipe_version = 1),
    project_id       TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    name             TEXT NOT NULL CHECK (
      length(trim(name)) BETWEEN 1 AND 255 AND name = trim(name)
    ),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    CHECK (updated_at >= created_at)
  );
  CREATE INDEX idx_recipes_scope_updated
    ON recipes(project_id, updated_at DESC, id);

  CREATE TABLE recipe_revisions (
    recipe_id                TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    revision_number          INTEGER NOT NULL CHECK (revision_number >= 1),
    recipe_revision_version  INTEGER NOT NULL CHECK (recipe_revision_version = 1),
    operation                TEXT NOT NULL CHECK (operation IN (
      'complete','embed','transcribe','textToSpeech','ocr','caption','generateImage','generateVideo'
    )),
    model_state              TEXT NOT NULL CHECK (model_state IN ('none','explicit')),
    model_provider           TEXT,
    model_reference          TEXT,
    instructions             TEXT NOT NULL,
    default_parameters_json  TEXT NOT NULL CHECK (json_valid(default_parameters_json)),
    retention_policy         TEXT NOT NULL CHECK (retention_policy IN ('keep','ttl','session')),
    configuration_json       TEXT NOT NULL CHECK (json_valid(configuration_json)),
    configuration_byte_size  INTEGER NOT NULL CHECK (configuration_byte_size >= 0),
    configuration_sha256     TEXT NOT NULL CHECK (
      length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at               TEXT NOT NULL,
    PRIMARY KEY (recipe_id, revision_number),
    CHECK (
      (model_state = 'none' AND model_provider IS NULL AND model_reference IS NULL)
      OR
      (model_state = 'explicit' AND model_provider = 'ollama'
        AND model_reference IS NOT NULL AND length(trim(model_reference)) > 0
        AND model_reference = trim(model_reference))
    )
  );
  CREATE INDEX idx_recipe_revisions_created
    ON recipe_revisions(recipe_id, revision_number DESC);

  CREATE TRIGGER recipes_identity_immutable
    BEFORE UPDATE OF id, recipe_version, project_id, created_at ON recipes
    BEGIN
      SELECT RAISE(ABORT, 'Recipe identity and Project ownership are immutable');
    END;

  CREATE TRIGGER recipe_revisions_immutable_update
    BEFORE UPDATE ON recipe_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Recipe revisions are immutable');
    END;

  CREATE TRIGGER recipe_revisions_immutable_delete
    BEFORE DELETE ON recipe_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Recipe revisions are immutable');
    END;

  CREATE TRIGGER recipes_current_revision_must_exist
    BEFORE UPDATE OF current_revision ON recipes
    WHEN NOT EXISTS (
      SELECT 1 FROM recipe_revisions
      WHERE recipe_id = OLD.id AND revision_number = NEW.current_revision
    )
    BEGIN
      SELECT RAISE(ABORT, 'Recipe current revision must already exist');
    END;
  `,
  // 23 — immutable exact Recipe revision materialized into one queued Job snapshot.
  // The snapshot is a private configuration boundary; Job/event metadata stay content-free.
  `
  CREATE TABLE recipe_job_snapshots (
    job_id                    TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
    snapshot_version          INTEGER NOT NULL CHECK (snapshot_version = 1),
    recipe_id                 TEXT NOT NULL,
    recipe_revision           INTEGER NOT NULL CHECK (recipe_revision >= 1),
    scope                     TEXT NOT NULL CHECK (scope IN ('projectless','project')),
    project_id                TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    job_kind                  TEXT NOT NULL CHECK (job_kind = 'inference'),
    operation                 TEXT NOT NULL CHECK (operation IN (
      'complete','embed','transcribe','textToSpeech','ocr','caption','generateImage','generateVideo'
    )),
    model_state               TEXT NOT NULL CHECK (model_state IN ('none','explicit')),
    model_provider            TEXT,
    model_reference           TEXT,
    configuration_json        TEXT NOT NULL CHECK (json_valid(configuration_json)),
    configuration_byte_size   INTEGER NOT NULL CHECK (configuration_byte_size >= 0),
    configuration_sha256      TEXT NOT NULL CHECK (
      length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    request_fingerprint       TEXT NOT NULL CHECK (
      length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    created_at                TEXT NOT NULL,
    FOREIGN KEY (recipe_id, recipe_revision)
      REFERENCES recipe_revisions(recipe_id, revision_number) ON DELETE RESTRICT,
    CHECK (
      (scope = 'projectless' AND project_id IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL)
    ),
    CHECK (
      (model_state = 'none' AND model_provider IS NULL AND model_reference IS NULL)
      OR
      (model_state = 'explicit' AND model_provider = 'ollama'
        AND model_reference IS NOT NULL AND length(trim(model_reference)) > 0
        AND model_reference = trim(model_reference))
    )
  );
  CREATE INDEX idx_recipe_job_snapshots_recipe
    ON recipe_job_snapshots(recipe_id, recipe_revision, created_at, job_id);

  CREATE TRIGGER recipe_job_snapshots_exact_source
    BEFORE INSERT ON recipe_job_snapshots
    WHEN NOT EXISTS (
      SELECT 1
      FROM recipes recipe
      JOIN recipe_revisions revision
        ON revision.recipe_id = recipe.id
       AND revision.revision_number = NEW.recipe_revision
      WHERE recipe.id = NEW.recipe_id
        AND recipe.project_id IS NEW.project_id
        AND NEW.scope = CASE WHEN recipe.project_id IS NULL THEN 'projectless' ELSE 'project' END
        AND revision.operation = NEW.operation
        AND revision.model_state = NEW.model_state
        AND revision.model_provider IS NEW.model_provider
        AND revision.model_reference IS NEW.model_reference
        AND revision.configuration_json = NEW.configuration_json
        AND revision.configuration_byte_size = NEW.configuration_byte_size
        AND revision.configuration_sha256 = NEW.configuration_sha256
    )
    BEGIN
      SELECT RAISE(ABORT, 'Recipe Job snapshot source mismatch');
    END;

  CREATE TRIGGER recipe_job_snapshots_exact_job
    BEFORE INSERT ON recipe_job_snapshots
    WHEN NOT EXISTS (
      SELECT 1 FROM jobs job
      WHERE job.id = NEW.job_id
        AND job.kind = NEW.job_kind
        AND job.operation = NEW.operation
        AND job.status = 'queued'
        AND job.phase IS NULL
        AND job.idempotency_scope = 'recipe_job_snapshot:v1'
        AND job.created_at = NEW.created_at
        AND job.last_event_sequence = 1
        AND EXISTS (
          SELECT 1 FROM job_events event
          WHERE event.job_id = job.id
            AND event.sequence = 1
            AND event.type = 'lifecycle'
            AND event.state = 'queued'
            AND event.phase IS NULL
            AND event.metadata = '{}'
            AND event.output IS NULL
            AND event.output_privacy IS NULL
            AND event.created_at = NEW.created_at
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_events event
          WHERE event.job_id = job.id AND event.sequence <> 1
        )
        AND NOT EXISTS (SELECT 1 FROM chat_job_inputs chat WHERE chat.job_id = job.id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'Recipe Job snapshot Job mismatch');
    END;

  CREATE TRIGGER recipe_job_snapshots_immutable_update
    BEFORE UPDATE ON recipe_job_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'Recipe Job snapshots are immutable');
    END;

  CREATE TRIGGER recipe_job_snapshots_immutable_delete
    BEFORE DELETE ON recipe_job_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'Recipe Job snapshots are immutable');
    END;

  CREATE TRIGGER recipe_snapshot_job_identity_immutable
    BEFORE UPDATE OF id, kind, operation, idempotency_scope, idempotency_key, created_at ON jobs
    WHEN EXISTS (SELECT 1 FROM recipe_job_snapshots snapshot WHERE snapshot.job_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'Recipe snapshot Job identity is immutable');
    END;
  `,
  // 24 — visible non-destructive context checkpoints over preserved Messages.
  `
  CREATE TABLE context_checkpoints (
    id                       TEXT PRIMARY KEY,
    checkpoint_version       INTEGER NOT NULL CHECK (checkpoint_version = 1),
    thread_id                TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    previous_checkpoint_id   TEXT REFERENCES context_checkpoints(id),
    up_to_seq                INTEGER NOT NULL CHECK (up_to_seq >= 0),
    source_state             TEXT NOT NULL CHECK (source_state = 'source_preserved'),
    source_message_count     INTEGER NOT NULL CHECK (source_message_count > 0),
    summary_text             TEXT NOT NULL CHECK (length(summary_text) > 0),
    summary_byte_size        INTEGER NOT NULL CHECK (summary_byte_size > 0),
    summary_sha256           TEXT NOT NULL CHECK (
      length(summary_sha256) = 64 AND summary_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at               TEXT NOT NULL,
    UNIQUE (thread_id, up_to_seq),
    FOREIGN KEY (thread_id, up_to_seq)
      REFERENCES messages(thread_id, seq)
  );
  CREATE INDEX idx_context_checkpoints_thread
    ON context_checkpoints(thread_id, up_to_seq, id);

  CREATE TRIGGER context_checkpoints_exact_source
    BEFORE INSERT ON context_checkpoints
    WHEN NOT EXISTS (
      SELECT 1 FROM messages boundary
      WHERE boundary.thread_id = NEW.thread_id
        AND boundary.seq = NEW.up_to_seq
        AND NEW.source_message_count = (
          SELECT COUNT(*) FROM messages source
          WHERE source.thread_id = NEW.thread_id AND source.seq <= NEW.up_to_seq
        )
        AND (
          (
            NEW.previous_checkpoint_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM context_checkpoints current
              WHERE current.thread_id = NEW.thread_id
            )
          )
          OR
          EXISTS (
            SELECT 1 FROM context_checkpoints previous
            WHERE previous.id = NEW.previous_checkpoint_id
              AND previous.thread_id = NEW.thread_id
              AND previous.up_to_seq < NEW.up_to_seq
              AND NOT EXISTS (
                SELECT 1 FROM context_checkpoints newer
                WHERE newer.thread_id = NEW.thread_id
                  AND newer.up_to_seq > previous.up_to_seq
              )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Context checkpoint source mismatch');
    END;

  CREATE TRIGGER context_checkpoints_immutable_update
    BEFORE UPDATE ON context_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'Context checkpoints are immutable');
    END;

  CREATE TRIGGER checkpointed_messages_immutable_update
    BEFORE UPDATE ON messages
    WHEN EXISTS (
      SELECT 1 FROM context_checkpoints checkpoint
      WHERE checkpoint.thread_id = OLD.thread_id
        AND OLD.seq <= checkpoint.up_to_seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'Checkpointed Messages are immutable');
    END;

  CREATE TRIGGER checkpointed_messages_immutable_delete
    BEFORE DELETE ON messages
    WHEN EXISTS (
      SELECT 1 FROM context_checkpoints checkpoint
      WHERE checkpoint.thread_id = OLD.thread_id
        AND OLD.seq <= checkpoint.up_to_seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'Checkpointed Messages are immutable');
    END;
  `,
  // 25 — checkpoints are immutable unless their owning Thread is being deleted.
  `
  CREATE TRIGGER context_checkpoints_immutable_delete
    BEFORE DELETE ON context_checkpoints
    WHEN EXISTS (
      SELECT 1 FROM threads owner
      WHERE owner.id = OLD.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Context checkpoints are immutable');
    END;
  `,
  // 26 — immutable generic Artifact metadata and content-addressed blob references.
  // Files remain server-owned; this schema stores only a canonical relative key.
  `
  CREATE TABLE artifact_blobs (
    checksum    TEXT PRIMARY KEY CHECK (
      checksum GLOB 'sha256:*'
      AND length(checksum) = 71
      AND substr(checksum, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    byte_size   INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 9007199254740991),
    storage_key TEXT NOT NULL UNIQUE CHECK (
      storage_key = 'sha256/' || substr(checksum, 8, 2) || '/' || substr(checksum, 8)
    ),
    created_at  TEXT NOT NULL CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    )
  );

  CREATE TABLE artifacts (
    id                 TEXT PRIMARY KEY CHECK (
      length(id) = 36
      AND id = lower(id)
      AND substr(id, 9, 1) = '-'
      AND substr(id, 14, 1) = '-'
      AND substr(id, 19, 1) = '-'
      AND substr(id, 24, 1) = '-'
      AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    artifact_version   INTEGER NOT NULL CHECK (artifact_version = 1),
    write_intent_key   TEXT NOT NULL UNIQUE CHECK (
      length(write_intent_key) = 36
      AND write_intent_key = lower(write_intent_key)
      AND substr(write_intent_key, 9, 1) = '-'
      AND substr(write_intent_key, 14, 1) = '-'
      AND substr(write_intent_key, 19, 1) = '-'
      AND substr(write_intent_key, 24, 1) = '-'
      AND replace(write_intent_key, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    kind               TEXT NOT NULL CHECK (kind IN (
      'text','reasoning','transcript','image','audio','video','document',
      'structured','embedding','file','checkpoint','report'
    )),
    media_type         TEXT NOT NULL CHECK (
      length(media_type) BETWEEN 3 AND 255
      AND media_type = lower(media_type)
      AND instr(media_type, '/') BETWEEN 2 AND length(media_type) - 1
      AND instr(media_type, char(0)) = 0
      AND instr(media_type, char(9)) = 0
      AND instr(media_type, char(10)) = 0
      AND instr(media_type, char(13)) = 0
    ),
    blob_checksum      TEXT NOT NULL REFERENCES artifact_blobs(checksum) ON DELETE RESTRICT,
    project_id         TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    source_job_id      TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
    parent_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    retention_mode     TEXT NOT NULL CHECK (retention_mode = 'keep'),
    reference_state    TEXT NOT NULL CHECK (reference_state = 'referenced'),
    created_at         TEXT NOT NULL CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    )
  );
  CREATE INDEX idx_artifacts_blob ON artifacts(blob_checksum, id);
  CREATE INDEX idx_artifacts_project ON artifacts(project_id, created_at, id);
  CREATE INDEX idx_artifacts_job ON artifacts(source_job_id, created_at, id);
  CREATE INDEX idx_artifacts_parent ON artifacts(parent_artifact_id, created_at, id);

  CREATE TRIGGER artifacts_parent_scope_insert
    BEFORE INSERT ON artifacts
    WHEN NEW.parent_artifact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM artifacts parent
      WHERE parent.id = NEW.parent_artifact_id
        AND parent.project_id IS NEW.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Artifact parent ownership mismatch');
    END;

  CREATE TRIGGER artifacts_job_scope_insert
    BEFORE INSERT ON artifacts
    WHEN NEW.source_job_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jobs job
      WHERE job.id = NEW.source_job_id
        AND (
          (
            EXISTS (
              SELECT 1 FROM chat_job_inputs input
              JOIN threads thread ON thread.id = input.thread_id
              WHERE input.job_id = job.id AND thread.project_id IS NEW.project_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM recipe_job_snapshots snapshot WHERE snapshot.job_id = job.id
            )
          )
          OR
          (
            EXISTS (
              SELECT 1 FROM recipe_job_snapshots snapshot
              WHERE snapshot.job_id = job.id AND snapshot.project_id IS NEW.project_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM chat_job_inputs input WHERE input.job_id = job.id
            )
          )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Artifact source Job ownership mismatch');
    END;

  CREATE TRIGGER artifact_chat_job_scope_insert
    BEFORE INSERT ON chat_job_inputs
    WHEN EXISTS (
      SELECT 1 FROM artifacts artifact
      JOIN threads thread ON thread.id = NEW.thread_id
      WHERE artifact.source_job_id = NEW.job_id
        AND artifact.project_id IS NOT thread.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Artifact source Job ownership mismatch');
    END;

  CREATE TRIGGER artifact_recipe_job_scope_insert
    BEFORE INSERT ON recipe_job_snapshots
    WHEN EXISTS (
      SELECT 1 FROM artifacts artifact
      WHERE artifact.source_job_id = NEW.job_id
        AND artifact.project_id IS NOT NEW.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Artifact source Job ownership mismatch');
    END;

  CREATE TRIGGER artifacts_immutable_update
    BEFORE UPDATE ON artifacts
    BEGIN
      SELECT RAISE(ABORT, 'Artifacts are immutable');
    END;

  CREATE TRIGGER artifacts_immutable_delete
    BEFORE DELETE ON artifacts
    BEGIN
      SELECT RAISE(ABORT, 'Referenced Artifacts cannot be deleted');
    END;

  CREATE TRIGGER artifact_blobs_immutable_update
    BEFORE UPDATE ON artifact_blobs
    BEGIN
      SELECT RAISE(ABORT, 'Artifact blobs are immutable');
    END;

  CREATE TRIGGER referenced_artifact_blobs_delete
    BEFORE DELETE ON artifact_blobs
    WHEN EXISTS (SELECT 1 FROM artifacts artifact WHERE artifact.blob_checksum = OLD.checksum)
    BEGIN
      SELECT RAISE(ABORT, 'Referenced Artifact blobs cannot be deleted');
  END;
  `,
  // 27 — immutable presentation metadata for public local attachment transport.
  // A display name is never used as a filesystem path or storage key.
  `
  CREATE TABLE artifact_attachments (
    artifact_id       TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE RESTRICT,
    attachment_version INTEGER NOT NULL CHECK (attachment_version = 1),
    display_name      TEXT NOT NULL CHECK (
      length(display_name) BETWEEN 1 AND 120
      AND length(CAST(display_name AS BLOB)) <= 255
      AND display_name = trim(display_name)
      AND display_name NOT IN ('.', '..')
      AND instr(display_name, '/') = 0
      AND instr(display_name, char(92)) = 0
      AND instr(display_name, char(0)) = 0
      AND instr(display_name, char(9)) = 0
      AND instr(display_name, char(10)) = 0
      AND instr(display_name, char(13)) = 0
      AND display_name NOT GLOB '*' || char(127) || '*'
      AND display_name NOT GLOB '*' || char(128) || '*'
      AND display_name NOT GLOB '*' || char(129) || '*'
      AND display_name NOT GLOB '*' || char(130) || '*'
      AND display_name NOT GLOB '*' || char(131) || '*'
      AND display_name NOT GLOB '*' || char(132) || '*'
      AND display_name NOT GLOB '*' || char(133) || '*'
      AND display_name NOT GLOB '*' || char(134) || '*'
      AND display_name NOT GLOB '*' || char(135) || '*'
      AND display_name NOT GLOB '*' || char(136) || '*'
      AND display_name NOT GLOB '*' || char(137) || '*'
      AND display_name NOT GLOB '*' || char(138) || '*'
      AND display_name NOT GLOB '*' || char(139) || '*'
      AND display_name NOT GLOB '*' || char(140) || '*'
      AND display_name NOT GLOB '*' || char(141) || '*'
      AND display_name NOT GLOB '*' || char(142) || '*'
      AND display_name NOT GLOB '*' || char(143) || '*'
      AND display_name NOT GLOB '*' || char(144) || '*'
      AND display_name NOT GLOB '*' || char(145) || '*'
      AND display_name NOT GLOB '*' || char(146) || '*'
      AND display_name NOT GLOB '*' || char(147) || '*'
      AND display_name NOT GLOB '*' || char(148) || '*'
      AND display_name NOT GLOB '*' || char(149) || '*'
      AND display_name NOT GLOB '*' || char(150) || '*'
      AND display_name NOT GLOB '*' || char(151) || '*'
      AND display_name NOT GLOB '*' || char(152) || '*'
      AND display_name NOT GLOB '*' || char(153) || '*'
      AND display_name NOT GLOB '*' || char(154) || '*'
      AND display_name NOT GLOB '*' || char(155) || '*'
      AND display_name NOT GLOB '*' || char(156) || '*'
      AND display_name NOT GLOB '*' || char(157) || '*'
      AND display_name NOT GLOB '*' || char(158) || '*'
      AND display_name NOT GLOB '*' || char(159) || '*'
      AND instr(display_name, char(1564)) = 0
      AND instr(display_name, char(8206)) = 0
      AND instr(display_name, char(8207)) = 0
      AND instr(display_name, char(8234)) = 0
      AND instr(display_name, char(8235)) = 0
      AND instr(display_name, char(8236)) = 0
      AND instr(display_name, char(8237)) = 0
      AND instr(display_name, char(8238)) = 0
      AND instr(display_name, char(8294)) = 0
      AND instr(display_name, char(8295)) = 0
      AND instr(display_name, char(8296)) = 0
      AND instr(display_name, char(8297)) = 0
    ),
    created_at        TEXT NOT NULL CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    )
  );
  CREATE INDEX idx_artifact_attachments_created
    ON artifact_attachments(created_at DESC, artifact_id DESC);

  CREATE TRIGGER artifact_attachments_source_insert
    BEFORE INSERT ON artifact_attachments
    WHEN NOT EXISTS (
      SELECT 1 FROM artifacts artifact
      WHERE artifact.id = NEW.artifact_id
        AND artifact.kind = 'file'
        AND artifact.source_job_id IS NULL
        AND artifact.parent_artifact_id IS NULL
        AND artifact.created_at = NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'Attachment source Artifact is invalid');
    END;

  CREATE TRIGGER artifact_attachments_immutable_update
    BEFORE UPDATE ON artifact_attachments
    BEGIN
      SELECT RAISE(ABORT, 'Attachments are immutable');
    END;

  CREATE TRIGGER artifact_attachments_immutable_delete
    BEFORE DELETE ON artifact_attachments
    BEGIN
      SELECT RAISE(ABORT, 'Attachments are immutable');
    END;
  `,
  // 28 — append-only hardening for v27 databases that accepted some C0 controls.
  // Refuse to adopt an already-corrupt display name and enforce the same C0
  // range as the public attachment contract on every future insert.
  `
  CREATE TABLE migration_28_attachment_name_guard (
    valid INTEGER NOT NULL CHECK (valid = 1)
  );
  INSERT INTO migration_28_attachment_name_guard (valid)
    SELECT 0
    FROM artifact_attachments
    WHERE (
      instr(display_name, char(1)) <> 0
      OR instr(display_name, char(2)) <> 0
      OR instr(display_name, char(3)) <> 0
      OR instr(display_name, char(4)) <> 0
      OR instr(display_name, char(5)) <> 0
      OR instr(display_name, char(6)) <> 0
      OR instr(display_name, char(7)) <> 0
      OR instr(display_name, char(8)) <> 0
      OR instr(display_name, char(9)) <> 0
      OR instr(display_name, char(10)) <> 0
      OR instr(display_name, char(11)) <> 0
      OR instr(display_name, char(12)) <> 0
      OR instr(display_name, char(13)) <> 0
      OR instr(display_name, char(14)) <> 0
      OR instr(display_name, char(15)) <> 0
      OR instr(display_name, char(16)) <> 0
      OR instr(display_name, char(17)) <> 0
      OR instr(display_name, char(18)) <> 0
      OR instr(display_name, char(19)) <> 0
      OR instr(display_name, char(20)) <> 0
      OR instr(display_name, char(21)) <> 0
      OR instr(display_name, char(22)) <> 0
      OR instr(display_name, char(23)) <> 0
      OR instr(display_name, char(24)) <> 0
      OR instr(display_name, char(25)) <> 0
      OR instr(display_name, char(26)) <> 0
      OR instr(display_name, char(27)) <> 0
      OR instr(display_name, char(28)) <> 0
      OR instr(display_name, char(29)) <> 0
      OR instr(display_name, char(30)) <> 0
      OR instr(display_name, char(31)) <> 0
    )
    LIMIT 1;
  DROP TABLE migration_28_attachment_name_guard;

  CREATE TRIGGER artifact_attachments_safe_name_insert
    BEFORE INSERT ON artifact_attachments
    WHEN (
      instr(NEW.display_name, char(1)) <> 0
      OR instr(NEW.display_name, char(2)) <> 0
      OR instr(NEW.display_name, char(3)) <> 0
      OR instr(NEW.display_name, char(4)) <> 0
      OR instr(NEW.display_name, char(5)) <> 0
      OR instr(NEW.display_name, char(6)) <> 0
      OR instr(NEW.display_name, char(7)) <> 0
      OR instr(NEW.display_name, char(8)) <> 0
      OR instr(NEW.display_name, char(9)) <> 0
      OR instr(NEW.display_name, char(10)) <> 0
      OR instr(NEW.display_name, char(11)) <> 0
      OR instr(NEW.display_name, char(12)) <> 0
      OR instr(NEW.display_name, char(13)) <> 0
      OR instr(NEW.display_name, char(14)) <> 0
      OR instr(NEW.display_name, char(15)) <> 0
      OR instr(NEW.display_name, char(16)) <> 0
      OR instr(NEW.display_name, char(17)) <> 0
      OR instr(NEW.display_name, char(18)) <> 0
      OR instr(NEW.display_name, char(19)) <> 0
      OR instr(NEW.display_name, char(20)) <> 0
      OR instr(NEW.display_name, char(21)) <> 0
      OR instr(NEW.display_name, char(22)) <> 0
      OR instr(NEW.display_name, char(23)) <> 0
      OR instr(NEW.display_name, char(24)) <> 0
      OR instr(NEW.display_name, char(25)) <> 0
      OR instr(NEW.display_name, char(26)) <> 0
      OR instr(NEW.display_name, char(27)) <> 0
      OR instr(NEW.display_name, char(28)) <> 0
      OR instr(NEW.display_name, char(29)) <> 0
      OR instr(NEW.display_name, char(30)) <> 0
      OR instr(NEW.display_name, char(31)) <> 0
    )
    BEGIN
      SELECT RAISE(ABORT, 'Attachment display name contains a control character');
    END;
  `,
  // 29 — append-only session event log, writer epochs and FTS5 search (K2, ADR-0023).
  SESSION_LOG_MIGRATION,
  // 30 — single-node durable runs, fenced attempts, promises and wake outbox (R1).
  DURABLE_RUNS_MIGRATION,
]

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)

  // Concurrent application connections must wait even while negotiating WAL.
  db.exec('PRAGMA busy_timeout = 5000')
  // WAL держит чтение неблокирующим, пока идёт запись стрима сообщений.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // Deleted content (purged reasoning, deleted Chats) is overwritten, not left in free pages.
  db.exec('PRAGMA secure_delete = ON')

  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version]!)
      // user_version не принимает параметры привязки, поэтому подставляем числом.
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`Миграция ${version + 1} не применилась: ${String(error)}`)
    }
  }
}

/** Путь к базе по умолчанию: рядом с остальными данными приложения. */
export function defaultDbPath(dataDir: string): string {
  return `${dataDir}/guanxi.db`
}
