import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../src/store/db.ts'
import { downgradeRetentionLifecycleToV14 } from './fixtures/retention-lifecycle-migration.ts'
import {
  ModelCapabilityOverrideStore,
  modelCapabilityOverrideKey,
} from '../src/store/capability-override.ts'

const AT = '2026-08-07T00:00:00.000Z'
const IDENTITY = {
  provider: 'ollama' as const,
  normalizedModelReference: 'fixture:latest',
  artifactDigest: 'sha256:fixture',
  runtimeVersion: '0.12.6',
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count
}

function tables(db: DatabaseSync, name: string): number {
  return (
    db.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?`,
    ).get(name) as { count: number }
  ).count
}

function downgradeToV8(db: DatabaseSync): void {
  downgradeRetentionLifecycleToV14(db)
  db.exec(
    'DROP INDEX idx_threads_retention_policy; ALTER TABLE threads DROP COLUMN last_user_activity_source; ALTER TABLE threads DROP COLUMN last_user_activity_at; ALTER TABLE threads DROP COLUMN retention_policy_updated_at; ALTER TABLE threads DROP COLUMN retention_policy_source; ALTER TABLE threads DROP COLUMN retention_policy; DROP TRIGGER threads_project_chat_update_valid; DROP TRIGGER threads_project_chat_insert_valid; DROP TRIGGER threads_project_ownership_immutable; DROP INDEX idx_threads_project_updated; ALTER TABLE threads DROP COLUMN project_id; DROP TABLE project_filesystem_bindings; DROP TABLE projects; DROP TABLE model_capability_user_overrides; PRAGMA user_version = 8;',
  )
}

async function temporaryDbPath(test: { after: (fn: () => unknown) => void }, label: string) {
  const root = await mkdtemp(join(tmpdir(), `guanxi-override-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'guanxi.db')
}

describe('SQLite capability override migration 9', () => {
  it('creates the additive table on fresh and reopened databases', async (test) => {
    const path = await temporaryDbPath(test, 'fresh')
    const first = openDb(path)
    assert.equal(version(first), 33)
    assert.equal(tables(first, 'model_capability_user_overrides'), 1)
    assert.equal(count(first, 'model_capability_user_overrides'), 0)
    assert.equal(
      (first.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'index' AND name = 'idx_model_capability_user_overrides_identity'`,
      ).get() as { count: number }).count,
      1,
    )
    first.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 33)
    assert.equal(count(reopened, 'model_capability_user_overrides'), 0)
    reopened.close()
  })

  it('upgrades v8 without backfilling declarations or probe results', async (test) => {
    const path = await temporaryDbPath(test, 'upgrade')
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
      IDENTITY.normalizedModelReference,
      IDENTITY.artifactDigest,
      IDENTITY.runtimeVersion,
      JSON.stringify({ capabilities: ['completion', 'tools'] }),
      AT, AT, AT, '2026-08-07T00:15:00.000Z', '2026-08-14T00:15:00.000Z',
    )
    fixture.prepare(
      `INSERT INTO completion_probe_evidence (
         probe_key, key_version, probe_definition_version, provider,
         normalized_model_reference, artifact_digest, runtime_version,
         context_length, outcome, reason, source, confidence,
         observed_at, completed_at, duration_ms
       ) VALUES (?, 1, 1, 'ollama', ?, ?, ?, 8192, 'verified', 'terminal_response',
                 'runtime_probe', 'verified', ?, ?, 0)`,
    ).run(
      `sha256:${'b'.repeat(64)}`,
      IDENTITY.normalizedModelReference,
      IDENTITY.artifactDigest,
      IDENTITY.runtimeVersion,
      AT, AT,
    )
    downgradeToV8(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.equal(version(upgraded), 33)
    // Two adjacent provider/probe rows exist for the very same exact identity and
    // neither one becomes a user assertion.
    assert.equal(count(upgraded, 'installed_model_evidence_cache'), 1)
    assert.equal(count(upgraded, 'completion_probe_evidence'), 1)
    assert.equal(count(upgraded, 'model_capability_user_overrides'), 0)
    assert.equal(new ModelCapabilityOverrideStore(upgraded).list(IDENTITY).length, 0)
    upgraded.close()
  })

  it('rolls back a failed v9 transaction and recovers from unchanged v8', async (test) => {
    const path = await temporaryDbPath(test, 'recovery')
    const broken = openDb(path)
    downgradeToV8(broken)
    broken.exec('CREATE TABLE model_capability_user_overrides (blocker TEXT)')
    broken.close()

    assert.throws(() => openDb(path), /Миграция 9 не применилась/u)

    const repair = new DatabaseSync(path)
    assert.equal(version(repair), 8)
    assert.equal(
      (repair.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'index' AND name = 'idx_model_capability_user_overrides_identity'`,
      ).get() as { count: number }).count,
      0,
    )
    repair.exec('DROP TABLE model_capability_user_overrides')
    repair.close()

    const recovered = openDb(path)
    assert.equal(version(recovered), 33)
    assert.equal(count(recovered, 'model_capability_user_overrides'), 0)
    recovered.close()
  })

  it('survives a schema rollback and a reopen without losing user assertions', async (test) => {
    const path = await temporaryDbPath(test, 'rollback')
    const first = openDb(path)
    new ModelCapabilityOverrideStore(first).write({
      identity: IDENTITY,
      capability: 'tools',
      now: AT,
    })
    assert.equal(count(first, 'model_capability_user_overrides'), 1)
    // Older code sees only v8 and never touches the newer table.
    first.exec('PRAGMA user_version = 8')
    first.close()

    const legacyReader = new DatabaseSync(path)
    assert.equal(version(legacyReader), 8)
    assert.equal(count(legacyReader, 'model_capability_user_overrides'), 1)
    legacyReader.close()

    // Re-running migration 9 over an existing table must not silently drop data.
    assert.throws(() => openDb(path), /Миграция 9 не применилась/u)
    const repair = new DatabaseSync(path)
    assert.equal(count(repair, 'model_capability_user_overrides'), 1)
    repair.exec('PRAGMA user_version = 32')
    repair.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 33)
    const records = new ModelCapabilityOverrideStore(reopened).list(IDENTITY)
    assert.equal(records.length, 1)
    assert.equal(records[0]!.capability, 'tools')
    assert.equal(records[0]!.createdAt, AT)
    reopened.close()
  })

  it('keeps a UNIQUE tuple so a corrupted key cannot create a second owner', async (test) => {
    const path = await temporaryDbPath(test, 'unique')
    const db = openDb(path)
    const store = new ModelCapabilityOverrideStore(db)
    store.write({ identity: IDENTITY, capability: 'tools', now: AT })
    assert.equal(count(db, 'model_capability_user_overrides'), 1)

    // Corrupt only the primary key: the identity tuple still says `tools`, so a
    // second row for the same identity must be refused by the schema itself.
    db.prepare('UPDATE model_capability_user_overrides SET override_key = ?').run(
      `sha256:${'e'.repeat(64)}`,
    )
    assert.throws(
      () => store.write({ identity: IDENTITY, capability: 'tools', now: AT }),
      /UNIQUE/u,
    )
    assert.equal(count(db, 'model_capability_user_overrides'), 1)
    db.close()
  })

  it('rejects an incompatible row at the schema boundary', async (test) => {
    const path = await temporaryDbPath(test, 'checks')
    const db = openDb(path)
    const insert = (patch: Partial<Record<string, unknown>>) => {
      const row = {
        override_key: modelCapabilityOverrideKey(IDENTITY, 'tools'),
        key_version: 1,
        override_schema_version: 1,
        provider: 'ollama',
        normalized_model_reference: IDENTITY.normalizedModelReference,
        artifact_digest: IDENTITY.artifactDigest,
        runtime_version: IDENTITY.runtimeVersion,
        capability: 'tools',
        source: 'user_override',
        state: 'overridden',
        value: 'present',
        created_at: AT,
        updated_at: AT,
        ...patch,
      }
      db.prepare(
        `INSERT INTO model_capability_user_overrides (
           override_key, key_version, override_schema_version, provider,
           normalized_model_reference, artifact_digest, runtime_version, capability,
           source, state, value, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.override_key, row.key_version, row.override_schema_version, row.provider,
        row.normalized_model_reference, row.artifact_digest, row.runtime_version,
        row.capability, row.source, row.state, row.value, row.created_at, row.updated_at,
      )
    }
    for (const patch of [
      { override_key: 'not-a-digest' },
      { key_version: 2 },
      { override_schema_version: 2 },
      { provider: 'huggingface' },
      { normalized_model_reference: '' },
      { artifact_digest: '' },
      { runtime_version: '' },
      { capability: 'audio' },
      { source: 'ollama_api_tags' },
      { state: 'unsupported' },
      { value: 'absent' },
    ]) {
      assert.throws(() => insert(patch), Object.keys(patch).join(','))
    }
    assert.equal(count(db, 'model_capability_user_overrides'), 0)
    db.close()
  })
})
