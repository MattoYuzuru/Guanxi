import type { DatabaseSync } from 'node:sqlite'

/** Reverse only migration 26 so older migration fixtures can start from exact v25. */
export function downgradeArtifactStoreToV25(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER referenced_artifact_blobs_delete;
    DROP TRIGGER artifact_blobs_immutable_update;
    DROP TRIGGER artifacts_immutable_delete;
    DROP TRIGGER artifacts_immutable_update;
    DROP TRIGGER artifact_recipe_job_scope_insert;
    DROP TRIGGER artifact_chat_job_scope_insert;
    DROP TRIGGER artifacts_job_scope_insert;
    DROP TRIGGER artifacts_parent_scope_insert;
    DROP INDEX idx_artifacts_parent;
    DROP INDEX idx_artifacts_job;
    DROP INDEX idx_artifacts_project;
    DROP INDEX idx_artifacts_blob;
    DROP TABLE artifacts;
    DROP TABLE artifact_blobs;
    PRAGMA user_version = 25;
  `)
}
