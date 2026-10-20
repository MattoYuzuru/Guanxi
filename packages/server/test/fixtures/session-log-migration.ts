import type { DatabaseSync } from 'node:sqlite'

/** Reverse only migration 29 (K2 session log) so older fixtures can start from exact v28. */
export function downgradeSessionLogToV28(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX idx_session_mirror_backlog_order;
    DROP TABLE session_mirror_backlog;
    DROP TRIGGER session_events_fts_delete;
    DROP TRIGGER session_events_fts_purge;
    DROP TRIGGER session_events_fts_insert;
    DROP TABLE session_events_fts;
    DROP TRIGGER session_events_delete_with_session_only;
    DROP TRIGGER session_events_append_only_update;
    DROP TRIGGER session_events_advance_head;
    DROP TRIGGER session_events_policy_insert;
    DROP TRIGGER session_events_placement;
    DROP INDEX idx_session_events_reasoning_expiry;
    DROP INDEX idx_session_events_job;
    DROP TABLE session_events;
    DROP TRIGGER session_writers_delete_with_session_only;
    DROP TRIGGER session_writers_epoch_monotonic;
    DROP TABLE session_writers;
    DROP TRIGGER sessions_delete_with_thread_only;
    DROP TRIGGER sessions_head_follows_events;
    DROP TRIGGER sessions_identity_immutable;
    DROP TRIGGER sessions_policy_insert;
    DROP TABLE sessions;
    PRAGMA user_version = 28;
  `)
}

/** Tables migration 29 adds, FTS5 shadow tables included; pre-v29 snapshots exclude them. */
export const SESSION_LOG_TABLES = [
  'sessions',
  'session_writers',
  'session_events',
  'session_events_fts',
  'session_events_fts_config',
  'session_events_fts_data',
  'session_events_fts_docsize',
  'session_events_fts_idx',
  'session_mirror_backlog',
] as const
