/**
 * SQLite поверх встроенного в Node `node:sqlite`.
 *
 * Никаких нативных зависимостей и сборки — именно это позволяет `npx alamo-ui`
 * запускаться на чистой машине без компилятора.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

/**
 * Миграции применяются по порядку и однократно. Номер последней применённой
 * лежит в `user_version` — это встроенный счётчик SQLite, отдельная таблица не нужна.
 */
const MIGRATIONS: readonly string[] = [
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
]

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)

  // Concurrent application connections must wait even while negotiating WAL.
  db.exec('PRAGMA busy_timeout = 5000')
  // WAL держит чтение неблокирующим, пока идёт запись стрима сообщений.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

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
  return `${dataDir}/alamo.db`
}
