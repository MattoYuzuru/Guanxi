import type { DatabaseSync } from 'node:sqlite'

/** Reverse only migration 29 (K2 session log) so older fixtures can start from exact v28. */
export function downgradeSessionLogToV28(db: DatabaseSync): void {
  downgradeDurableRunsToV29(db)
  db.exec(`
    DROP TABLE IF EXISTS session_input_artifacts;
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

/** Reverse only R1 in test databases; production migrations never run down. */
export function downgradeDurableRunsToV29(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS native_thread_delete_guard;
    DROP TABLE IF EXISTS native_sessions;
    DROP TABLE IF EXISTS run_execution;
    DROP INDEX idx_session_mirror_backlog_thread;
    DROP TABLE run_costs;
    DROP TABLE run_resources;
    DROP TABLE outbox;
    DROP TABLE timers;
    DROP TABLE promises;
    DROP TABLE run_attempts;
    DROP TABLE leases;
    DROP TABLE durable_runs;
    PRAGMA user_version = 29;
  `)
}
export const DURABLE_RUN_TABLES = ['durable_runs', 'run_attempts', 'leases', 'promises', 'timers',
  'outbox', 'run_resources', 'run_costs'] as const

/** Tables added since v28; older snapshot fixtures exclude these, including FTS shadows. */
export const SESSION_LOG_TABLES = [
  ...DURABLE_RUN_TABLES,
  'native_sessions', 'run_execution',
  'sessions',
  'session_writers',
  'session_events',
  'session_events_fts',
  'session_events_fts_config',
  'session_events_fts_data',
  'session_events_fts_docsize',
  'session_events_fts_idx',
  'session_mirror_backlog',
  'session_input_artifacts',
] as const
