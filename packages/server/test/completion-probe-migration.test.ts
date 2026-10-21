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

function downgradeToV7(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
  db.exec(
    'DROP INDEX idx_threads_retention_policy; ALTER TABLE threads DROP COLUMN last_user_activity_source; ALTER TABLE threads DROP COLUMN last_user_activity_at; ALTER TABLE threads DROP COLUMN retention_policy_updated_at; ALTER TABLE threads DROP COLUMN retention_policy_source; ALTER TABLE threads DROP COLUMN retention_policy; DROP TRIGGER threads_project_chat_update_valid; DROP TRIGGER threads_project_chat_insert_valid; DROP TRIGGER threads_project_ownership_immutable; DROP INDEX idx_threads_project_updated; ALTER TABLE threads DROP COLUMN project_id; DROP TABLE project_filesystem_bindings; DROP TABLE projects; DROP TABLE model_capability_user_overrides; DROP TABLE completion_probe_evidence; PRAGMA user_version = 7;',
  )
}

describe('SQLite completion probe migration 8', () => {
  it('creates the additive probe table on fresh and reopened databases', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-probe-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const first = openDb(path)
    assert.equal(version(first), 31)
    assert.equal(
      (first.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name = 'completion_probe_evidence'`,
      ).get() as { count: number }).count,
      1,
    )
    first.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 31)
    assert.equal(
      (reopened.prepare('SELECT COUNT(*) AS count FROM completion_probe_evidence').get() as {
        count: number
      }).count,
      0,
    )
    reopened.close()
  })

  it('upgrades v7 without backfilling provider declarations', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-probe-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO installed_model_evidence_cache (
         cache_key, key_version, evidence_schema_version, provider,
         normalized_model_reference, artifact_digest, runtime_version,
         safe_evidence_json, observed_at, fetched_at, validated_at,
         expires_at, stale_until
       ) VALUES (?, 1, 1, 'ollama', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `sha256:${'a'.repeat(64)}`,
      'fixture:latest',
      'sha256:fixture',
      '0.12.6',
      JSON.stringify({ capabilities: ['completion'] }),
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:15:00.000Z',
      '2026-08-10T00:15:00.000Z',
    )
    downgradeToV7(fixture)
    fixture.close()
    const upgraded = openDb(path)
    assert.equal(version(upgraded), 31)
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM completion_probe_evidence').get() as {
        count: number
      }).count,
      0,
    )
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      1,
    )
    upgraded.close()
  })

  it('rolls back a failed v8 transaction and recovers from unchanged v7', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-probe-migration-recovery-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const broken = openDb(path)
    downgradeToV7(broken)
    broken.exec('CREATE TABLE completion_probe_evidence (blocker TEXT)')
    broken.close()
    assert.throws(() => openDb(path), /Миграция 8 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 7)
    assert.equal(
      (repair.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'index' AND name = 'idx_completion_probe_evidence_family'`,
      ).get() as { count: number }).count,
      0,
    )
    repair.exec('DROP TABLE completion_probe_evidence')
    repair.close()
    const recovered = openDb(path)
    assert.equal(version(recovered), 31)
    recovered.close()
  })
})
