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

describe('SQLite durable Job migration 4', () => {
  it('creates migration 4 exactly once on a fresh database and reopens idempotently', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const first = openDb(path)
    assert.deepEqual({ ...first.prepare('PRAGMA user_version').get() }, { user_version: 4 })
    assert.deepEqual(
      schemaObjects(first, [
        'jobs',
        'job_events',
        'idx_job_events_replay',
        'idx_job_events_terminal',
      ]).map((row) => ({ ...row })),
      [
        { name: 'idx_job_events_replay', type: 'index' },
        { name: 'idx_job_events_terminal', type: 'index' },
        { name: 'job_events', type: 'table' },
        { name: 'jobs', type: 'table' },
      ],
    )
    first.close()

    const reopened = openDb(path)
    assert.deepEqual({ ...reopened.prepare('PRAGMA user_version').get() }, { user_version: 4 })
    assert.equal(
      schemaObjects(reopened, ['jobs', 'job_events']).filter((row) => row.type === 'table').length,
      2,
    )
    reopened.close()
  })

  it('upgrades a v3 fixture without changing existing threads or messages', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    // Removing only the additive v4 objects from a current empty DB produces the
    // exact v3 application schema without duplicating migrations 1-3 in a test.
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
    fixture.exec('DROP TABLE job_events; DROP TABLE jobs; PRAGMA user_version = 3')
    fixture.close()

    const upgraded = openDb(path)
    assert.deepEqual({ ...upgraded.prepare('PRAGMA user_version').get() }, { user_version: 4 })
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
            `SELECT id, thread_id, content, turn_status, stop_reason
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
      },
    )
    assert.equal(
      (upgraded.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      0,
    )
    upgraded.close()
  })

  it('rolls back a failed v4 migration and recovers from unchanged version 3', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-migration-recovery-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const broken = new DatabaseSync(path)
    broken.exec('CREATE TABLE jobs (blocker TEXT); PRAGMA user_version = 3')
    broken.close()

    assert.throws(() => openDb(path), /Миграция 4 не применилась/)

    const repair = new DatabaseSync(path)
    assert.deepEqual({ ...repair.prepare('PRAGMA user_version').get() }, { user_version: 3 })
    assert.equal(schemaObjects(repair, ['job_events']).length, 0)
    repair.exec('DROP TABLE jobs')
    repair.close()

    const recovered = openDb(path)
    assert.deepEqual({ ...recovered.prepare('PRAGMA user_version').get() }, { user_version: 4 })
    assert.equal(schemaObjects(recovered, ['jobs', 'job_events']).length, 2)
    recovered.close()
  })
})
