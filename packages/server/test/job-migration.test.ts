import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../src/store/db.ts'

function schemaObjects(db: DatabaseSync, names: string[]): Array<{ name: string; type: string }> {
  return db
    .prepare(
      `SELECT name, type
       FROM sqlite_schema
       WHERE name IN (${names.map(() => '?').join(', ')})
       ORDER BY name`,
    )
    .all(...names) as Array<{ name: string; type: string }>
}

function downgradeToV4(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE completion_probe_evidence;
    DROP TABLE installed_model_evidence_cache;
    DROP TABLE model_calibration_observations;
    DROP TABLE chat_job_inputs;
    DROP INDEX idx_messages_job_user;
    DROP INDEX idx_messages_job;
    ALTER TABLE messages DROP COLUMN job_id;
    ALTER TABLE job_events DROP COLUMN output_privacy;
    ALTER TABLE job_events DROP COLUMN output;
    PRAGMA user_version = 4;
  `)
}

describe('SQLite durable Chat Job migration 5', () => {
  it('creates migration 5 exactly once on a fresh database and reopens idempotently', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const first = openDb(path)
    assert.deepEqual({ ...first.prepare('PRAGMA user_version').get() }, { user_version: 8 })
    assert.deepEqual(
      schemaObjects(first, [
        'jobs',
        'job_events',
        'idx_job_events_replay',
        'idx_job_events_terminal',
        'chat_job_inputs',
        'idx_chat_job_inputs_thread',
        'idx_messages_job',
        'idx_messages_job_user',
      ]).map((row) => ({ ...row })),
      [
        { name: 'chat_job_inputs', type: 'table' },
        { name: 'idx_chat_job_inputs_thread', type: 'index' },
        { name: 'idx_job_events_replay', type: 'index' },
        { name: 'idx_job_events_terminal', type: 'index' },
        { name: 'idx_messages_job', type: 'index' },
        { name: 'idx_messages_job_user', type: 'index' },
        { name: 'job_events', type: 'table' },
        { name: 'jobs', type: 'table' },
      ],
    )
    first.close()

    const reopened = openDb(path)
    assert.deepEqual({ ...reopened.prepare('PRAGMA user_version').get() }, { user_version: 8 })
    assert.equal(
      schemaObjects(reopened, ['jobs', 'job_events']).filter((row) => row.type === 'table').length,
      2,
    )
    reopened.close()
  })

  it('upgrades a v4 fixture without changing legacy threads, messages, Jobs or events', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    // Removing only additive v5 objects/columns produces an exact v4 fixture
    // without copying historical migrations into this test.
    const fixture = openDb(path)
    fixture.prepare(
      `INSERT INTO threads (
         id, title, mode, model, workspace_id, num_ctx, temperature, think,
         created_at, updated_at
       ) VALUES (?, ?, 'chat', ?, NULL, 8192, 0.7, 'off', ?, ?)`,
    ).run('thread-v3', 'Preserved thread', 'fixture-model', '2026-08-02T10:00:00.000Z', '2026-08-02T10:00:00.000Z')
    fixture.prepare(
      `INSERT INTO messages (
         id, thread_id, seq, role, content, thinking, tool_calls, usage,
         is_compaction, created_at, turn_status, turn_error, stop_reason
       ) VALUES (?, ?, 0, 'assistant', ?, NULL, '[]', NULL, 0, ?, 'failed', ?, 'protocol_error')`,
    ).run(
      'message-v3',
      'thread-v3',
      'preserved partial',
      '2026-08-02T10:00:01.000Z',
      JSON.stringify({ code: 'runtime_protocol', message: 'safe fixture error' }),
    )
    fixture.prepare(
      `INSERT INTO jobs (
         id, kind, operation, status, phase, idempotency_scope, idempotency_key,
         created_at, started_at, finished_at, error, outcome, stop_reason,
         last_event_sequence
       ) VALUES ('legacy-job', 'inference', 'legacy', 'queued', NULL, 'legacy',
         'key', ?, NULL, NULL, NULL, NULL, NULL, 1)`,
    ).run('2026-08-02T10:00:02.000Z')
    fixture.prepare(
      `INSERT INTO job_events (
         id, job_id, sequence, type, state, phase, metadata, output,
         output_privacy, created_at
       ) VALUES ('legacy-event', 'legacy-job', 1, 'lifecycle', 'queued', NULL,
         '{}', NULL, NULL, ?)`,
    ).run('2026-08-02T10:00:02.000Z')
    downgradeToV4(fixture)
    fixture.close()

    const upgraded = openDb(path)
    assert.deepEqual({ ...upgraded.prepare('PRAGMA user_version').get() }, { user_version: 8 })
    assert.deepEqual(
      {
        ...upgraded.prepare('SELECT id, title, mode, model FROM threads WHERE id = ?').get('thread-v3'),
      },
      { id: 'thread-v3', title: 'Preserved thread', mode: 'chat', model: 'fixture-model' },
    )
    assert.deepEqual(
      {
        ...upgraded
          .prepare(
            `SELECT id, thread_id, content, turn_status, stop_reason, job_id
             FROM messages WHERE id = ?`,
          )
          .get('message-v3'),
      },
      {
        id: 'message-v3',
        thread_id: 'thread-v3',
        content: 'preserved partial',
        turn_status: 'failed',
        stop_reason: 'protocol_error',
        job_id: null,
      },
    )
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      1,
    )
    assert.deepEqual(
      {
        ...upgraded
          .prepare('SELECT output, output_privacy FROM job_events WHERE id = ?')
          .get('legacy-event'),
      },
      { output: null, output_privacy: null },
    )
    upgraded.close()
  })

  it('rolls back a failed v5 migration and recovers from unchanged version 4', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-migration-recovery-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const broken = openDb(path)
    downgradeToV4(broken)
    broken.exec('CREATE TABLE chat_job_inputs (blocker TEXT)')
    broken.close()

    assert.throws(() => openDb(path), /Миграция 5 не применилась/)

    const repair = new DatabaseSync(path)
    assert.deepEqual({ ...repair.prepare('PRAGMA user_version').get() }, { user_version: 4 })
    assert.equal(
      (repair.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('messages') WHERE name = 'job_id'").get() as { count: number }).count,
      0,
    )
    repair.exec('DROP TABLE chat_job_inputs')
    repair.close()

    const recovered = openDb(path)
    assert.deepEqual({ ...recovered.prepare('PRAGMA user_version').get() }, { user_version: 8 })
    assert.equal(schemaObjects(recovered, ['jobs', 'job_events', 'chat_job_inputs']).length, 3)
    recovered.close()
  })
})
