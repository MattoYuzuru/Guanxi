import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb } from '../src/store/db.ts'

const VERSION_2_MESSAGES = `
  CREATE TABLE workspaces (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    root_path    TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE threads (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('chat','agent')),
    model        TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    num_ctx      INTEGER NOT NULL,
    temperature  REAL NOT NULL,
    think        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
  CREATE TABLE messages (
    id            TEXT PRIMARY KEY,
    thread_id     TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content       TEXT NOT NULL,
    thinking      TEXT,
    tool_calls    TEXT NOT NULL DEFAULT '[]',
    usage         TEXT,
    is_compaction INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_messages_thread_seq ON messages(thread_id, seq);
`

function insertVersion2Message(
  db: DatabaseSync,
  input: {
    id: string
    seq: number
    content: string
    usage: string | null
  },
): void {
  db.prepare(
    `INSERT INTO messages (
       id, thread_id, seq, role, content, thinking, tool_calls, usage,
       is_compaction, created_at
     )
     VALUES (?, 'thread-1', ?, 'assistant', ?, NULL, '[]', ?, 0, ?)`,
  ).run(input.id, input.seq, input.content, input.usage, '2026-08-02T12:00:00.000Z')
}

describe('SQLite turn-state migration', () => {
  it('keeps the v3 turn-state bridge on a fresh current database', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-migration-fresh-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const db = openDb(path)
    test.after(() => db.close())

    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    assert.equal(version.user_version, 23)
    assert.deepEqual(
      columns
        .map((column) => column.name)
        .filter((name) => name.startsWith('turn_') || name === 'stop_reason'),
      ['turn_status', 'turn_error', 'stop_reason'],
    )
  })

  it('upgrades v2 with evidence-based backfill and keeps old writes readable', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-migration-upgrade-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const previous = new DatabaseSync(path)
    previous.exec(VERSION_2_MESSAGES)
    insertVersion2Message(previous, {
      id: 'terminal-evidence',
      seq: 0,
      content: 'answer',
      usage: JSON.stringify({ promptTokens: 12 }),
    })
    insertVersion2Message(previous, {
      id: 'ambiguous-empty',
      seq: 1,
      content: '',
      usage: null,
    })
    insertVersion2Message(previous, {
      id: 'ambiguous-partial',
      seq: 2,
      content: 'partial',
      usage: null,
    })
    previous.exec('PRAGMA user_version = 2')
    previous.close()

    const upgraded = openDb(path)
    test.after(() => upgraded.close())
    const rows = upgraded
      .prepare(
        `SELECT id, turn_status, turn_error, stop_reason
         FROM messages
         ORDER BY seq`,
      )
      .all() as Array<{
      id: string
      turn_status: string | null
      turn_error: string | null
      stop_reason: string | null
    }>

    assert.deepEqual(rows.map((row) => ({ ...row })), [
      {
        id: 'terminal-evidence',
        turn_status: 'completed',
        turn_error: null,
        stop_reason: 'legacy_terminal_chunk',
      },
      {
        id: 'ambiguous-empty',
        turn_status: null,
        turn_error: null,
        stop_reason: null,
      },
      {
        id: 'ambiguous-partial',
        turn_status: null,
        turn_error: null,
        stop_reason: null,
      },
    ])

    // A rolled-back v2 binary omits additive columns on INSERT and SELECT.
    insertVersion2Message(upgraded, {
      id: 'old-code-write',
      seq: 3,
      content: 'written after code rollback',
      usage: null,
    })
    const oldProjection = upgraded
      .prepare('SELECT id, content, usage FROM messages WHERE id = ?')
      .get('old-code-write') as { id: string; content: string; usage: string | null }
    const bridgeProjection = upgraded
      .prepare('SELECT turn_status FROM messages WHERE id = ?')
      .get('old-code-write') as { turn_status: string | null }
    assert.equal(oldProjection.content, 'written after code rollback')
    assert.equal(bridgeProjection.turn_status, null)
  })

  it('rolls back a failed v3 migration and can recover from the unchanged v2 version', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-migration-recovery-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')

    const broken = new DatabaseSync(path)
    broken.exec('PRAGMA user_version = 2')
    broken.close()

    assert.throws(() => openDb(path), /Миграция 3 не применилась/)

    const repair = new DatabaseSync(path)
    const afterFailure = repair.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(afterFailure.user_version, 2)
    repair.exec(VERSION_2_MESSAGES)
    repair.close()

    const recovered = openDb(path)
    const version = recovered.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(version.user_version, 23)
    recovered.close()
  })
})
