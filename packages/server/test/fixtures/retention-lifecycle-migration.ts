import type { DatabaseSync } from 'node:sqlite'

/** Remove additive v18 Session lifecycle state while preserving the exact v17 shape. */
export function downgradeSessionLifecycleToV17(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX idx_threads_chat_session_eligibility;
    DROP TRIGGER threads_session_leave_update_valid;
    DROP TRIGGER threads_session_leave_insert_valid;
    DROP TRIGGER threads_chat_lifecycle_update_valid;
    DROP TRIGGER threads_chat_lifecycle_insert_valid;
    DROP INDEX idx_chat_lifecycle_audit_chat;
    ALTER TABLE chat_lifecycle_audit RENAME TO chat_lifecycle_audit_v18;
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
    INSERT INTO chat_lifecycle_audit
    SELECT * FROM chat_lifecycle_audit_v18;
    DROP TABLE chat_lifecycle_audit_v18;
    CREATE INDEX idx_chat_lifecycle_audit_chat
      ON chat_lifecycle_audit(chat_id, id);
    ALTER TABLE threads DROP COLUMN chat_lifecycle_reason;
    ALTER TABLE threads DROP COLUMN session_leave_source;
    ALTER TABLE threads DROP COLUMN session_leave_at;
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
    PRAGMA user_version = 17;
  `)
}

/** Remove additive v18/v17/v16/v15 artifacts before an older fixture is replayed. */
export function downgradeRetentionLifecycleToV14(db: DatabaseSync): void {
  downgradeSessionLifecycleToV17(db)
  db.exec(`
    DROP INDEX idx_reasoning_artifact_deletion_audit_chat;
    DROP TABLE reasoning_artifact_deletion_audit;
    DROP TRIGGER reasoning_artifacts_immutable;
    DROP TRIGGER reasoning_artifacts_source_insert_valid;
    DROP INDEX idx_reasoning_artifacts_chat;
    DROP TABLE reasoning_artifacts;
    DROP INDEX idx_threads_chat_trash_scope;
    DROP INDEX idx_threads_chat_ttl_eligibility;
    DROP INDEX idx_chat_lifecycle_audit_chat;
    DROP TRIGGER threads_chat_lifecycle_update_valid;
    DROP TRIGGER threads_chat_lifecycle_insert_valid;
    DROP TABLE chat_lifecycle_audit;
    ALTER TABLE threads DROP COLUMN last_user_restore_at;
    ALTER TABLE threads DROP COLUMN chat_tombstone_activity_at;
    ALTER TABLE threads DROP COLUMN chat_tombstone_reason;
    ALTER TABLE threads DROP COLUMN chat_tombstoned_at;
    ALTER TABLE threads DROP COLUMN chat_lifecycle_state;
    PRAGMA user_version = 14;
  `)
}
