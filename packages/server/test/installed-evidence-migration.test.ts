import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../src/store/db.ts'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function downgradeToV6(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE model_capability_user_overrides;
    DROP TABLE completion_probe_evidence;
    DROP TABLE installed_model_evidence_cache;
    PRAGMA user_version = 6;
  `)
}

describe('SQLite installed evidence cache migration 7', () => {
  it('creates the additive cache on a fresh DB and reopens idempotently', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-evidence-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const first = openDb(path)
    assert.equal(version(first), 9)
    assert.equal(
      (first.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name = 'installed_model_evidence_cache'`,
      ).get() as { count: number }).count,
      1,
    )
    first.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 9)
    assert.equal(
      (reopened.prepare('SELECT COUNT(*) AS count FROM installed_model_evidence_cache').get() as {
        count: number
      }).count,
      0,
    )
    reopened.close()
  })

  it('upgrades v6 without rewriting legacy tables or backfilling claims', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-evidence-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO model_calibration (
         model, context_length, size_bytes, size_vram_bytes, measured_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run('legacy:latest', 8_192, 1_000, 900, '2026-08-02T00:00:00.000Z')
    downgradeToV6(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 9)
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
    const root = await mkdtemp(join(tmpdir(), 'alamo-evidence-migration-rollback-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
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
    assert.equal(version(recovered), 9)
    recovered.close()
  })
})
