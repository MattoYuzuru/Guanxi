import type { DatabaseSync } from 'node:sqlite'
import { downgradeArtifactStoreToV25 } from './artifact-store-migration.ts'

/** Remove additive v24 objects while preserving all v23 rows byte-for-byte. */
export function downgradeContextCheckpointsToV23(db: DatabaseSync): void {
  downgradeArtifactStoreToV25(db)
  db.exec(`
    DROP TRIGGER IF EXISTS context_checkpoints_immutable_delete;
    DROP TRIGGER IF EXISTS checkpointed_messages_immutable_delete;
    DROP TRIGGER IF EXISTS checkpointed_messages_immutable_update;
    DROP TRIGGER IF EXISTS context_checkpoints_immutable_update;
    DROP TRIGGER IF EXISTS context_checkpoints_exact_source;
    DROP INDEX IF EXISTS idx_context_checkpoints_thread;
    DROP TABLE IF EXISTS context_checkpoints;
    PRAGMA user_version = 23;
  `)
}
