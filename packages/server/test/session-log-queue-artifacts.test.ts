/**
 * Seeded v3 queue evidence: independent migration 40, multi-descriptor atomic
 * append, current-registry read projection, REST/SSE/export version boundaries
 * and the raw-SQL database policy.
 *
 * This fixture uses the real pinned session-input helper and SQLite. The
 * author's DSH sandbox must not run it; root/reviewer runs it under the heavy
 * envelope.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { Hono } from 'hono'
import {
  INPUT_INLINE_BYTES,
  SESSION_EVENT_VERSION,
  SESSION_EVENT_VERSION_2,
  SESSION_EVENT_VERSION_3,
  SESSION_EXPORT_VERSION,
  SESSION_EXPORT_VERSION_2,
  SESSION_EXPORT_VERSION_3,
  apiErrorSchema,
  sessionEventSchema,
  sessionEventsResponse,
  sessionExportSchema,
  type QueueAppendItemV3,
  type SessionEvent,
} from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import {
  SessionEventVersionError,
  SessionLog,
  SessionLogError,
  type SessionHandle,
} from '../src/session-log/log.ts'
import { SessionInputStore, utf8Excerpt } from '../src/session-log/input-artifacts.ts'
import {
  SESSION_QUEUE_MIGRATIONS_TABLE,
  SESSION_QUEUE_POLICY_TRIGGER_SQL,
  SessionQueueSchemaError,
  V33_POLICY_TRIGGER_SQL,
  installSessionQueueSchema,
} from '../src/session-log/queue-schema.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { MIGRATIONS, openDb, type Db } from '../src/store/db.ts'

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const MEDIA = 'text/plain; charset=utf-8' as const
const BASE_MIGRATION_DIGEST = '3b3e4caa8835d0ea5e8f7229d54b2faf858db36b97532096b018980cda3746e7'
const POLICY = 'session_events_policy_insert'

interface Fixture {
  app: Hono
  log: SessionLog
  db: Db
  store: SessionInputStore
  scrubber: SecretScrubber
  sessionId: string
  handle: SessionHandle
}

interface AppendOptionsLike {
  idempotencyKey?: string
  expectedSeq?: number
}

async function fixture(t: { after(fn: () => unknown): void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-queue-v3-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'guanxi.db'))
  t.after(() => db.close())
  const scrubber = new SecretScrubber()
  const log = new SessionLog({ db, scrubber })
  const store = new SessionInputStore({ dataDir: join(root, 'data'), db })
  const sessionId = 's-queue-v3'
  const handle = log.open(sessionId, { kind: 'agent' })
  t.after(() => { try { handle.close() } catch { /* already closed */ } })
  const app = new Hono()
  app.route('/api/sessions', sessionLogRoutes(() => log))
  return { app, log, db, store, scrubber, sessionId, handle }
}

function tableNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as { name: string }[]).map((row) => row.name)
}

/** `node:sqlite` rows have a null prototype; compare their exact scalar values, not prototypes. */
function ledgerVersions(db: Db): number[] {
  return (db.prepare(`SELECT version FROM ${SESSION_QUEUE_MIGRATIONS_TABLE} ORDER BY version`)
    .all() as unknown as { version: number }[]).map((row) => Number(row.version))
}

function independentLedgerVersions(db: Db): number[] {
  return (db.prepare('SELECT version FROM fixture_independent_ledger ORDER BY version')
    .all() as unknown as { version: number }[]).map((row) => Number(row.version))
}

interface WorkerMessage {
  state?: string
  busy?: boolean
  code?: string | null
  errcode?: number | null
  message?: string
}

/** Ordered worker messages with explicit error propagation; no sleeps or polling. */
function workerMessages(worker: Worker): () => Promise<WorkerMessage> {
  const queued: WorkerMessage[] = []
  const waiters: Array<{ resolve: (message: WorkerMessage) => void; reject: (error: Error) => void }> = []
  let failure: Error | null = null
  const fail = (error: Error) => {
    failure ??= error
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  }
  worker.on('message', (message: WorkerMessage) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(message)
    else queued.push(message)
  })
  worker.on('error', fail)
  worker.on('exit', (code) => { if (code !== 0) fail(new Error(`installer worker exited with code ${code}`)) })
  return () => {
    if (failure) return Promise.reject(failure)
    const message = queued.shift()
    if (message) return Promise.resolve(message)
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }
}

function triggerSql(db: Db, name = POLICY): string | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as
    | { sql: string | null }
    | undefined
  return row?.sql ?? undefined
}

function normalize(sql: string | undefined): string {
  return (sql ?? '').replace(/\s+/gu, ' ').trim().replace(/;$/u, '')
}

function head(db: Db, sessionId: string): number {
  return (db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get(sessionId) as { last_seq: number }).last_seq
}

async function descriptor(store: SessionInputStore, sessionId: string, text: string) {
  const written = await store.write(sessionId, text, MEDIA)
  return {
    checksum: written.checksum,
    byteSize: written.byteSize,
    mediaType: MEDIA,
    excerpt: utf8Excerpt(text),
  }
}

function appendV3(f: Fixture, items: QueueAppendItemV3[], options: AppendOptionsLike = {}) {
  return f.handle.append(
    { type: 'agent.queue', data: { items } },
    { eventVersion: SESSION_EVENT_VERSION_3, ...options },
  )
}

async function appendV2Prompt(f: Fixture, text: string, messageId = 'm-v2'): Promise<SessionEvent> {
  const input = await descriptor(f.store, f.sessionId, text)
  return f.handle.append(
    { type: 'prompt', data: { origin: 'typed', messageId, attachmentCount: 0 } },
    { eventVersion: SESSION_EVENT_VERSION_2, inputArtifact: input },
  ).event
}

interface RawOptions {
  version?: number
  type?: string
  class?: 'standard' | 'reasoning'
  seq?: number
  expiresAt?: string | null
  payload?: unknown
}

function rawInsert(f: Fixture, options: RawOptions = {}) {
  const version = options.version ?? SESSION_EVENT_VERSION_3
  const type = options.type ?? 'agent.queue'
  const eventClass = options.class ?? 'standard'
  const seq = options.seq ?? head(f.db, f.sessionId) + 1
  const payload = options.payload === undefined
    ? { items: [{ id: 'raw', kind: 'inline', text: 'raw' }] }
    : options.payload
  const text = payload === null ? null : JSON.stringify(payload)
  f.db.prepare(
    `INSERT INTO session_events (session_id, seq, id, event_version, type, class, writer_epoch,
       payload, payload_sha256, search_text, redactions, created_at, expires_at, purged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL)`,
  ).run(
    f.sessionId,
    seq,
    randomUUID(),
    version,
    type,
    eventClass,
    f.handle.epoch,
    text,
    createHash('sha256').update(text ?? '').digest('hex'),
    new Date().toISOString(),
    eventClass === 'reasoning' ? (options.expiresAt ?? new Date(Date.now() + 60_000).toISOString()) : null,
  )
  return seq
}

function metadata(f: Fixture, input: { checksum?: string; byteSize?: number; mediaType?: string; sessionId?: string; artifactId?: string } = {}) {
  const artifactId = input.artifactId ?? randomUUID()
  const checksum = input.checksum ?? `sha256:${randomBytes(32).toString('hex')}`
  const byteSize = input.byteSize ?? INPUT_INLINE_BYTES + 1
  const mediaType = input.mediaType ?? MEDIA
  const sessionId = input.sessionId ?? f.sessionId
  f.db.prepare(
    `INSERT INTO session_input_artifacts (artifact_id, session_id, checksum, byte_size, media_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(artifactId, sessionId, checksum, byteSize, mediaType, new Date().toISOString())
  return { artifactId, checksum, byteSize, mediaType, excerpt: 'raw excerpt', excerptBytes: Buffer.byteLength('raw excerpt') }
}

function rawArtifactItem(id: string, artifact: {
  artifactId: string
  checksum: string
  byteSize: number
  mediaType: string
  excerpt: string
  excerptBytes: number
}) {
  return { id, kind: 'artifact', artifact }
}

interface Frame {
  id: string | null
  event: string | null
  data: string
}

async function readFrames(response: Response, stopOnError = false): Promise<Frame[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Frame[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const frame: Frame = { id: null, event: null, data: '' }
      for (const line of raw.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4)
        else if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data = line.slice(6)
      }
      if (frame.data) frames.push(frame)
      if (stopOnError && frame.event === 'guanxi-error') {
        await reader.cancel()
        return frames
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  return frames
}

describe('session queue ledger 40', () => {
  test('installs once, preserves global 1–33 and does not touch another ledger', () => {
    const db = openDb(':memory:')
    try {
      assert.equal(MIGRATIONS.length, 33)
      assert.equal(createHash('sha256').update(JSON.stringify(MIGRATIONS.slice(0, 33))).digest('hex'), BASE_MIGRATION_DIGEST)
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 33)
      assert.equal(normalize(triggerSql(db)), normalize(V33_POLICY_TRIGGER_SQL))
      const beforeTables = tableNames(db)

      installSessionQueueSchema(db)
      const afterTables = tableNames(db)
      assert.deepEqual(afterTables, [...beforeTables, SESSION_QUEUE_MIGRATIONS_TABLE].sort())
      assert.deepEqual(ledgerVersions(db), [40])
      assert.match(triggerSql(db)!, /event_version NOT IN \(1,2,3\)/u)
      assert.match(triggerSql(db)!, /agent\.queue/u)
      assert.equal(normalize(triggerSql(db)), normalize(SESSION_QUEUE_POLICY_TRIGGER_SQL))
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 33)

      const installedTrigger = triggerSql(db)
      installSessionQueueSchema(db)
      assert.deepEqual(tableNames(db), afterTables)
      assert.equal(triggerSql(db), installedTrigger)
      assert.deepEqual(ledgerVersions(db), [40])
    } finally {
      db.close()
    }
  })

  test('rolls a failed trigger or ledger change back for every injected point and retries', () => {
    for (const point of ['before_install', 'after_trigger', 'after_ledger'] as const) {
      const db = openDb(':memory:')
      try {
        const beforeTables = tableNames(db)
        const beforeTrigger = triggerSql(db)
        assert.throws(
          () => installSessionQueueSchema(db, {
            fault: (current) => { if (current === point) throw new Error(`fixture-${point}`) },
          }),
          new RegExp(`fixture-${point}`, 'u'),
        )
        assert.deepEqual(tableNames(db), beforeTables)
        assert.equal(triggerSql(db), beforeTrigger)
        installSessionQueueSchema(db)
        assert.deepEqual(ledgerVersions(db), [40])
      } finally {
        db.close()
      }
    }
  })

  test('rejects future, unknown and incompatible ledger or trigger shapes without changing them', () => {
    const future = openDb(':memory:')
    try {
      future.exec(`CREATE TABLE ${SESSION_QUEUE_MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY CHECK (version >= 1));
        INSERT INTO ${SESSION_QUEUE_MIGRATIONS_TABLE} (version) VALUES (41);`)
      assert.throws(
        () => installSessionQueueSchema(future),
        (error: unknown) => error instanceof SessionQueueSchemaError && error.code === 'queue_schema_future',
      )
      assert.equal(normalize(triggerSql(future)), normalize(V33_POLICY_TRIGGER_SQL))
    } finally {
      future.close()
    }

    const unknown = openDb(':memory:')
    try {
      unknown.exec(`CREATE TABLE ${SESSION_QUEUE_MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY CHECK (version >= 1));
        INSERT INTO ${SESSION_QUEUE_MIGRATIONS_TABLE} (version) VALUES (34);`)
      assert.throws(
        () => installSessionQueueSchema(unknown),
        (error: unknown) => error instanceof SessionQueueSchemaError && error.code === 'queue_schema_incompatible',
      )
    } finally {
      unknown.close()
    }

    const shape = openDb(':memory:')
    try {
      shape.exec(`CREATE TABLE ${SESSION_QUEUE_MIGRATIONS_TABLE} (version TEXT)`)
      assert.throws(
        () => installSessionQueueSchema(shape),
        (error: unknown) => error instanceof SessionQueueSchemaError && error.code === 'queue_schema_incompatible',
      )
    } finally {
      shape.close()
    }

    const trigger = openDb(':memory:')
    try {
      trigger.exec(`DROP TRIGGER ${POLICY};
        CREATE TRIGGER ${POLICY} BEFORE INSERT ON session_events
        BEGIN SELECT RAISE(ABORT, 'fixture incompatible trigger'); END;`)
      assert.throws(
        () => installSessionQueueSchema(trigger),
        (error: unknown) => error instanceof SessionQueueSchemaError && error.code === 'queue_schema_incompatible',
      )
      assert.match(triggerSql(trigger)!, /fixture incompatible trigger/u)
    } finally {
      trigger.close()
    }
  })

  test('SessionLog construction installs the ledger before serving writes', () => {
    const db = openDb(':memory:')
    try {
      new SessionLog({ db, scrubber: new SecretScrubber() })
      assert.deepEqual(ledgerVersions(db), [40])
    } finally {
      db.close()
    }
  })

  test('SessionLog construction refuses a future ledger even with the removed stale switch', () => {
    const db = openDb(':memory:')
    try {
      db.exec(`CREATE TABLE ${SESSION_QUEUE_MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY CHECK (version >= 1));
        INSERT INTO ${SESSION_QUEUE_MIGRATIONS_TABLE} (version) VALUES (41);`)
      const staleOptions = {
        db,
        scrubber: new SecretScrubber(),
        installQueueSchema: false,
      } as unknown as ConstructorParameters<typeof SessionLog>[0]
      assert.throws(
        () => new SessionLog(staleOptions),
        (error: unknown) => error instanceof SessionQueueSchemaError && error.code === 'queue_schema_future',
        'a stale JavaScript opt-out must not bypass mandatory ledger verification',
      )
    } finally {
      db.close()
    }
  })

  test('serializes a held writer and a competing initializer to one committed ledger 40', { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-queue-ledger-race-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seed = openDb(path)
    seed.exec(`CREATE TABLE fixture_independent_ledger (version INTEGER PRIMARY KEY);
      INSERT INTO fixture_independent_ledger (version) VALUES (34),(35),(36),(37),(38),(39);`)
    assert.equal((seed.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 33)
    seed.close()

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3)
    const workers: Worker[] = []
    const exits: Promise<void>[] = []
    t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())) })
    const start = (role: 'holder' | 'competitor') => {
      const worker = new Worker(new URL('./fixtures/queue-schema-installer-worker.ts', import.meta.url), {
        workerData: { role, dbPath: path, gate },
      })
      workers.push(worker)
      exits.push(new Promise((resolve, reject) => {
        worker.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`installer worker exited with code ${code}`)) })
      }))
      return workerMessages(worker)
    }

    const holder = start('holder')
    const holding = await holder()
    assert.equal(holding.state, 'holding', 'the first initializer must hold an uncommitted trigger replacement')

    // A second connection sees only committed state while the holder is inside
    // BEGIN IMMEDIATE: no ledger table, the global-33 trigger and untouched
    // independent ledgers. This is not a read of the holder's uncommitted DDL.
    const observer = new DatabaseSync(path)
    try {
      assert.equal((observer.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 33)
      assert.equal(normalize(triggerSql(observer)), normalize(V33_POLICY_TRIGGER_SQL))
      assert.equal(tableNames(observer).includes(SESSION_QUEUE_MIGRATIONS_TABLE), false)
      assert.deepEqual(independentLedgerVersions(observer), [34, 35, 36, 37, 38, 39])
    } finally {
      observer.close()
    }

    const competitor = start('competitor')
    const blocked = await competitor()
    assert.equal(blocked.state, 'blocked', 'the competing constructor must not accept a pre-lock ledger')
    assert.equal(blocked.busy, true, 'the held write lock must refuse the competing BEGIN IMMEDIATE')
    assert.equal((await holder()).state, 'committed')
    assert.equal((await competitor()).state, 'constructed', 'the competitor re-reads the committed ledger after serialization')
    // State messages precede connection closure. Settle both owned workers before
    // opening the final observer so their teardown cannot race its reads.
    await Promise.all(exits)

    const final = new DatabaseSync(path)
    try {
      assert.equal((final.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 33)
      assert.equal(normalize(triggerSql(final)), normalize(SESSION_QUEUE_POLICY_TRIGGER_SQL))
      assert.deepEqual(ledgerVersions(final), [40])
      assert.deepEqual(independentLedgerVersions(final), [34, 35, 36, 37, 38, 39])
      installSessionQueueSchema(final)
      assert.deepEqual(ledgerVersions(final), [40], 'repeat initialization leaves exactly one row')
      assert.equal(normalize(triggerSql(final)), normalize(SESSION_QUEUE_POLICY_TRIGGER_SQL))
    } finally {
      final.close()
    }
  })
})

describe('queue v3 append and read', () => {
  test('emits inline and artifact branches with exact ids, bytes and excerpts', async (t) => {
    const f = await fixture(t)
    const tail = `QUEUE-TAIL-${randomBytes(8).toString('hex')}`
    const full = `${'q'.repeat(INPUT_INLINE_BYTES)}${tail}`
    const input = await descriptor(f.store, f.sessionId, full)
    const exact = `${'q'.repeat(INPUT_INLINE_BYTES - 16)}queueftssentinel`
    const appended = appendV3(f, [
      { id: 'inline-item', kind: 'inline', text: exact },
      { id: 'artifact-item', kind: 'artifact', input },
    ]).event
    assert.equal(appended.version, SESSION_EVENT_VERSION_3)
    if (appended.type !== 'agent.queue' || appended.version !== SESSION_EVENT_VERSION_3) throw new Error('expected v3 queue')
    assert.equal(appended.data.items.length, 2)
    const [inline, artifact] = appended.data.items
    assert.deepEqual(inline, { id: 'inline-item', kind: 'inline', text: exact })
    if (artifact?.kind !== 'artifact') throw new Error('expected artifact')
    assert.equal(artifact.artifact.checksum, input.checksum)
    assert.equal(artifact.artifact.byteSize, Buffer.byteLength(full, 'utf8'))
    assert.equal(artifact.artifact.excerptBytes, Buffer.byteLength(artifact.artifact.excerpt, 'utf8'))
    assert.ok(artifact.artifact.excerptBytes <= INPUT_INLINE_BYTES / 2)
    const serialized = JSON.stringify(appended)
    assert.equal(serialized.includes(tail), false)
    assert.equal(serialized.includes('"text"'), true, 'the inline branch still carries text')
    assert.equal(artifact.kind, 'artifact')

    const read = f.log.readAll(f.sessionId, 'person').at(-1)!
    assert.deepEqual(read, appended)
    const stored = f.db.prepare(
      'SELECT search_text FROM session_events WHERE seq = ?',
    ).get(appended.seq) as { search_text: string | null }
    assert.equal(stored.search_text, null, 'queue text stays out of FTS')
    const queueMatch = f.db.prepare(
      "SELECT COUNT(*) AS n FROM session_events_fts WHERE session_events_fts MATCH 'queueftssentinel'",
    ).get() as { n: number }
    assert.equal(queueMatch.n, 0, 'the queue sentinel is not indexed')
    assert.equal(f.log.search('queueftssentinel', { audience: 'person' }).length, 0)

    // External-content FTS can return a content row by rowid without indexing it.
    // A normal prompt proves this database is really indexing searchable text, so
    // the negative queue assertion above cannot pass because indexing is disabled.
    const positive = f.handle.append({
      type: 'prompt',
      data: { origin: 'typed', messageId: 'fts-positive', text: 'queueftspositivesentinel', attachmentCount: 0 },
    }).event
    const positiveRow = f.db.prepare(
      'SELECT row_id, search_text FROM session_events WHERE seq = ?',
    ).get(positive.seq) as { row_id: number; search_text: string | null }
    assert.equal(positiveRow.search_text, 'queueftspositivesentinel')
    const positiveMatches = f.db.prepare(
      "SELECT rowid FROM session_events_fts WHERE session_events_fts MATCH 'queueftspositivesentinel'",
    ).all() as unknown as { rowid: number }[]
    assert.deepEqual(positiveMatches.map((row) => Number(row.rowid)), [positiveRow.row_id])
    assert.equal(f.log.search('queueftspositivesentinel', { audience: 'person' }).length, 1)
  })

  test('resolves several descriptors atomically and keeps distinct ids for equal text', async (t) => {
    const f = await fixture(t)
    const text = `${'d'.repeat(INPUT_INLINE_BYTES)}one digest`
    const first = await descriptor(f.store, f.sessionId, text)
    const second = await descriptor(f.store, f.sessionId, text.replace('one', 'two'))
    const result = appendV3(f, [
      { id: 'queue-one', kind: 'artifact', input: first },
      { id: 'queue-two', kind: 'artifact', input: second },
      { id: 'queue-three', kind: 'inline', text: 'inline sibling' },
    ])
    assert.equal(result.duplicate, false)
    if (result.event.type !== 'agent.queue' || result.event.version !== SESSION_EVENT_VERSION_3) throw new Error('expected v3 queue')
    const items = result.event.data.items
    assert.deepEqual(items.map((item) => item.id), ['queue-one', 'queue-two', 'queue-three'])
    const artifactItems = items.filter((item) => item.kind === 'artifact')
    assert.equal(artifactItems.length, 2)
    assert.notEqual(artifactItems[0]!.artifact.artifactId, artifactItems[1]!.artifact.artifactId)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 2)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, head(f.db, f.sessionId))
  })

  test('rolls the whole snapshot back when the second descriptor mismatches stored metadata', async (t) => {
    const f = await fixture(t)
    const firstText = `${'a'.repeat(INPUT_INLINE_BYTES)}first-atomic`
    const secondText = `${'b'.repeat(INPUT_INLINE_BYTES)}second-atomic`
    const first = await descriptor(f.store, f.sessionId, firstText)
    const second = await descriptor(f.store, f.sessionId, secondText)
    f.db.prepare(
      `INSERT INTO session_input_artifacts (artifact_id, session_id, checksum, byte_size, media_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), f.sessionId, second.checksum, second.byteSize + 1, second.mediaType, new Date().toISOString())
    const eventsBefore = (f.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n
    const artifactsBefore = (f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n
    const headBefore = head(f.db, f.sessionId)
    assert.throws(
      () => appendV3(f, [
        { id: 'first', kind: 'artifact', input: first },
        { id: 'second', kind: 'artifact', input: second },
      ]),
      (error: unknown) => error instanceof SessionLogError && error.code === 'invalid_event',
    )
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, eventsBefore)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, artifactsBefore)
    assert.equal(head(f.db, f.sessionId), headBefore)
  })

  test('returns one event for an identical idempotent retry and refuses conflicting reuse', async (t) => {
    const f = await fixture(t)
    const input = await descriptor(f.store, f.sessionId, `${'i'.repeat(INPUT_INLINE_BYTES)}idem`)
    const items: QueueAppendItemV3[] = [{ id: 'idem-item', kind: 'artifact', input }]
    const first = appendV3(f, items, {
      idempotencyKey: 'queue-idem',
      expectedSeq: head(f.db, f.sessionId) + 1,
    })
    const second = appendV3(f, items, {
      idempotencyKey: 'queue-idem',
      expectedSeq: first.event.seq,
    })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    assert.equal(second.event.seq, first.event.seq)
    assert.throws(
      () => appendV3(f, [{ id: 'other-item', kind: 'inline', text: 'different' }], { idempotencyKey: 'queue-idem' }),
      (error: unknown) => error instanceof SessionLogError && error.code === 'idempotency_conflict',
    )
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, head(f.db, f.sessionId))
  })

  test('rejects duplicate ids, wrong types and the v2 inputArtifact option on v3', async (t) => {
    const f = await fixture(t)
    assert.throws(
      () => appendV3(f, [
        { id: 'same', kind: 'inline', text: 'one' },
        { id: 'same', kind: 'inline', text: 'two' },
      ]),
      (error: unknown) => error instanceof SessionLogError && error.code === 'invalid_event',
    )
    const input = await descriptor(f.store, f.sessionId, `${'x'.repeat(INPUT_INLINE_BYTES)}option`)
    assert.throws(
      () => f.handle.append(
        { type: 'agent.queue', data: { items: [{ id: 'artifact', kind: 'artifact', input }] } },
        { eventVersion: SESSION_EVENT_VERSION_3, inputArtifact: input },
      ),
      (error: unknown) => error instanceof SessionLogError && error.code === 'invalid_event',
    )
    assert.throws(
      () => f.handle.append(
        { type: 'prompt', data: { origin: 'typed', messageId: 'm', attachmentCount: 0 } } as never,
        { eventVersion: SESSION_EVENT_VERSION_3 },
      ),
      (error: unknown) => error instanceof SessionLogError && error.code === 'invalid_event',
    )
    assert.throws(
      () => f.handle.append(
        { type: 'agent.queue', data: { items: [{ id: 'a', kind: 'artifact', artifact: input }] } } as never,
        { eventVersion: SESSION_EVENT_VERSION_3 },
      ),
      (error: unknown) => error instanceof SessionLogError && error.code === 'invalid_event',
    )
  })

  test('reports the actual required version without advancing a cursor', async (t) => {
    const f = await fixture(t)
    const v2 = await appendV2Prompt(f, `${'v'.repeat(INPUT_INLINE_BYTES)}v2-tail`)
    const v3 = appendV3(f, [{ id: 'v3', kind: 'inline', text: 'v3' }]).event
    const max1 = f.log.read(f.sessionId, { afterSeq: 0, audience: 'person', maxVersion: 1 })
    assert.equal(max1.unsupportedSeq, v2.seq)
    assert.equal(max1.requiredVersion, SESSION_EVENT_VERSION_2)
    assert.equal(max1.events.some((event) => event.seq === v2.seq), false)
    const max2 = f.log.read(f.sessionId, { afterSeq: v2.seq, audience: 'person', maxVersion: 2 })
    assert.equal(max2.unsupportedSeq, v3.seq)
    assert.equal(max2.requiredVersion, SESSION_EVENT_VERSION_3)
    assert.equal(max2.events.length, 0)
    const max3 = f.log.read(f.sessionId, { afterSeq: v2.seq, audience: 'person', maxVersion: 3 })
    assert.equal(max3.unsupportedSeq, null)
    assert.equal(max3.requiredVersion, null)
    assert.equal(max3.events.at(-1)?.seq, v3.seq)
    await assert.rejects(
      f.log.subscribe(f.sessionId, v2.seq, 'person', new AbortController().signal, 2).next(),
      (error: unknown) => error instanceof SessionEventVersionError && error.required === SESSION_EVENT_VERSION_3,
    )
  })
})

describe('queue v3 REST and SSE version boundaries', () => {
  test('serves max3, refuses max1/max2 with the actual required version and no partial body', async (t) => {
    const f = await fixture(t)
    const v2 = await appendV2Prompt(f, `${'r'.repeat(INPUT_INLINE_BYTES)}rest-v2-tail`)
    const v3 = appendV3(f, [{ id: 'rest-v3', kind: 'inline', text: 'rest-v3' }]).event

    const max1BeforeV2 = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0&limit=2&eventVersion=1`, {}, LOOPBACK)
    assert.equal(max1BeforeV2.status, 200)
    assert.equal(sessionEventsResponse.parse(await max1BeforeV2.json()).events.every((event) => event.version === 1), true)

    const max1 = await f.app.request(`/api/sessions/${f.sessionId}/events?after=${v2.seq - 1}&eventVersion=1`, {}, LOOPBACK)
    assert.equal(max1.status, 406)
    const max1Body = apiErrorSchema.parse(await max1.json())
    assert.equal(max1Body.code, 'session_event_version_unsupported')
    assert.deepEqual(max1Body.details, { seq: v2.seq, supported: 1, required: 2 })
    assert.equal('events' in max1Body, false)
    assert.equal('nextAfter' in max1Body, false)

    const max2 = await f.app.request(`/api/sessions/${f.sessionId}/events?after=${v2.seq}&eventVersion=2`, {}, LOOPBACK)
    assert.equal(max2.status, 406)
    const max2Body = apiErrorSchema.parse(await max2.json())
    assert.deepEqual(max2Body.details, { seq: v3.seq, supported: 2, required: 3 })
    assert.equal(JSON.stringify(max2Body).includes('rest-v3'), false)

    const max3 = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0&limit=500&eventVersion=3`, {}, LOOPBACK)
    assert.equal(max3.status, 200)
    const page = sessionEventsResponse.parse(await max3.json())
    assert.equal(page.events.at(-1)?.seq, v3.seq)
    assert.equal(page.events.filter((event) => event.seq === v3.seq).length, 1)
    assert.equal(JSON.stringify(page).includes('REST-TAIL'), false)
  })

  test('closes a max2 SSE at the v3 boundary with no error id and keeps the last valid cursor', async (t) => {
    const f = await fixture(t)
    const v2 = await appendV2Prompt(f, `${'s'.repeat(INPUT_INLINE_BYTES)}sse-v2-tail`)
    const response = await f.app.request(`/api/sessions/${f.sessionId}/stream?after=0&eventVersion=2`, {}, LOOPBACK)
    assert.equal(response.status, 200)
    const reading = readFrames(response, true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const v3 = appendV3(f, [{ id: 'sse-v3', kind: 'inline', text: 'sse-v3' }]).event
    const frames = await reading
    const errorFrame = frames.find((frame) => frame.event === 'guanxi-error')
    assert.ok(errorFrame)
    assert.equal(errorFrame!.id, null)
    const error = apiErrorSchema.parse(JSON.parse(errorFrame!.data))
    assert.equal(error.code, 'session_event_version_unsupported')
    assert.deepEqual(error.details, { seq: v3.seq, supported: 2, required: 3 })
    const lastV2 = frames.filter((frame) => frame.event === 'guanxi' && frame.id !== null).at(-1)
    assert.ok(Number(lastV2!.id) < v3.seq)
    assert.equal(frames.some((frame) => frame.id === String(v3.seq)), false)

    const reconnect = await f.app.request(`/api/sessions/${f.sessionId}/stream?eventVersion=2`, {
      headers: { 'Last-Event-ID': lastV2!.id! },
    }, LOOPBACK)
    assert.equal(reconnect.status, 406)
    assert.deepEqual(apiErrorSchema.parse(await reconnect.json()).details, { seq: v3.seq, supported: 2, required: 3 })
    assert.equal(v2.seq < v3.seq, true)
  })

  test('refuses a smaller export before bytes and returns the minimum required body', async (t) => {
    const f = await fixture(t)
    const v1 = sessionExportSchema.parse(await (await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=1`, {}, LOOPBACK)).json())
    assert.equal(v1.exportVersion, SESSION_EXPORT_VERSION)
    const v2 = await appendV2Prompt(f, `${'e'.repeat(INPUT_INLINE_BYTES)}export-v2-tail`)
    const two = sessionExportSchema.parse(await (await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=3`, {}, LOOPBACK)).json())
    assert.equal(two.exportVersion, SESSION_EXPORT_VERSION_2)
    assert.equal(two.events.some((event) => event.version === SESSION_EVENT_VERSION_2), true)
    const refusedV2 = await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=1`, {}, LOOPBACK)
    assert.equal(refusedV2.status, 406)
    assert.deepEqual(apiErrorSchema.parse(await refusedV2.json()).details, {
      seq: v2.seq, supported: 1, required: SESSION_EVENT_VERSION_2,
    })

    const tail = `EXPORT-QUEUE-TAIL-${randomBytes(8).toString('hex')}`
    const input = await descriptor(f.store, f.sessionId, `${'t'.repeat(INPUT_INLINE_BYTES)}${tail}`)
    const v3 = appendV3(f, [{ id: 'export-artifact', kind: 'artifact', input }]).event
    const refusedV3 = await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=2`, {}, LOOPBACK)
    assert.equal(refusedV3.status, 406)
    assert.deepEqual(apiErrorSchema.parse(await refusedV3.json()).details, {
      seq: v3.seq, supported: 2, required: SESSION_EVENT_VERSION_3,
    })
    assert.equal(refusedV3.headers.get('content-disposition'), null)
    const three = sessionExportSchema.parse(await (await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=3`, {}, LOOPBACK)).json())
    assert.equal(three.exportVersion, SESSION_EXPORT_VERSION_3)
    assert.equal(three.events.some((event) => event.version === SESSION_EVENT_VERSION_3), true)
    const serialized = JSON.stringify(three)
    assert.equal(serialized.includes(tail), false)
    assert.equal(three.events.some((event) => event.class === 'reasoning'), false)
    assert.equal(serialized.includes('"class":"reasoning"'), false)
  })
})

describe('queue v3 privacy and current-registry projection', () => {
  test('projects late-registered secrets per queue item and never reads a blob for a preview', async (t) => {
    const f = await fixture(t)
    const secret = 's3cr3t!!'
    const full = `${secret} ${'p'.repeat(INPUT_INLINE_BYTES)}tail`
    const input = await descriptor(f.store, f.sessionId, full)
    const inline = appendV3(f, [{ id: 'privacy-inline', kind: 'inline', text: `before ${secret} after` }]).event
    const artifact = appendV3(f, [{ id: 'privacy-artifact', kind: 'artifact', input }]).event
    let reads = 0
    t.mock.method(SessionInputStore.prototype, 'read', () => {
      reads += 1
      throw new Error('artifact_io_forbidden')
    })
    const { scrubber } = f
    scrubber.register('secret://queue/late', secret)

    const readInline = f.log.read(f.sessionId, { audience: 'person', seqs: [inline.seq], limit: 1 }).events[0]!
    assert.equal(JSON.stringify(readInline).includes(secret), false)
    const readArtifact = f.log.read(f.sessionId, { audience: 'person', seqs: [artifact.seq], limit: 1 }).events[0]!
    if (readArtifact.type !== 'agent.queue' || readArtifact.version !== SESSION_EVENT_VERSION_3) throw new Error('expected v3 queue')
    const item = readArtifact.data.items[0]
    if (item?.kind !== 'artifact') throw new Error('expected artifact')
    assert.equal(JSON.stringify(readArtifact).includes(secret), false)
    assert.equal(item.artifact.excerptBytes, Buffer.byteLength(item.artifact.excerpt, 'utf8'))
    assert.ok(item.artifact.excerptBytes <= INPUT_INLINE_BYTES / 2)

    const route = await f.app.request(`/api/sessions/${f.sessionId}/events?after=${artifact.seq - 1}&eventVersion=3`, {}, LOOPBACK)
    assert.equal(route.status, 200)
    assert.equal(JSON.stringify(await route.json()).includes(secret), false)
    const exported = await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=3`, {}, LOOPBACK)
    assert.equal(JSON.stringify(await exported.json()).includes(secret), false)
    assert.equal(reads, 0, 'preview, REST, SSE and export paths never open the artifact blob')
  })

  test('refuses a late-expanded inline value above 16 KiB content-free and preserves the stored input', async (t) => {
    const f = await fixture(t)
    const secret = 's3cr3t!!'
    const text = secret.repeat(INPUT_INLINE_BYTES / secret.length)
    const event = appendV3(f, [{ id: 'expanding', kind: 'inline', text }]).event
    const stored = (f.db.prepare('SELECT payload FROM session_events WHERE seq = ?').get(event.seq) as { payload: string }).payload
    assert.equal(stored.includes(secret), true)
    const { scrubber } = f
    scrubber.register('secret://queue/expand', secret)
    assert.throws(
      () => f.log.read(f.sessionId, { afterSeq: event.seq - 1, audience: 'person', limit: 10 }),
      (error: unknown) => error instanceof SessionLogError && error.code === 'stored_data_invalid',
    )
    const response = await f.app.request(`/api/sessions/${f.sessionId}/events?after=${event.seq - 1}&eventVersion=3`, {}, LOOPBACK)
    assert.equal(response.status, 500)
    const body = apiErrorSchema.parse(await response.json())
    assert.equal(body.code, 'storage_error')
    assert.equal(JSON.stringify(body).includes(secret), false)
    assert.equal('nextAfter' in body, false)
    assert.equal(
      (f.db.prepare('SELECT payload FROM session_events WHERE seq = ?').get(event.seq) as { payload: string }).payload,
      stored,
      'the stored input is not truncated or rewritten',
    )
  })

  test('fails closed when a late registration would rewrite a queue identifier', async (t) => {
    const f = await fixture(t)
    const secret = 'queue-id-secret-!!'
    const event = appendV3(f, [{ id: secret, kind: 'inline', text: 'identifier fixture' }]).event
    const { scrubber } = f
    scrubber.register('secret://queue/id', secret)
    assert.throws(
      () => f.log.read(f.sessionId, { afterSeq: event.seq - 1, audience: 'person', limit: 10 }),
      (error: unknown) => error instanceof SessionLogError && error.code === 'stored_data_invalid',
    )
  })
})

describe('queue v3 raw database policy', () => {
  test('accepts a valid multi-artifact snapshot and rejects malformed, foreign or mismatched metadata', async (t) => {
    const f = await fixture(t)
    const local = metadata(f)
    const localTwo = metadata(f)
    const valid = {
      items: [
        { id: 'inline', kind: 'inline', text: 'raw inline' },
        rawArtifactItem('first', local),
        rawArtifactItem('second', localTwo),
      ],
    }
    const validSeq = rawInsert(f, { payload: valid })
    assert.equal(head(f.db, f.sessionId), validSeq)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 2)

    const cases: { label: string; options: RawOptions }[] = [
      { label: 'missing metadata', options: { payload: { items: [rawArtifactItem('missing', { ...local, artifactId: randomUUID() })] } } },
      { label: 'mismatched checksum', options: { payload: { items: [rawArtifactItem('mismatch', { ...local, checksum: `sha256:${'f'.repeat(64)}` })] } } },
      { label: 'mismatched size', options: { payload: { items: [rawArtifactItem('mismatch', { ...local, byteSize: local.byteSize + 1 })] } } },
      { label: 'mismatched media', options: { payload: { items: [rawArtifactItem('mismatch', { ...local, mediaType: 'application/json' })] } } },
      { label: 'duplicate ids', options: { payload: { items: [
        { id: 'same', kind: 'inline', text: 'one' },
        { id: 'same', kind: 'inline', text: 'two' },
      ] } } },
      { label: 'non-array items', options: { payload: { items: { id: 'not-array' } } } },
      { label: 'null item', options: { payload: { items: [null] } } },
      { label: 'inline over 16 KiB', options: { payload: { items: [{ id: 'big', kind: 'inline', text: 'x'.repeat(INPUT_INLINE_BYTES + 1) }] } } },
      { label: 'inline with artifact field', options: { payload: { items: [{ id: 'mixed', kind: 'inline', text: 'x', artifact: local }] } } },
      { label: 'artifact with text', options: { payload: { items: [{ ...rawArtifactItem('mixed', local), text: 'x' }] } } },
      { label: 'artifact with input descriptor', options: { payload: { items: [{ ...rawArtifactItem('mixed', local), input: { checksum: local.checksum } }] } } },
      { label: 'v3 for another type', options: { type: 'prompt', payload: { origin: 'typed', messageId: 'm', attachmentCount: 0 } } },
      { label: 'v3 reasoning class', options: { class: 'reasoning', payload: { items: [] } } },
      { label: 'v2 without metadata', options: { version: 2, type: 'prompt', payload: {
        origin: 'typed', messageId: 'm', attachmentCount: 0,
        artifact: { ...local, artifactId: randomUUID() },
      } } },
      { label: 'v1 null payload', options: { version: 1, type: 'prompt', payload: null } },
    ]
    for (const { label, options } of cases) {
      const headBefore = head(f.db, f.sessionId)
      const artifactsBefore = (f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n
      assert.throws(() => rawInsert(f, options), /event policy|policy/u, label)
      assert.equal(head(f.db, f.sessionId), headBefore, label)
      assert.equal(
        (f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n,
        artifactsBefore,
        label,
      )
    }

    const foreignDb = await fixture(t)
    const foreign = metadata(foreignDb)
    const headBefore = head(f.db, f.sessionId)
    assert.throws(() => rawInsert(f, { payload: { items: [rawArtifactItem('foreign', foreign)] } }), /event policy|policy/u)
    assert.equal(head(f.db, f.sessionId), headBefore)
  })

  test('preserves v1, v2 and reasoning policies verbatim', async (t) => {
    const f = await fixture(t)
    f.handle.append({ type: 'prompt', data: { origin: 'typed', messageId: 'v1', text: 'v1 inline', attachmentCount: 0 } })
    await appendV2Prompt(f, `${'v'.repeat(INPUT_INLINE_BYTES)}policy-v2`)
    f.handle.append({ type: 'reasoning', data: { messageId: 'r', step: 0, text: 'reasoning' } })
    const input = await descriptor(f.store, f.sessionId, `${'p'.repeat(INPUT_INLINE_BYTES)}policy-v3`)
    appendV3(f, [{ id: 'policy-v3', kind: 'artifact', input }])
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 33)
    assert.match(triggerSql(f.db)!, /event_version NOT IN \(1,2,3\)/u)
    assert.match(triggerSql(f.db)!, /NEW\.class = 'reasoning'/u)
  })
})
