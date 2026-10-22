import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MIGRATIONS, openDb } from '../../src/store/db.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { SessionLog } from '../../src/session-log/log.ts'

// Pins every main migration at the lane base, independently of the new migration.
const digest = '84bed9ae95d1e2e7602d51d519431e6430402ea8f489c43e6f2442c1575c4677'
test('migration 32 adopts native sessions with an atomic Thread owner; failure rolls back and retries', t => {
  const root = mkdtempSync(join(tmpdir(), 'k4-retention-migration-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'node.db'), seed = new DatabaseSync(path)
  seed.exec('PRAGMA foreign_keys=ON')
  for (const sql of MIGRATIONS.slice(0,31)) seed.exec(sql)
  seed.exec('PRAGMA user_version=31')
  let now = new Date('2026-10-01T00:00:00.000Z')
  const scrubber = new SecretScrubber(), log = new SessionLog({ db: seed, scrubber, clock: () => now })
  const handle = log.open('old-native', { kind: 'agent' })
  handle.append({ type: 'agent.policy', data: { projectId: 'fixture-project', connectionId: 'fixture-connection', model: 'fixture-model',
    retention: 'ttl', mode: 'read-only', roots: [], scratch: '/synthetic', attachments: [], domains: [], protectedPaths: [], attachmentIds: [] } as never })
  now = new Date('2026-10-20T00:00:00.000Z')
  handle.append({ type: 'prompt', data: { origin: 'typed', messageId: 'typed', text: 'fixture user input', attachmentCount: 0 } })
  now = new Date('2026-10-21T00:00:00.000Z')
  handle.append({ type: 'prompt', data: { origin: 'queued', messageId: 'queued', text: 'fixture continuation', attachmentCount: 0 } })
  handle.append({ type: 'agent.note', data: { text: 'fixture model activity' } })
  handle.close(); log.close()
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
