import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../src/store/db.ts'
import { downgradeRetentionLifecycleToV14 } from './fixtures/retention-lifecycle-migration.ts'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function downgradeToV6(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
  db.exec(`
    DROP INDEX idx_threads_retention_policy;
    ALTER TABLE threads DROP COLUMN last_user_activity_source;
    ALTER TABLE threads DROP COLUMN last_user_activity_at;
    ALTER TABLE threads DROP COLUMN retention_policy_updated_at;
    ALTER TABLE threads DROP COLUMN retention_policy_source;
    ALTER TABLE threads DROP COLUMN retention_policy;
    DROP TRIGGER threads_project_chat_update_valid;
    DROP TRIGGER threads_project_chat_insert_valid;
    DROP TRIGGER threads_project_ownership_immutable;
    DROP INDEX idx_threads_project_updated;
    ALTER TABLE threads DROP COLUMN project_id;
    DROP TABLE project_filesystem_bindings;
    DROP TABLE projects;
    DROP TABLE model_capability_user_overrides;
    DROP TABLE completion_probe_evidence;
    DROP TABLE installed_model_evidence_cache;
    PRAGMA user_version = 6;
  `)
}

describe('SQLite installed evidence cache migration 7', () => {
  it('creates the additive cache on a fresh DB and reopens idempotently', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-evidence-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')

    const first = openDb(path)
    assert.equal(version(first), 32)
    assert.equal(
      (first.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name = 'installed_model_evidence_cache'`,
      ).get() as { count: number }).count,
      1,
    )
    first.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 32)
    assert.equal(
      (reopened.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      0,
    )
    reopened.close()
  })

  it('upgrades v6 without rewriting legacy tables or backfilling claims', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-evidence-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO model_calibration (
         model, context_length, size_bytes, size_vram_bytes, measured_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run('legacy:latest', 8_192, 1_000, 900, '2026-08-02T00:00:00.000Z')
    downgradeToV6(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 32)
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      0,
    )
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM model_calibration').get() as {
        count: number
      }).count,
      1,
    )
    upgraded.close()
  })

  it('rolls back a failed v7 migration and recovers from unchanged v6', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-evidence-migration-rollback-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const broken = openDb(path)
    downgradeToV6(broken)
    broken.exec('CREATE TABLE installed_model_evidence_cache (blocker TEXT)')
    broken.close()

    assert.throws(() => openDb(path), /Миграция 7 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 6)
    assert.equal(
      (repair.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'index' AND name = 'idx_installed_model_evidence_family'`,
      ).get() as { count: number }).count,
      0,
    )
    repair.exec('DROP TABLE installed_model_evidence_cache')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 32)
    recovered.close()
  })
})
