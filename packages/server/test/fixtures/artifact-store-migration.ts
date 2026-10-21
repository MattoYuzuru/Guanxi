import type { DatabaseSync } from 'node:sqlite'
import { downgradeSessionLogToV28 } from './session-log-migration.ts'

/** Reverse only migration 28 so migration evidence can start from exact v27. */
export function downgradeAttachmentNameHardeningToV27(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version >= 29) downgradeSessionLogToV28(db)
  db.exec(`
    DROP TRIGGER artifact_attachments_safe_name_insert;
    PRAGMA user_version = 27;
  `)
}

/** Reverse only migration 27 so migration evidence can start from exact v26. */
export function downgradeAttachmentStoreToV26(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version >= 28) downgradeAttachmentNameHardeningToV27(db)
  db.exec(`
    DROP TRIGGER artifact_attachments_immutable_delete;
    DROP TRIGGER artifact_attachments_immutable_update;
    DROP TRIGGER artifact_attachments_source_insert;
    DROP INDEX idx_artifact_attachments_created;
    DROP TABLE artifact_attachments;
    PRAGMA user_version = 26;
  `)
}

/** Reverse only migration 26 so older migration fixtures can start from exact v25. */
export function downgradeArtifactStoreToV25(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version >= 27) downgradeAttachmentStoreToV26(db)
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
