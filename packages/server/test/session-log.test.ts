/**
 * K2 session log: single writer, idempotent append, database-enforced
 * append-only shape, reasoning retention, FTS5 search, scrubbing at write and
 * read, and the additive migration. Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createKernel } from '@guanxi/kernel'
import { sessionEventSchema, type SessionEvent } from '@guanxi/contract'
import { egressScrubberPlugin } from '../src/egress/index.ts'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { bootServerKernel, SESSION_LOG_LAYER, LEGACY_SERVER_PROFILE } from '../src/runtime/kernel.ts'
import {
  SESSION_LOG_SERVICE,
  SessionLog,
  SessionLogError,
  createSessionLogPlugin,
  literalFtsQuery,
  type SessionLogOptions,
} from '../src/session-log/index.ts'
import { MIGRATIONS, openDb, type Db } from '../src/store/db.ts'
import { orderedRows } from './fixtures/table-rows.ts'
import { SESSION_LOG_TABLES, downgradeSessionLogToV28 } from './fixtures/session-log-migration.ts'

const T0 = Date.parse('2026-10-20T10:00:00.000Z')

function fakeSecret(): string {
  return `fake-${randomBytes(12).toString('hex')}`
}

function clockAt(start = T0): { now: () => Date; advance(ms: number): void } {
  let current = start
  return { now: () => new Date(current), advance: (ms) => { current += ms } }
}

function logFor(db: Db, options: Partial<SessionLogOptions> = {}): SessionLog {
  return new SessionLog({ db, scrubber: new SecretScrubber(), ...options })
}

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError, `expected SessionLogError, got ${String(error)}`)
    return error.code
  }
  assert.fail('expected the call to throw')
}

function prompt(text: string) {
  return { type: 'prompt' as const, data: { origin: 'typed' as const, messageId: 'm1', text, attachmentCount: 0 } }
}

function rows(db: Db, sessionId: string): { seq: number; type: string; writer_epoch: number }[] {
  return db
    .prepare('SELECT seq, type, writer_epoch FROM session_events WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as unknown as { seq: number; type: string; writer_epoch: number }[]
}

describe('session log: append and read', () => {
  it('starts a session with session.created and writer.acquired, then appends contiguous seqs', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    const handle = log.open('s-1', { kind: 'agent' })
    assert.equal(handle.epoch, 1)
    for (let index = 0; index < 5; index++) handle.append(prompt(`prompt ${index}`))
    assert.deepEqual(rows(db, 's-1').map((row) => row.seq), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(rows(db, 's-1').slice(0, 2).map((row) => row.type), ['session.created', 'writer.acquired'])
    const page = log.read('s-1', { afterSeq: 2, limit: 3, audience: 'person' })
    assert.deepEqual(page.events.map((event) => event.seq), [3, 4, 5])
    assert.equal(page.hasMore, true)
    assert.equal(page.lastSeq, 7)
    for (const event of log.readAll('s-1', 'person')) assert.ok(sessionEventSchema.safeParse(event).success)
  })

  it('returns the stored event for a retried idempotency key or expected seq, never a duplicate', () => {
    const db = openDb(':memory:')
    const handle = logFor(db).open('s-idem', { kind: 'agent' })
    const first = handle.append(prompt('once'), { idempotencyKey: 'k-1' })
    const retry = handle.append(prompt('once'), { idempotencyKey: 'k-1' })
    assert.equal(first.duplicate, false)
    assert.equal(retry.duplicate, true)
    assert.equal(retry.event.id, first.event.id)
    assert.equal(code(() => handle.append(prompt('different'), { idempotencyKey: 'k-1' })), 'idempotency_conflict')

    const next = handle.append(prompt('by seq'), { expectedSeq: first.event.seq + 1 })
    assert.equal(handle.append(prompt('by seq'), { expectedSeq: next.event.seq }).duplicate, true)
    assert.equal(code(() => handle.append(prompt('other'), { expectedSeq: next.event.seq })), 'sequence_conflict')
    assert.equal(code(() => handle.append(prompt('gap'), { expectedSeq: next.event.seq + 2 })), 'sequence_conflict')
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = 's-idem' AND type = 'prompt'").get() as { n: number }).n,
      2,
    )
  })

  it('refuses invalid event data before anything is written', () => {
    const db = openDb(':memory:')
    const handle = logFor(db).open('s-invalid', { kind: 'agent' })
    const before = rows(db, 's-invalid').length
    assert.equal(
      code(() => handle.append({ type: 'prompt', data: { origin: 'typed', text: 'missing id' } as never })),
      'invalid_event',
    )
    assert.equal(code(() => handle.append({ type: 'nope' as never, data: {} as never })), 'invalid_event')
    assert.equal(rows(db, 's-invalid').length, before)
  })

  it('detects a stored payload that no longer matches its checksum', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    log.open('s-sum', { kind: 'agent' }).append(prompt('intact'))
    db.exec('DROP TRIGGER session_events_append_only_update')
    db.prepare("UPDATE session_events SET payload = replace(payload, 'intact', 'forged') WHERE type = 'prompt'").run()
    assert.equal(code(() => log.readAll('s-sum', 'person')), 'stored_data_invalid')
  })
})

describe('session log: single writer (D-116)', () => {
  it('allows one handle per session per process', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    const handle = log.open('s-one', { kind: 'agent' })
    assert.equal(code(() => log.open('s-one', { kind: 'agent' })), 'writer_busy')
    handle.close()
    assert.equal(log.open('s-one', { kind: 'agent' }).epoch, 2, 'a released writer is replaced by the next epoch')
  })

  it('fences a second writer until the first releases, expires or its process is gone', () => {
    const db = openDb(':memory:')
    const clock = clockAt()
    const first = logFor(db, { clock: clock.now, writerTtlMs: 10_000 })
    const handle = first.open('s-fence', { kind: 'agent' })
    handle.append(prompt('first writer'))

    const second = logFor(db, { clock: clock.now, writerTtlMs: 10_000 })
    assert.equal(code(() => second.open('s-fence', { kind: 'agent' })), 'writer_busy')

    clock.advance(10_001)
    const taken = second.open('s-fence', { kind: 'agent' })
    assert.equal(taken.epoch, 2)
    assert.equal(code(() => handle.append(prompt('stale writer'))), 'writer_fenced')
    taken.append(prompt('second writer'))

    const acquired = second.readAll('s-fence', 'person').filter((event) => event.type === 'writer.acquired')
    assert.deepEqual(
      acquired.map((event) => event.type === 'writer.acquired' && [event.data.epoch, event.data.previousEpoch, event.data.reason]),
      [[1, null, 'initial'], [2, 1, 'expired']],
    )
    assert.deepEqual(
      rows(db, 's-fence').filter((row) => row.type === 'prompt').map((row) => row.writer_epoch),
      [1, 2],
      'every event records the epoch that appended it',
    )
    assert.equal(rows(db, 's-fence').some((row) => row.type === 'prompt' && row.writer_epoch === 1 && row.seq > 3), false)
  })

  it('hands over at once from a writer whose process is gone, and never from a live one', () => {
    const db = openDb(':memory:')
    const dead = new Set<number>()
    const alive = (pid: number) => !dead.has(pid)
    const crashed = logFor(db, { writer: { id: 'w-crashed', pid: 40_001, host: 'node-a' }, isProcessAlive: alive })
    crashed.open('s-gone', { kind: 'agent' })
    const next = logFor(db, { writer: { id: 'w-next', pid: 40_002, host: 'node-a' }, isProcessAlive: alive })
    assert.equal(code(() => next.open('s-gone', { kind: 'agent' })), 'writer_busy', 'a live writer keeps the session')
    dead.add(40_001)
    const handle = next.open('s-gone', { kind: 'agent' })
    assert.equal(handle.epoch, 2)
    const last = next.readAll('s-gone', 'person').at(-1)!
    assert.equal(last.type === 'writer.acquired' && last.data.reason, 'writer_process_gone')
  })

  it('judges liveness by process, not host name, and treats an earlier incarnation of this PID as gone', () => {
    const db = openDb(':memory:')
    // The host name changed (macOS follows the network); the old process is gone.
    const before = logFor(db, { writer: { id: 'w-before', pid: 40_010, host: 'mac.local' }, isProcessAlive: () => false })
    before.open('s-host', { kind: 'agent' })
    const after = logFor(db, { writer: { id: 'w-after', pid: 40_011, host: 'mac.home' }, isProcessAlive: () => false })
    assert.equal(after.open('s-host', { kind: 'agent' }).epoch, 2)

    // A container restart reuses PID 1: a row with this PID but a writer id no live log holds is gone.
    db.exec("INSERT INTO sessions (id, kind, thread_id, created_at, last_seq) VALUES ('s-pid', 'agent', NULL, '2026-10-20T10:00:00.000Z', 0)")
    db.prepare(
      `INSERT INTO session_writers (session_id, writer_id, epoch, pid, host, acquired_at, renewed_at, expires_at, released_at)
       VALUES ('s-pid', 'w-previous-incarnation', 1, ?, 'node', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL)`,
    ).run(process.pid)
    const restarted = logFor(db, { writer: { id: 'w-restarted', pid: process.pid, host: 'node' }, isProcessAlive: () => true })
    const handle = restarted.open('s-pid', { kind: 'agent' })
    assert.equal(handle.epoch, 2)
    const reason = restarted.readAll('s-pid', 'person').at(-1)!
    assert.equal(reason.type === 'writer.acquired' && reason.data.reason, 'writer_process_gone')

    // A writer id that is live in this process keeps its session, even with the same PID.
    const sibling = logFor(db, { writer: { id: 'w-sibling', pid: process.pid, host: 'node' }, isProcessAlive: () => true })
    assert.equal(code(() => sibling.open('s-pid', { kind: 'agent' })), 'writer_busy')
  })

  it('renews a handle on append, so a second writer cannot take over a busy session', () => {
    const db = openDb(':memory:')
    const clock = clockAt()
    const first = logFor(db, { clock: clock.now, writerTtlMs: 30_000 })
    const handle = first.open('s-renew', { kind: 'agent' })
    clock.advance(20_000)
    handle.append(prompt('still here'))
    clock.advance(15_000)
    const second = logFor(db, { clock: clock.now, writerTtlMs: 30_000, isProcessAlive: () => true })
    assert.equal(code(() => second.open('s-renew', { kind: 'agent' })), 'writer_busy', 'the append at T+20 s renewed the row')
    clock.advance(30_000)
    assert.equal(second.open('s-renew', { kind: 'agent' }).epoch, 2, 'an idle handle still expires')
  })

  it('refuses in the database an event whose epoch is not the current writer epoch', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    log.open('s-db', { kind: 'agent' }).append(prompt('ok'))
    const head = (db.prepare("SELECT last_seq FROM sessions WHERE id = 's-db'").get() as { last_seq: number }).last_seq
    const insert = (epoch: number) =>
      db.prepare(
        `INSERT INTO session_events (session_id, seq, id, event_version, type, class, writer_epoch, payload, payload_sha256, created_at)
         VALUES ('s-db', ?, ?, 1, 'prompt', 'standard', ?, '{}', ?, '2026-10-20T10:00:00.000Z')`,
      ).run(head + 1, crypto.randomUUID(), epoch, createHash('sha256').update('{}').digest('hex'))
    assert.throws(() => insert(7), /current writer/)
    db.prepare("UPDATE session_writers SET released_at = '2026-10-20T10:00:00.000Z' WHERE session_id = 's-db'").run()
    assert.throws(() => insert(1), /current writer/, 'a released epoch cannot append')
    assert.throws(
      () => db.prepare("UPDATE session_writers SET released_at = NULL WHERE session_id = 's-db'").run(),
      /released epoch cannot resume/,
    )
    assert.throws(() => db.prepare("DELETE FROM session_writers WHERE session_id = 's-db'").run(), /only with its session/)
    assert.equal((db.prepare("SELECT last_seq FROM sessions WHERE id = 's-db'").get() as { last_seq: number }).last_seq, head)
  })

  it('keeps the system writer and an open handle exclusive', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    const handle = log.open('s-mixed', { kind: 'chat' })
    db.exec('BEGIN IMMEDIATE')
    assert.equal(code(() => log.appendAsSystemWithin('s-mixed', { kind: 'chat' }, prompt('mirror'))), 'writer_busy')
    db.exec('ROLLBACK')
    handle.close()
    db.exec('BEGIN IMMEDIATE')
    log.appendAsSystemWithin('s-mixed', { kind: 'chat' }, prompt('mirror'))
    db.exec('COMMIT')
    assert.equal(code(() => log.open('s-mixed', { kind: 'chat' })), 'writer_busy')
  })

  it('releases every writer row on close', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    log.open('s-a', { kind: 'agent' })
    db.exec('BEGIN IMMEDIATE')
    log.appendAsSystemWithin('s-b', { kind: 'agent' }, prompt('system'))
    db.exec('COMMIT')
    log.close()
    const open = db.prepare('SELECT COUNT(*) AS n FROM session_writers WHERE released_at IS NULL').get() as { n: number }
    assert.equal(open.n, 0)
    assert.equal(code(() => log.open('s-c', { kind: 'agent' })), 'closed')
  })
})

describe('session log: append-only schema', () => {
  it('refuses updates and deletes of events, and head moves other than +1', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    log.open('s-ro', { kind: 'agent' }).append(prompt('immutable'))
    assert.throws(() => db.prepare("UPDATE session_events SET payload = '{}' WHERE type = 'prompt'").run(), /append-only/)
    assert.throws(() => db.prepare("UPDATE session_events SET type = 'error' WHERE seq = 1").run(), /append-only/)
    assert.throws(() => db.prepare('DELETE FROM session_events').run(), /append-only/)
    assert.throws(() => db.prepare("UPDATE sessions SET last_seq = last_seq + 1 WHERE id = 's-ro'").run(), /next event/, 'no head move without an event')
    assert.throws(() => db.prepare("UPDATE sessions SET last_seq = last_seq + 2 WHERE id = 's-ro'").run(), /next event/)
    assert.throws(() => db.prepare("UPDATE sessions SET last_seq = last_seq - 1 WHERE id = 's-ro'").run(), /next event/)
    assert.throws(() => db.prepare("UPDATE sessions SET kind = 'chat' WHERE id = 's-ro'").run(), /immutable/)
    assert.throws(() => db.prepare("DELETE FROM sessions WHERE id = 's-ro'").run(), /only with its Thread/)
    assert.throws(
      () => db.prepare("UPDATE session_writers SET writer_id = 'other' WHERE session_id = 's-ro'").run(),
      /next epoch/,
    )
    assert.throws(
      () => db.prepare("UPDATE session_writers SET writer_id = 'other', epoch = epoch + 2 WHERE session_id = 's-ro'").run(),
      /next epoch/,
    )
  })

  it('refuses an event inserted at any seq but the next one, and events that break the policy', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    const handle = log.open('s-head', { kind: 'agent' })
    handle.append(prompt('one'))
    const sum = createHash('sha256').update('{}').digest('hex')
    const insert = (seq: number, columns: { type?: string; class?: string; version?: number; payload?: string | null; expires?: string | null } = {}) =>
      db.prepare(
        `INSERT INTO session_events (session_id, seq, id, event_version, type, class, writer_epoch, payload, payload_sha256, created_at, expires_at)
         VALUES ('s-head', ?, ?, ?, ?, ?, 1, ?, ?, '2026-10-20T10:00:00.000Z', ?)`,
      ).run(
        seq, crypto.randomUUID(), columns.version ?? 1, columns.type ?? 'prompt', columns.class ?? 'standard',
        columns.payload === undefined ? '{}' : columns.payload, sum, columns.expires ?? null,
      )
    const head = () => (db.prepare("SELECT last_seq FROM sessions WHERE id = 's-head'").get() as { last_seq: number }).last_seq
    const start = head()
    assert.throws(() => insert(start + 2), /next seq/, 'a gap')
    assert.throws(() => insert(start), /next seq|UNIQUE/, 'a duplicate seq')
    assert.throws(() => insert(start - 1), /next seq|UNIQUE/)
    assert.throws(() => insert(start + 1, { version: 2 }), /event policy/)
    assert.throws(() => insert(start + 1, { payload: null }), /event policy/)
    assert.throws(() => insert(start + 1, { class: 'reasoning' }), /event policy/, 'a reasoning class needs the reasoning type')
    assert.throws(() => insert(start + 1, { type: 'reasoning', class: 'reasoning' }), /event policy/, 'reasoning needs an expiry')
    assert.equal(head(), start, 'no refused insert moved the head')
    insert(start + 1)
    assert.equal(head(), start + 1, 'the insert itself advances the head')
  })

  it('leaves no gap when a caller catches a refused append and commits', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    db.exec('BEGIN IMMEDIATE')
    log.appendAsSystemWithin('s-gap', { kind: 'agent' }, prompt('first'))
    assert.equal(code(() => log.appendAsSystemWithin('s-gap', { kind: 'agent' }, { ...prompt('bad'), spanId: 'x'.repeat(201) })), 'stored_data_invalid')
    log.appendAsSystemWithin('s-gap', { kind: 'agent' }, prompt('third'))
    db.exec('COMMIT')
    const seqs = rows(db, 's-gap').map((row) => row.seq)
    assert.deepEqual(seqs, seqs.map((_seq, index) => index + 1))
    assert.equal((db.prepare("SELECT last_seq FROM sessions WHERE id = 's-gap'").get() as { last_seq: number }).last_seq, seqs.length)
  })

  it('deletes a chat session with its Thread only, FTS index included', () => {
    const db = openDb(':memory:')
    db.prepare(
      `INSERT INTO threads (id, title, mode, model, workspace_id, num_ctx, temperature, think, created_at, updated_at)
       VALUES ('t-del', 'Doomed', 'chat', 'fixture', NULL, 4096, 0, 'off', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z')`,
    ).run()
    const log = logFor(db)
    const handle = log.open('t-del', { kind: 'chat', threadId: 't-del' })
    handle.append(prompt('searchable zebra'))
    handle.close()
    assert.equal(log.search('zebra', { audience: 'person' }).length, 1)
    db.prepare("DELETE FROM threads WHERE id = 't-del'").run()
    for (const table of ['sessions', 'session_writers', 'session_events']) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table)
    }
    assert.equal(log.search('zebra', { audience: 'person' }).length, 0)
    db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES ('integrity-check')")
  })
})

describe('session log: scrubbing (D-141)', () => {
  it('stores and returns no registered secret, and counts the redactions', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const secret = fakeSecret()
    scrubber.register('secret://test/planted', secret)
    const log = new SessionLog({ db, scrubber })
    const handle = log.open('s-secret', { kind: 'agent' })
    handle.append(prompt(`use ${secret} twice: ${secret}`))
    handle.append({
      type: 'tool.call',
      data: {
        toolCallId: 'c1', name: 'fetch', arguments: { header: `Bearer ${secret}`, [secret]: true },
        source: 'builtin', parsedFrom: 'native', diffPath: null,
      },
    })
    handle.append({ type: 'reasoning', data: { messageId: 'm1', step: 0, text: `thinking about ${secret}` } })

    const raw = JSON.stringify(db.prepare('SELECT * FROM session_events').all())
    assert.equal(raw.includes(secret), false, 'no stored payload or search text contains the secret')
    assert.equal(log.search(secret, { audience: 'person' }).length, 0)
    assert.equal(JSON.stringify(log.readAll('s-secret', 'person')).includes(secret), false)
    assert.equal(log.counts('s-secret').redactions, 5)
  })

  it('scrubs again on read, so a value registered after the write is still hidden', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const late = fakeSecret()
    const log = new SessionLog({ db, scrubber })
    log.open('s-late', { kind: 'agent' }).append(prompt(`before registration ${late}`))
    scrubber.register('secret://test/late', late)
    assert.equal(JSON.stringify(log.readAll('s-late', 'person')).includes(late), false)
    assert.equal(log.search('registration', { audience: 'person' }).every((hit) => !hit.snippet.includes(late)), true)
  })
})

describe('session log: reasoning class (D-113)', () => {
  it('never returns reasoning to a remote audience, in pages or search', () => {
    const db = openDb(':memory:')
    const log = logFor(db)
    const handle = log.open('s-r', { kind: 'agent' })
    handle.append(prompt('visible walrus'))
    handle.append({ type: 'reasoning', data: { messageId: 'm1', step: 0, text: 'private walrus thoughts' } })
    const person = log.readAll('s-r', 'person')
    const local = log.readAll('s-r', 'local_agent')
    const remote = log.readAll('s-r', 'remote_agent')
    assert.equal(person.filter((event) => event.class === 'reasoning').length, 1)
    assert.equal(local.filter((event) => event.class === 'reasoning').length, 1)
    assert.equal(remote.filter((event) => event.class === 'reasoning').length, 0)
    assert.equal(remote.length, person.length - 1)
    assert.deepEqual(log.search('walrus', { audience: 'person' }).map((hit) => hit.type).sort(), ['prompt', 'reasoning'])
    assert.deepEqual(log.search('walrus', { audience: 'remote_agent' }).map((hit) => hit.type), ['prompt'])
  })

  it('purges expired reasoning content in place; the event and seq stay', () => {
    const db = openDb(':memory:')
    const clock = clockAt()
    const log = logFor(db, { clock: clock.now, reasoningRetentionMs: 120_000, writerTtlMs: 10 * 60_000 })
    const handle = log.open('s-purge', { kind: 'agent' })
    handle.append({ type: 'reasoning', data: { messageId: 'm1', step: 0, text: 'ephemeral narwhal' }, expiresAt: new Date(T0 + 60_000).toISOString() })
    handle.append({ type: 'reasoning', data: { messageId: 'm2', step: 1, text: 'later narwhal' } })
    handle.append({ type: 'reasoning', data: { messageId: 'm3', step: 2, text: 'clamped' }, expiresAt: new Date(T0 + 10 * 86_400_000).toISOString() })
    const expiries = log.readAll('s-purge', 'person').flatMap((event) => event.type === 'reasoning' ? [Date.parse(event.expiresAt) - T0] : [])
    assert.deepEqual(expiries, [60_000, 120_000, 120_000], 'a caller may shorten the retention, never extend it')
    handle.append(prompt('durable narwhal'))

    assert.equal(log.purgeExpiredReasoning().purged, 0)
    clock.advance(60_000)
    // Expired but not purged yet: reads and search already treat it as gone.
    const expired = log.readAll('s-purge', 'person').find((event) => event.type === 'reasoning' && event.data === null)
    assert.ok(expired && expired.type === 'reasoning' && expired.purgedAt === expired.expiresAt)
    assert.deepEqual(log.search('ephemeral', { audience: 'person' }), [])
    assert.equal(log.counts('s-purge').purged, 1)
    assert.equal(log.purgeExpiredReasoning().purged, 1)
    const events = log.readAll('s-purge', 'person')
    const purged = events.find((event) => event.type === 'reasoning' && event.purgedAt !== null)
    assert.ok(purged && purged.type === 'reasoning')
    assert.equal(purged.data, null)
    assert.equal(events.length, 6, 'no event disappeared')
    assert.deepEqual(log.search('narwhal', { audience: 'person' }).map((hit) => hit.type).sort(), ['prompt', 'reasoning'])
    assert.equal(log.counts('s-purge').purged, 1)
    clock.advance(60_000)
    assert.equal(log.purgeExpiredReasoning().purged, 2)
    assert.deepEqual(log.search('narwhal', { audience: 'person' }).map((hit) => hit.type), ['prompt'])
    assert.equal(log.purgeExpiredReasoning().purged, 0, 'a purge is not repeated')
    db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES ('integrity-check')")
    assert.throws(
      () => db.prepare("UPDATE session_events SET payload = NULL, search_text = NULL, purged_at = '2026-10-21T00:00:00.000Z' WHERE type = 'prompt'").run(),
      /append-only|CHECK/,
      'only reasoning can be purged',
    )
  })
})

describe('session log: search', () => {
  it('matches terms literally, so FTS5 syntax in input is inert', () => {
    assert.equal(literalFtsQuery('   '), null)
    assert.equal(literalFtsQuery('a "b" OR c*'), '"a" """b""" "OR" "c*"')
    const db = openDb(':memory:')
    const log = logFor(db)
    log.open('s-fts', { kind: 'agent' }).append(prompt('Привет, ёжик: café OR NEAR'))
    assert.equal(log.search('ежик', { audience: 'person' }).length, 1, 'diacritics folded')
    assert.equal(log.search('cafe', { audience: 'person' }).length, 1)
    assert.equal(log.search('NEAR(', { audience: 'person' }).length, 1, 'an operator is matched as a word, not parsed')
    assert.equal(log.search('OR', { audience: 'person' }).length, 1)
    const [hit] = log.search('ёжик', { audience: 'person' })
    assert.ok(hit!.snippet.includes('\uE000ежик\uE001'), 'the snippet marks the match in the folded index text')
  })
})

describe('session log: migration 29 is append-only', () => {
  it('leaves migrations 1-28 byte-identical to the K1 base (4588ce6)', () => {
    const digest = createHash('sha256').update(JSON.stringify(MIGRATIONS.slice(0, 28))).digest('hex')
    assert.equal(MIGRATIONS.length, 30)
    assert.equal(digest, 'd561955e4784a2d97b96c6f772b4f91993114a557d452d8f8f87283bac28da82')
  })

  it('upgrades v28 data byte-exact, rolls a failed migration back and retries', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-k2-migration-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seed = openDb(path)
    seed.prepare(
      `INSERT INTO threads (id, title, mode, model, workspace_id, num_ctx, temperature, think, created_at, updated_at)
       VALUES ('t-v28', 'Kept', 'chat', 'fixture', NULL, 4096, 0, 'off', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z')`,
    ).run()
    downgradeSessionLogToV28(seed)
    const tables = (database: DatabaseSync) =>
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
        .map(({ name }) => name)
        .filter((name) => !(SESSION_LOG_TABLES as readonly string[]).includes(name))
    const snapshot = (database: DatabaseSync) =>
      JSON.stringify(tables(database).map((name) => [name, orderedRows(database, name)]))
    const v28 = snapshot(seed)
    seed.exec('CREATE TABLE session_writers (collision TEXT)')
    seed.close()

    assert.throws(() => openDb(path), /Миграция 29 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal((rolledBack.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 28)
    assert.equal((rolledBack.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sessions'").get() as { n: number }).n, 0)
    rolledBack.exec('DROP TABLE session_writers')
    assert.equal(snapshot(rolledBack), v28)
    rolledBack.close()

    const upgraded = openDb(path)
    assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30)
    assert.equal(snapshot(upgraded), v28, 'every earlier table is unchanged')
    assert.equal((upgraded.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, 0)
    upgraded.close()
  })
})

describe('session log: kernel plugins', () => {
  it('requires the egress scrubber and closes on unload', async () => {
    const db = openDb(':memory:')
    const kernel = createKernel()
    const plugin = createSessionLogPlugin({ db, purgeIntervalMs: 60_000 })
    const logHandle = await kernel.plugin(plugin)
    assert.equal(logHandle.state, 'pending', 'it waits for the scrubber')
    assert.equal(kernel.service(SESSION_LOG_SERVICE), undefined)
    const scrubberHandle = await kernel.plugin(egressScrubberPlugin)
    const log = kernel.service<SessionLog>(SESSION_LOG_SERVICE)!
    assert.ok(log instanceof SessionLog)
    log.open('s-k', { kind: 'agent' })
    await scrubberHandle.dispose()
    assert.equal(log.isClosed, true, 'the log unloaded before its scrubber')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_writers WHERE released_at IS NULL').get() as { n: number }).n, 0)
    await kernel.dispose()
  })

  it('boots with the node database and pins the new rows', async () => {
    const db = openDb(':memory:')
    const kernel = await bootServerKernel(undefined, { db })
    try {
      assert.deepEqual(kernel.node.entries().map((entry) => entry.id), ['resource-governor', 'ollama', 'egress-scrubber', 'session-log', 'durable-runs'])
      assert.ok(kernel.sessionLog instanceof SessionLog)
      await assert.rejects(
        kernel.node.apply([LEGACY_SERVER_PROFILE, SESSION_LOG_LAYER, { name: 'user', patch: [{ id: 'egress-scrubber', disabled: true }] }]),
        /pinned/,
      )
      assert.equal(kernel.node.stateOf('session-log'), 'active')
    } finally {
      await kernel.node.dispose()
    }
    assert.equal(kernel.sessionLog?.isClosed, true)
  })
})

/** Narrow helper for the type checker in assertions above. */
export type { SessionEvent }
