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
]

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)

  // WAL держит чтение неблокирующим, пока идёт запись стрима сообщений.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

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
