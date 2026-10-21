/**
 * Session-owned input artifacts (K4 input slice): migration 33, the pinned
 * payload store, v2 append atomicity, stale-writer safety, ancestor swaps,
 * integrity failures and orphan reaping. Every secret/path here is generated.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  sessionEventDataV2Schemas,
  sessionEventSchema,
  type SessionEvent,
} from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog, type SessionHandle } from '../src/session-log/log.ts'
import {
  SessionInputError,
  SessionInputStore,
  utf8Excerpt,
  type SessionInputArtifactDescriptor,
} from '../src/session-log/input-artifacts.ts'
import { MIGRATIONS, openDb, type Db } from '../src/store/db.ts'

const MEDIA_TEXT = 'text/plain; charset=utf-8' as const
const MEDIA_JSON = 'application/json' as const

function sessionIdHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

interface Fixture {
  root: string
  dataDir: string
  db: Db
  log: SessionLog
  store: SessionInputStore
  scrubber: SecretScrubber
  handle: SessionHandle
  sessionId: string
}

async function fixture(
  test: { after(fn: () => unknown): void },
  options: {
    sessionId?: string
    hooks?: ConstructorParameters<typeof SessionInputStore>[0]['hooks']
    writerTtlMs?: number
    clock?: () => Date
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-input-artifacts-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  await mkdir(dataDir)
  const db = openDb(join(root, 'guanxi.db'))
  const scrubber = new SecretScrubber()
  const log = new SessionLog({ db, scrubber, writerTtlMs: options.writerTtlMs, clock: options.clock })
  const sessionId = options.sessionId ?? 'session-input'
  const handle = log.open(sessionId, { kind: 'agent' })
  const store = new SessionInputStore({ dataDir, db, hooks: options.hooks })
  test.after(() => {
    try { handle.close() } catch { /* already closed */ }
    db.close()
  })
  return { root, dataDir, db, log, store, scrubber, handle, sessionId }
}

async function descriptor(
  store: SessionInputStore,
  sessionId: string,
  text: string,
  mediaType: typeof MEDIA_TEXT | typeof MEDIA_JSON = MEDIA_TEXT,
): Promise<SessionInputArtifactDescriptor> {
  const written = await store.write(sessionId, text, mediaType)
  const excerpt = utf8Excerpt(text)
  return {
    checksum: written.checksum,
    byteSize: written.byteSize,
    mediaType,
    excerpt,
  }
}

function promptV2(descriptor: SessionInputArtifactDescriptor, messageId = 'm-v2') {
  return {
    input: {
      type: 'prompt' as const,
      data: { origin: 'typed' as const, messageId, attachmentCount: 0 },
    },
    options: { eventVersion: 2 as const, inputArtifact: descriptor },
  }
}

function toolCallV2(descriptor: SessionInputArtifactDescriptor, toolCallId = 'call-v2') {
  return {
    input: {
      type: 'tool.call' as const,
      data: {
        toolCallId,
        name: 'file_write',
        source: 'builtin' as const,
        parsedFrom: 'native' as const,
        diffPath: null,
      },
    },
    options: { eventVersion: 2 as const, inputArtifact: descriptor },
  }
}

function appendV2<T extends { input: unknown; options: unknown }>(handle: SessionHandle, value: T) {
  return handle.append(value.input as never, value.options as never)
}

function codeOf(run: () => unknown): string | null {
  try {
    run()
  } catch (error) {
    return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : String(error)
  }
  return null
}

describe('session input artifacts: migration 33', () => {
  it('appends migration 33 with the artifact table and a strict v2 event policy', () => {
    assert.equal(MIGRATIONS.length, 33)
    const db = openDb(':memory:')
    try {
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 33)
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_input_artifacts'").get()
      assert.ok(table)
      const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_input_artifacts_session'").get()
      assert.ok(index)
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='session_events_policy_insert'").get() as { sql: string }).sql
      assert.match(sql, /event_version NOT IN \(1,2\)/u)
      assert.match(sql, /session_input_artifacts/u)
      assert.match(sql, /json_type/u)
    } finally {
      db.close()
    }
  })

  it('rolls back migration 33 on an incompatible pre-existing table without leaving a guard', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-migration-33-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const db = openDb(path)
    db.exec(`
      DROP TABLE session_input_artifacts;
      CREATE TABLE session_input_artifacts (session_id TEXT);
      PRAGMA user_version = 32;
    `)
    db.close()
    assert.throws(() => openDb(path), /Миграция 33/u)
    const raw = new DatabaseSync(path)
    try {
      assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 32)
      assert.deepEqual(
        (raw.prepare('PRAGMA table_info(session_input_artifacts)').all() as { name: string }[]).map((column) => column.name),
        ['session_id'],
      )
      assert.equal(
        (raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'migration_33_shape_guard'").get() as { n: number }).n,
        0,
      )
    } finally {
      raw.close()
    }
  })

  it('rejects v2 events for other types, missing artifact rows and v2 without an artifact object', async (test) => {
    const f = await fixture(test)
    const epoch = f.handle.epoch
    const head = (f.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(f.sessionId) as { last_seq: number }).last_seq
    const insert = (type: string, payload: string, version = 2, seq = head + 1) => f.db.prepare(
      `INSERT INTO session_events (session_id, seq, id, event_version, type, class, writer_epoch,
         payload, payload_sha256, search_text, redactions, created_at)
       VALUES (?, ?, ?, ?, ?, 'standard', ?, ?, ?, NULL, 0, '2026-10-22T10:00:00.000Z')`,
    ).run(
      f.sessionId,
      seq,
      randomBytes(16).toString('hex'),
      version,
      type,
      epoch,
      payload,
      createHash('sha256').update(payload).digest('hex'),
    )
    assert.throws(
      () => insert('assistant.message', JSON.stringify({ messageId: 'm', step: 0, text: 'inline' })),
      /event policy/u,
    )
    assert.throws(
      () => insert('prompt', JSON.stringify({ origin: 'typed', messageId: 'm', attachmentCount: 0 })),
      /event policy/u,
    )
    assert.throws(
      () => insert('prompt', JSON.stringify({
        origin: 'typed',
        messageId: 'm',
        attachmentCount: 0,
        artifact: {
          artifactId: '11111111-1111-4111-8111-111111111111',
          checksum: `sha256:${'a'.repeat(64)}`,
          byteSize: 20 * 1024,
          mediaType: MEDIA_TEXT,
          excerpt: 'x',
          excerptBytes: 1,
        },
      })),
      /event policy/u,
    )
    assert.deepEqual(Object.keys(sessionEventDataV2Schemas).sort(), ['prompt', 'tool.call'])
  })
})

describe('session input artifacts: v2 append', () => {
  it('stores oversized prompt bytes out of SQLite/FTS/title and carries only the excerpt', async (test) => {
    const f = await fixture(test)
    const tail = `TAIL-${randomBytes(12).toString('hex')}`
    const prompt = `${'P'.repeat(INPUT_INLINE_BYTES)}${tail}`
    const ref = await descriptor(f.store, f.sessionId, prompt)
    const result = appendV2(f.handle, promptV2(ref))
    assert.equal(result.event.version, 2)
    const event = result.event
    assert.equal(event.type, 'prompt')
    if (event.type !== 'prompt' || event.version !== 2) throw new Error('unreachable')
    assert.equal('text' in event.data, false)
    assert.equal(event.data.artifact.checksum, ref.checksum)
    assert.equal(event.data.artifact.byteSize, Buffer.byteLength(prompt))
    assert.equal(event.data.artifact.excerptBytes, Buffer.byteLength(ref.excerpt))
    assert.ok(event.data.artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
    assert.equal(event.data.artifact.excerpt.includes(tail), false)

    const row = f.db.prepare("SELECT payload, search_text FROM session_events WHERE type='prompt'").get() as { payload: string; search_text: string | null }
    assert.equal(row.payload.includes(tail), false)
    assert.equal((row.search_text ?? '').includes(tail), false)
    assert.equal(f.log.search(tail, { audience: 'person' }).length, 0)
    assert.equal(JSON.stringify(f.log.list().sessions).includes(tail), false)
    const stored = f.db.prepare('SELECT * FROM session_input_artifacts').all() as { checksum: string; byte_size: number; media_type: string }[]
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.checksum, ref.checksum)
    assert.equal(stored[0]!.byte_size, Buffer.byteLength(prompt))
    assert.equal(stored[0]!.media_type, MEDIA_TEXT)
    const read = await f.store.read(f.sessionId, event.data.artifact)
    assert.deepEqual(Buffer.from(read), Buffer.from(prompt))
  })

  it('keeps exactly the inline threshold at v1 and one byte more at v2, and reuses one metadata row', async (test) => {
    const f = await fixture(test)
    const exact = 'x'.repeat(INPUT_INLINE_BYTES)
    const inline = f.handle.append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-exact', text: exact, attachmentCount: 0 } })
    assert.equal(inline.event.version, 1)

    const over = `${'y'.repeat(INPUT_INLINE_BYTES)}z`
    const first = await descriptor(f.store, f.sessionId, over)
    const one = appendV2(f.handle, promptV2(first, 'm-over-1'))
    const second = await descriptor(f.store, f.sessionId, over)
    const two = appendV2(f.handle, promptV2(second, 'm-over-2'))
    assert.equal(one.event.version, 2)
    assert.equal(two.event.version, 2)
    if (one.event.type !== 'prompt' || one.event.version !== 2 || two.event.type !== 'prompt' || two.event.version !== 2) throw new Error('unreachable')
    assert.equal(one.event.data.artifact.artifactId, two.event.data.artifact.artifactId)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 1)
  })

  it('stores canonical JSON tool arguments and never the full argument text in the event', async (test) => {
    const f = await fixture(test)
    const tail = `ARG-TAIL-${randomBytes(12).toString('hex')}`
    const args = JSON.stringify({ path: 'big.txt', content: `${'a'.repeat(INPUT_INLINE_BYTES)}${tail}` })
    const ref = await descriptor(f.store, f.sessionId, args, MEDIA_JSON)
    const result = appendV2(f.handle, toolCallV2(ref))
    assert.equal(result.event.version, 2)
    const event = result.event
    if (event.type !== 'tool.call' || event.version !== 2) throw new Error('unreachable')
    assert.equal('arguments' in event.data, false)
    assert.equal(event.data.artifact.mediaType, MEDIA_JSON)
    assert.equal(event.data.artifact.excerpt.includes(tail), false)
    assert.equal(JSON.stringify(f.log.readAll(f.sessionId, 'person')).includes(tail), false)
    const bytes = await f.store.read(f.sessionId, event.data.artifact)
    assert.equal(Buffer.from(bytes).toString('utf8'), args)
  })
})

describe('session input artifacts: writer and crash safety', () => {
  it('never unlinks a published digest when the appending writer is fenced', async (test) => {
    let now = Date.parse('2026-10-22T10:00:00.000Z')
    const clock = () => new Date(now)
    const f = await fixture(test, { clock, writerTtlMs: 10_000 })
    const text = `${'s'.repeat(INPUT_INLINE_BYTES)}${randomBytes(8).toString('hex')}`
    const ref = await descriptor(f.store, f.sessionId, text)
    const dir = f.store.directoryFor(f.sessionId)
    now += 20_000
    const successor = new SessionLog({ db: f.db, scrubber: f.scrubber, clock, writerTtlMs: 10_000, writer: { id: 'successor', pid: 2, host: 'fixture' } })
    const handle = successor.open(f.sessionId, { kind: 'agent' })
    test.after(() => { try { handle.close() } catch { /* already closed */ } })
    const committed = appendV2(handle, promptV2(ref))
    assert.equal(committed.event.version, 2)
    assert.equal(codeOf(() => appendV2(f.handle, promptV2(ref))), 'writer_fenced')
    assert.deepEqual((await readdir(dir)).filter((name) => !name.startsWith('.partial-')), [ref.checksum.slice(7)])
    const bytes = await successor.readAll(f.sessionId, 'person')
    const prompt = bytes.find((event) => event.type === 'prompt')
    if (prompt?.type !== 'prompt' || prompt.version !== 2) throw new Error('expected v2 prompt')
    assert.deepEqual(Buffer.from(await f.store.read(f.sessionId, prompt.data.artifact)), Buffer.from(text))
  })

  it('leaves the published digest and existing rows untouched when append fails, then reuses it', async (test) => {
    const f = await fixture(test)
    const text = `${'r'.repeat(INPUT_INLINE_BYTES)}${randomBytes(8).toString('hex')}`
    const ref = await descriptor(f.store, f.sessionId, text)
    f.handle.close()
    assert.equal(codeOf(() => appendV2(f.handle, promptV2(ref))), 'writer_fenced')
    const dir = f.store.directoryFor(f.sessionId)
    assert.deepEqual(await readdir(dir), [ref.checksum.slice(7)])
    const handle = f.log.open(f.sessionId, { kind: 'agent' })
    test.after(() => { try { handle.close() } catch { /* already closed */ } })
    const committed = appendV2(handle, promptV2(ref))
    assert.equal(committed.event.version, 2)
    const event = committed.event
    if (event.type !== 'prompt' || event.version !== 2) throw new Error('unreachable')
    assert.deepEqual(Buffer.from(await f.store.read(f.sessionId, event.data.artifact)), Buffer.from(text))
  })

  it('rolls back the input metadata row with a refused event insert and keeps the published blob', async (test) => {
    const f = await fixture(test)
    const text = `${'a'.repeat(INPUT_INLINE_BYTES)}atomic`
    const ref = await descriptor(f.store, f.sessionId, text)
    const dir = f.store.directoryFor(f.sessionId)
    f.db.exec(`CREATE TRIGGER fixture_refuse_v2 BEFORE INSERT ON session_events
      WHEN NEW.event_version = 2 BEGIN SELECT RAISE(ABORT, 'fixture refused v2'); END;`)
    assert.throws(() => appendV2(f.handle, promptV2(ref)), /fixture refused v2/u)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 0)
    assert.deepEqual(await readdir(dir), [ref.checksum.slice(7)])
  })

  it('rejects a v2 append that supplies no artifact descriptor without writing a row', async (test) => {
    const f = await fixture(test)
    const before = (f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n
    assert.equal(
      codeOf(() => f.handle.append({
        type: 'prompt',
        data: { origin: 'typed', messageId: 'm-no-ref', attachmentCount: 0 },
        eventVersion: 2,
      } as never)),
      'invalid_event',
    )
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, before)
  })
})

describe('session input artifacts: pinned directory', () => {
  it('puts zero bytes and zero temp files into a directory swapped before the helper handshake', async (test) => {
    const attacker = join(tmpdir(), `guanxi-attacker-${randomBytes(8).toString('hex')}`)
    test.after(() => rm(attacker, { recursive: true, force: true }))
    await mkdir(attacker)
    let sessionDir = ''
    let moved = ''
    const f = await fixture(test, {
      hooks: {
        beforeHelperStart: async () => {
          sessionDir = f.store.directoryFor(f.sessionId)
          moved = `${sessionDir}-moved`
          await rename(sessionDir, moved)
          await symlink(attacker, sessionDir)
        },
      },
    })
    const text = `${'q'.repeat(INPUT_INLINE_BYTES)}swapped-${randomBytes(8).toString('hex')}`
    await assert.rejects(
      f.store.write(f.sessionId, text, MEDIA_TEXT),
      (error: unknown) => error instanceof SessionInputError && error.code === 'unsafe_storage' && !error.message.includes(attacker),
    )
    assert.deepEqual(await readdir(attacker), [])
    assert.deepEqual((await readdir(moved)).filter((name) => name.startsWith('.partial-')), [])
  })

  it('detects an ancestor root swap before any byte and leaves the replacement empty', async (test) => {
    const f = await fixture(test)
    const first = await descriptor(f.store, f.sessionId, `${'g'.repeat(INPUT_INLINE_BYTES)}first`)
    assert.ok(first.checksum)
    const root = join(f.dataDir, 'session-artifacts')
    const moved = `${root}-moved`
    await rename(root, moved)
    await mkdir(root)
    const attackerSession = join(root, sessionIdHash(f.sessionId))
    await mkdir(attackerSession)
    const text = `${'h'.repeat(INPUT_INLINE_BYTES)}root-swap`
    await assert.rejects(
      f.store.write(f.sessionId, text, MEDIA_TEXT),
      (error: unknown) => error instanceof SessionInputError && error.code === 'unsafe_storage',
    )
    assert.deepEqual(await readdir(attackerSession), [])
    assert.deepEqual(await readdir(moved), [sessionIdHash(f.sessionId)])
  })

  it('keeps the helper cwd pinned when the path is swapped after the handshake and fails closed', async (test) => {
    const attacker = join(tmpdir(), `guanxi-attacker-${randomBytes(8).toString('hex')}`)
    test.after(() => rm(attacker, { recursive: true, force: true }))
    await mkdir(attacker)
    let swapped = false
    let moved = ''
    const f = await fixture(test, {
      hooks: {
        beforeWrite: async () => {
          if (swapped) return
          swapped = true
          const sessionDir = f.store.directoryFor(f.sessionId)
          moved = `${sessionDir}-moved`
          await rename(sessionDir, moved)
          await symlink(attacker, sessionDir)
        },
      },
    })
    const text = `${'w'.repeat(INPUT_INLINE_BYTES)}payload-${randomBytes(8).toString('hex')}`
    await assert.rejects(
      f.store.write(f.sessionId, text, MEDIA_TEXT),
      (error: unknown) => error instanceof SessionInputError && error.code === 'unsafe_storage' && !error.message.includes(attacker),
    )
    assert.deepEqual(await readdir(attacker), [])
    // The bytes went to the originally pinned directory, never to the attacker.
    const names = await readdir(moved)
    assert.equal(names.some((name) => name.startsWith('.partial-')), false)
    const digest = names.find((name) => /^[0-9a-f]{64}$/u.test(name))
    assert.ok(digest)
    assert.equal((await readFile(join(moved, digest!))).includes(Buffer.from('payload-')), true)
  })

  it('fails closed on truncated, corrupt, foreign-session and symlinked artifacts', async (test) => {
    const f = await fixture(test)
    const text = `${'i'.repeat(INPUT_INLINE_BYTES)}integrity`
    const ref = await descriptor(f.store, f.sessionId, text)
    const event = appendV2(f.handle, promptV2(ref)).event
    if (event.type !== 'prompt' || event.version !== 2) throw new Error('unreachable')
    const dir = f.store.directoryFor(f.sessionId)
    const path = join(dir, ref.checksum.slice(7))
    assert.equal((await stat(path)).mode & 0o777, 0o400)
    await chmod(path, 0o600)
    await truncate(path, 10)
    await assert.rejects(
      f.store.read(f.sessionId, event.data.artifact),
      (error: unknown) => error instanceof SessionInputError && error.code === 'integrity_mismatch',
    )
    await assert.rejects(
      f.store.read('unknown-session', event.data.artifact),
      (error: unknown) => error instanceof SessionInputError && error.code === 'not_found',
    )
    await rm(path)
    const outside = join(tmpdir(), `guanxi-outside-${randomBytes(8).toString('hex')}`)
    test.after(() => rm(outside, { recursive: true, force: true }))
    await writeFile(outside, text)
    await symlink(outside, path)
    await assert.rejects(
      f.store.read(f.sessionId, event.data.artifact),
      (error: unknown) => error instanceof SessionInputError && error.code === 'unsafe_storage',
    )
  })
})

describe('session input artifacts: orphan reaping', () => {
  it('removes only directories with no session row or live owner and keeps stale temps away from live writers', async (test) => {
    const f = await fixture(test)
    const root = join(f.dataDir, 'session-artifacts')
    const orphan = join(root, sessionIdHash('orphan-session'))
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'bytes'), 'orphan')
    const live = join(root, sessionIdHash('live-session'))
    await mkdir(live, { recursive: true })
    await writeFile(join(live, 'bytes'), 'live')
    const stored = join(root, sessionIdHash(f.sessionId))
    await mkdir(stored, { recursive: true })
    await writeFile(join(stored, '.partial-stale'), 'temp')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(join(stored, '.partial-stale'), old, old)
    // The fixture's own writer must be released before stale temps are eligible.
    f.handle.close()
    let homeChecks = 0
    const result = await f.store.reap({
      isLive: (id) => id === 'live-session',
      liveSessionIds: ['live-session'],
      assertHome: () => { homeChecks++ },
      tempGraceMs: 60_000,
    })
    assert.equal(result.removedDirectories, 1)
    assert.deepEqual(await readdir(orphan).catch(() => []), [])
    assert.deepEqual(await readdir(live), ['bytes'])
    assert.deepEqual(await readdir(stored), [])
    assert.ok(homeChecks > 0)
  })

  it('keeps a quarantined directory if a session row appears before removal', async (test) => {
    const f = await fixture(test)
    const root = join(f.dataDir, 'session-artifacts')
    const late = join(root, sessionIdHash('late-session'))
    await mkdir(late, { recursive: true })
    await writeFile(join(late, 'bytes'), 'late')
    const result = await f.store.reap({
      isLive: () => false,
      assertHome: () => undefined,
      // Simulate a session row appearing between the scan and the rename.
      beforeQuarantineRemove: async () => {
        f.db.prepare("INSERT INTO sessions (id, kind, thread_id, created_at, last_seq) VALUES ('late-session', 'agent', NULL, '2026-10-22T10:00:00.000Z', 0)").run()
      },
    })
    assert.equal(result.removedDirectories, 0)
    assert.equal(result.quarantinedKept, 1)
    const entries = await readdir(root)
    assert.equal(entries.some((name) => name === sessionIdHash('late-session')), false)
    const kept = entries.find((name) => name.startsWith('.orphan-'))
    assert.ok(kept)
    assert.deepEqual(await readdir(join(root, kept!)), ['bytes'])
  })
})

describe('session input artifacts: contract helpers', () => {
  it('cuts excerpts on a UTF-8 boundary and never exceeds the bound', () => {
    const text = `${'a'.repeat(INPUT_EXCERPT_BYTES - 1)}ЁЁ`
    const excerpt = utf8Excerpt(text)
    assert.ok(Buffer.byteLength(excerpt) <= INPUT_EXCERPT_BYTES)
    assert.equal(excerpt.endsWith('a'), true)
    assert.equal(Buffer.from(excerpt, 'utf8').toString('utf8'), excerpt)
    assert.equal(utf8Excerpt('short'), 'short')
  })

  it('round-trips a parsed v2 event through the contract schema', async (test) => {
    const f = await fixture(test)
    const ref = await descriptor(f.store, f.sessionId, `${'v'.repeat(INPUT_INLINE_BYTES)}`)
    const event = appendV2(f.handle, promptV2(ref)).event
    assert.equal(sessionEventSchema.safeParse(event).success, true)
    const v2 = event as Extract<SessionEvent, { version: 2; type: 'prompt' }>
    assert.equal(v2.data.artifact.excerptBytes, Buffer.byteLength(v2.data.artifact.excerpt))
  })
})
