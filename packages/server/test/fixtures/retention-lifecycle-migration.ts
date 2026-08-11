import type { DatabaseSync } from 'node:sqlite'

/** Remove only additive v15 artifacts before an older migration fixture is replayed. */
export function downgradeRetentionLifecycleToV14(db: DatabaseSync): void {
  db.exec(`
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
