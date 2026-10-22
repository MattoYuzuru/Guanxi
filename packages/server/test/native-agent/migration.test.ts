import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MIGRATIONS, openDb } from '../../src/store/db.ts'

// Pins every main migration at the lane base, independently of the new migration.
const digest = '84bed9ae95d1e2e7602d51d519431e6430402ea8f489c43e6f2442c1575c4677'
const CREATED = '2026-10-01T00:00:00.000Z'
const TYPED = '2026-10-20T00:00:00.000Z'
const CONTINUED = '2026-10-21T00:00:00.000Z'

interface HistoricalEvent {
  seq: number
  id: string
  type: 'agent.policy' | 'prompt' | 'agent.note'
  data: Record<string, unknown>
  createdAt: string
  searchText: string | null
}

/**
 * Seeds the pre-32 database through the real placement/policy/head/FTS triggers.
 * This is deliberate test-local SQL: a current SessionLog requires global 33 and
 * must install independent ledger 40, so it cannot write a historical global-31
 * fixture. No trigger is dropped or relaxed and the head advances by itself.
 */
function seedHistoricalLog(seed: DatabaseSync): void {
  seed.exec('BEGIN')
  try {
    seed.prepare('INSERT INTO sessions (id, kind, thread_id, created_at, last_seq) VALUES (?, ?, ?, ?, ?)')
      .run('old-native', 'agent', null, CREATED, 0)
    seed.prepare(
      `INSERT INTO session_writers
         (session_id, writer_id, epoch, pid, host, acquired_at, renewed_at, expires_at, released_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    ).run('old-native', 'fixture-writer', 1, CREATED, CREATED, '2026-10-01T00:10:00.000Z')

    const events: HistoricalEvent[] = [
      {
        seq: 1,
        id: '11111111-1111-4111-8111-111111111111',
        type: 'agent.policy',
        data: {
          projectId: 'fixture-project',
          connectionId: 'fixture-connection',
          model: 'fixture-model',
          retention: 'ttl',
          mode: 'read-only',
          roots: [],
          scratch: '/synthetic',
          attachments: [],
          domains: [],
          protectedPaths: [],
          attachmentIds: [],
        },
        createdAt: CREATED,
        searchText: null,
      },
      {
        seq: 2,
        id: '22222222-2222-4222-8222-222222222222',
        type: 'prompt',
        data: { origin: 'typed', messageId: 'typed', text: 'fixture user input', attachmentCount: 0 },
        createdAt: TYPED,
        searchText: 'fixture user input',
      },
      {
        seq: 3,
        id: '33333333-3333-4333-8333-333333333333',
        type: 'prompt',
        data: { origin: 'queued', messageId: 'queued', text: 'fixture continuation', attachmentCount: 0 },
        createdAt: CONTINUED,
        searchText: 'fixture continuation',
      },
      {
        seq: 4,
        id: '44444444-4444-4444-8444-444444444444',
        type: 'agent.note',
        data: { text: 'fixture model activity' },
        createdAt: CONTINUED,
        searchText: null,
      },
    ]
    const insert = seed.prepare(
      `INSERT INTO session_events
         (session_id, seq, id, event_version, type, class, writer_epoch, payload, payload_sha256,
          search_text, redactions, created_at, expires_at, purged_at)
       VALUES (?, ?, ?, 1, ?, 'standard', 1, ?, ?, ?, 0, ?, NULL, NULL)`,
    )
    for (const event of events) {
      const payload = JSON.stringify(event.data)
      insert.run(
        'old-native',
        event.seq,
        event.id,
        event.type,
        payload,
        createHash('sha256').update(payload).digest('hex'),
        event.searchText,
        event.createdAt,
      )
    }
    seed.prepare('UPDATE session_writers SET released_at = ? WHERE session_id = ?')
      .run('2026-10-21T00:00:01.000Z', 'old-native')
    seed.exec('COMMIT')
  } catch (error) {
    seed.exec('ROLLBACK')
    throw error
  }
}

test('migration 32 adopts native sessions with an atomic Thread owner; failure rolls back and retries', t => {
  const root = mkdtempSync(join(tmpdir(), 'k4-retention-migration-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'node.db'), seed = new DatabaseSync(path)
  seed.exec('PRAGMA foreign_keys=ON')
  for (const sql of MIGRATIONS.slice(0,31)) seed.exec(sql)
  seed.exec('PRAGMA user_version=31')
  seedHistoricalLog(seed)
  const before = seed.prepare('SELECT seq,payload,payload_sha256 FROM session_events ORDER BY seq').all()
  seed.exec('CREATE TABLE native_sessions(collision TEXT)'); seed.close()
  assert.throws(() => openDb(path), /Миграция 32/u)
  const repair = new DatabaseSync(path)
  assert.equal(repair.prepare('PRAGMA user_version').get()!.user_version, 31)
  assert.equal(repair.prepare("SELECT 1 FROM sqlite_master WHERE name='run_execution'").get(), undefined)
  repair.exec('DROP TABLE native_sessions'); repair.close()
  const db = openDb(path)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 33)
    assert.deepEqual(db.prepare('SELECT seq,payload,payload_sha256 FROM session_events ORDER BY seq').all(), before)
    assert.equal(db.prepare('SELECT thread_id FROM sessions WHERE id=?').get('old-native')!.thread_id, 'old-native')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_sessions').get()!.n, 1)
    const owner = db.prepare('SELECT last_user_activity_at,last_user_activity_source FROM threads WHERE id=?').get('old-native')!
    assert.equal(owner.last_user_activity_at, '2026-10-20T00:00:00.000Z', 'adoption preserves recent typed activity without extending it for model or queued work')
    assert.equal(owner.last_user_activity_source, 'user_message')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(createHash('sha256').update(JSON.stringify(MIGRATIONS.slice(0,31))).digest('hex'), digest)
  } finally { db.close() }
  const reopened = openDb(path); assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM native_sessions').get()!.n, 1); reopened.close()
})
