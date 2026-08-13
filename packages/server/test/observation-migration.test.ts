import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../src/store/db.ts'
import { downgradeRetentionLifecycleToV14 } from './fixtures/retention-lifecycle-migration.ts'

function downgradeToV5(db: DatabaseSync): void {
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
    DROP TABLE model_calibration_observations;
    PRAGMA user_version = 5;
  `)
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('SQLite exact observation-key migration 6', () => {
  it('creates the exact-key table on fresh DB and reopens idempotently', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-observation-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const first = openDb(path)
    assert.equal(version(first), 25)
    assert.equal(
      (
        first
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_schema
             WHERE type = 'table' AND name = 'model_calibration_observations'`,
          )
          .get() as { count: number }
      ).count,
      1,
    )
    first.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 25)
    assert.equal(
      (
        reopened
          .prepare('SELECT COUNT(*) AS count FROM model_calibration_observations')
          .get() as { count: number }
      ).count,
      0,
    )
    reopened.close()
  })

  it('upgrades v5 without rewriting or crediting legacy name/context rows', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-observation-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const fixture = openDb(path)
    fixture
      .prepare(
        `INSERT INTO model_calibration (
           model, context_length, size_bytes, size_vram_bytes, measured_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('legacy:latest', 8_192, 1_000, 900, '2026-08-02T00:00:00.000Z')
    downgradeToV5(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 25)
    assert.deepEqual(
      {
        ...upgraded
          .prepare(
            `SELECT model, context_length, size_bytes, size_vram_bytes, measured_at
             FROM model_calibration`,
          )
          .get(),
      },
      {
        model: 'legacy:latest',
        context_length: 8_192,
        size_bytes: 1_000,
        size_vram_bytes: 900,
        measured_at: '2026-08-02T00:00:00.000Z',
      },
    )
    assert.equal(
      (
        upgraded
          .prepare('SELECT COUNT(*) AS count FROM model_calibration_observations')
          .get() as { count: number }
      ).count,
      0,
    )
    upgraded.close()
  })

  it('rolls back a failed v6 migration and recovers from unchanged v5', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-observation-migration-recovery-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const broken = openDb(path)
    downgradeToV5(broken)
    broken.exec('CREATE TABLE model_calibration_observations (blocker TEXT)')
    broken.close()

    assert.throws(() => openDb(path), /Миграция 6 не применилась/u)

    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 5)
    assert.equal(
      (
        repair
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_schema
             WHERE type = 'index' AND name = 'idx_model_calibration_observation_family'`,
          )
          .get() as { count: number }
      ).count,
      0,
    )
    repair.exec('DROP TABLE model_calibration_observations')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 25)
    recovered.close()
  })
})
