/**
 * Evidence for the K2 review fixes (implementation, architecture and
 * accessibility reviews). Each test fails if its fix is reverted. Every secret
 * here is a generated fake.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { REDACTION_MARKER_CLOSE, REDACTION_MARKER_OPEN, SEARCH_MATCH_OPEN, apiErrorSchema } from '@guanxi/contract'
import { createKernel } from '@guanxi/kernel'
import { egressScrubberPlugin } from '../src/egress/index.ts'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { EgressScrubberError, redactionMarker } from '../src/egress/types.ts'
import { start } from '../src/index.ts'
import { SESSION_LOG_MIGRATION } from '../src/session-log/schema.ts'
import { SESSION_LOG_SERVICE, createSessionLogPlugin } from '../src/session-log/plugin.ts'
import { SessionLog, SessionLogError, titleOf } from '../src/session-log/log.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { buildSnippet, searchTerms } from '../src/session-log/snippet.ts'
import { openDb } from '../src/store/db.ts'

/** The Node server's request bindings with a loopback peer; the session routes refuse any other peer. */
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

function fake(prefix = 'fake-'): string {
  return `${prefix}${randomBytes(12).toString('hex')}`
}

function prompt(text: string, messageId = 'm1') {
  return { type: 'prompt' as const, data: { origin: 'typed' as const, messageId, text, attachmentCount: 0 } }
}

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError || error instanceof EgressScrubberError, String(error))
    return error.code
  }
  assert.fail('expected the call to throw')
}

describe('review fixes: shutdown', () => {
  it('close() finishes while an inspector stream is open', { timeout: 30_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'guanxi-k2-shutdown-'))
    try {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [] })
      server.context.sessionLog!.open('s-stream', { kind: 'agent' }).append(prompt('streamed'))
      const response = await fetch(`${server.url}/api/sessions/s-stream/stream?after=0`)
      assert.equal(response.status, 200)
      const reader = response.body!.getReader()
      await reader.read()
      const startedAt = Date.now()
      await Promise.race([
        server.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('close() hung with an open stream')), 10_000)),
      ])
      assert.ok(Date.now() - startedAt < 10_000)
      await reader.cancel().catch(() => undefined)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('review fixes: scrubbing', () => {
  it('redacts a number whose digits are a registered value, and refuses colliding keys', () => {
    const scrubber = new SecretScrubber()
    scrubber.register('secret://card/main', '4111111111111111')
    const marker = redactionMarker('secret://card/main')
    assert.deepEqual(scrubber.scrub({ card: 4111111111111111, big: 4111111111111111n, other: 42 }), {
      card: marker,
      big: marker,
      other: 42,
    })
    const secret = fake()
    scrubber.register('secret://test/key', secret)
    const parsed = JSON.parse('{"__proto__": {"x": 1}, "plain": 2}') as Record<string, unknown>
    const copy = scrubber.scrub(parsed)
    assert.equal(Object.getPrototypeOf(copy), Object.prototype)
    assert.deepEqual(Object.keys(copy).sort(), ['__proto__', 'plain'])
    assert.equal(
      code(() => scrubber.scrub({ [secret]: 1, [redactionMarker('secret://test/key')]: 2 })),
      'unsupported_value',
      'two keys that scrub to the same text',
    )
  })

  it('stores no numeric secret and no secret re-formed across a join', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    scrubber.register('secret://card/main', '4111111111111111')
    scrubber.register('secret://pass/phrase', 'lookup open sesame')
    scrubber.register('secret://split/value', 'ab12","cd34ef')
    const log = new SessionLog({ db, scrubber })
    const handle = log.open('s-join', { kind: 'agent' })
    handle.append({
      type: 'tool.call',
      data: { toolCallId: 'c1', name: 'lookup', arguments: { q: 'open sesame', card: 4111111111111111 }, source: 'builtin', parsedFrom: 'native', diffPath: null },
    })
    const stored = JSON.stringify(db.prepare('SELECT payload, search_text FROM session_events').all())
    assert.equal(stored.includes('4111111111111111'), false)
    assert.equal(stored.includes('lookup open sesame'), false, 'name + arguments joined in search text')
    assert.equal(
      code(() => handle.append({
        type: 'tool.call',
        data: { toolCallId: 'c2', name: 'x', arguments: { parts: ['ab12', 'cd34ef'] }, source: 'builtin', parsedFrom: 'native', diffPath: null },
      })),
      'invalid_event',
      'a payload whose serialisation re-forms a value is refused',
    )
  })

  it('never builds a title that cuts a secret: titles come from the scrubbed first prompt', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const secret = `sk-proj-${randomBytes(18).toString('hex')}`
    scrubber.register('secret://vault/proj', secret)
    const log = new SessionLog({ db, scrubber })
    db.prepare(
      `INSERT INTO threads (id, title, mode, model, workspace_id, num_ctx, temperature, think, created_at, updated_at)
       VALUES ('t-title', ?, 'chat', 'fixture', NULL, 4096, 0, 'off', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z')`,
    ).run(`Please deploy staging with key ${secret}`.slice(0, 60))
    log.open('t-title', { kind: 'chat', threadId: 't-title' }).append(prompt(`Please deploy staging with key ${secret} now`))
    const title = log.session('t-title')!.title!
    assert.equal(title.includes(secret.slice(0, 12)), false)
    assert.ok(title.endsWith(redactionMarker('secret://vault/proj')), 'the marker is kept whole')
    assert.equal(titleOf(`${'x'.repeat(58)}${redactionMarker('secret://vault/proj')} tail`), `${'x'.repeat(58)}${redactionMarker('secret://vault/proj')}`)
    assert.equal(titleOf('   '), null)
  })
})

describe('review fixes: search snippets', () => {
  it('drops a hit whose term only matched a value registered after the write', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db, scrubber })
    log.open('s-late', { kind: 'agent' }).append(prompt('token sk-live-9f8e7d6c5b4a here'))
    scrubber.register('secret://late/key', 'sk-live-9f8e7d6c5b4a')
    assert.deepEqual(log.search('live', { audience: 'person' }), [], 'searching inside the secret finds nothing')
    assert.deepEqual(log.search('9f8e7d6c5b4a', { audience: 'person' }), [])
    const [hit] = log.search('token', { audience: 'person' })
    assert.ok(hit)
    assert.equal(hit.snippet.includes('sk-live'), false)
    assert.ok(hit.snippet.includes(redactionMarker('secret://late/key')))
  })

  it('never cuts a marker, and highlights only text outside markers', () => {
    const ref = 'secret://vault/openai-key'
    const text = `${'word '.repeat(30)}Use my key ${redactionMarker(ref)} please ${'more '.repeat(30)}`
    for (const query of ['openai', 'secret', 'please', 'Use']) {
      const snippet = buildSnippet(text, searchTerms(query))
      assert.ok(snippet, query)
      const opens = snippet.split(REDACTION_MARKER_OPEN).length - 1
      const closes = snippet.split(REDACTION_MARKER_CLOSE).length - 1
      assert.equal(opens, closes, `${query}: markers are whole`)
      const marker = redactionMarker(ref)
      if (opens > 0) assert.ok(snippet.includes(marker), `${query}: the marker is intact`)
      assert.equal(snippet.slice(snippet.indexOf(REDACTION_MARKER_OPEN), snippet.indexOf(REDACTION_MARKER_CLOSE)).includes(SEARCH_MATCH_OPEN), false)
    }
    assert.equal(buildSnippet('nothing here', searchTerms('absent')), null)
  })
})

describe('review fixes: retention', () => {
  it('the plugin purges at start, and purged reasoning leaves no bytes in the database file', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-k2-purge-'))
    try {
      const path = join(root, 'guanxi.db')
      const db = openDb(path)
      let now = Date.parse('2026-10-20T10:00:00.000Z')
      const clock = () => new Date(now)
      const word = `purgedword${randomBytes(6).toString('hex')}`
      const writer = new SessionLog({ db, scrubber: new SecretScrubber(), clock, reasoningRetentionMs: 60_000 })
      const handle = writer.open('s-bytes', { kind: 'agent' })
      handle.append({ type: 'reasoning', data: { messageId: 'm1', step: 0, text: `${word} `.repeat(50) } })
      handle.close()
      writer.close()
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      assert.ok(readFileSync(path).includes(Buffer.from(word)), 'the word is on disk before the purge')

      now += 61_000
      const kernel = createKernel()
      await kernel.plugin(egressScrubberPlugin)
      await kernel.plugin(createSessionLogPlugin({ db, clock, reasoningRetentionMs: 60_000, purgeIntervalMs: 3_600_000 }))
      const log = kernel.service<SessionLog>(SESSION_LOG_SERVICE)!
      assert.equal(log.counts('s-bytes').purged, 1, 'purged when the plugin started, not 10 minutes later')
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE purged_at IS NOT NULL").get() as { n: number }).n, 1)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      for (const file of [path, `${path}-wal`]) {
        let bytes: Buffer
        try {
          bytes = readFileSync(file)
        } catch {
          continue
        }
        assert.equal(bytes.includes(Buffer.from(word)), false, `${file} still holds purged reasoning`)
      }
      await kernel.dispose()
      db.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('review fixes: boundaries', () => {
  it('pins migration 29, so a rewrite after it ships fails a test', () => {
    assert.equal(createHash('sha256').update(SESSION_LOG_MIGRATION).digest('hex'), 'd1e17096de8c2c81de075415cada99514fe219a23d0ebae4236cd0e23b57925a')
  })

  it('refuses control characters in search and unsafe session ids', async () => {
    const db = openDb(':memory:')
    const log = new SessionLog({ db, scrubber: new SecretScrubber() })
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    for (const path of ['/api/sessions/search?q=a%00b', '/api/sessions/search?q=a%0Ab', '/api/sessions/bad%20id', '/api/sessions/bad%22id/export']) {
      const response = await app.request(path, {}, LOOPBACK)
      assert.equal(response.status, 400, path)
      assert.equal(apiErrorSchema.parse(await response.json()).code, 'validation_failed', path)
    }
  })

  it('the system writer refuses to run outside a transaction', () => {
    const db = openDb(':memory:')
    const log = new SessionLog({ db, scrubber: new SecretScrubber() })
    assert.equal(code(() => log.appendAsSystemWithin('s-tx', { kind: 'agent' }, prompt('outside'))), 'invalid_event')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0)
  })

  it('scrubs bytes with overlapping values and keeps marker_collision errors free of the value', () => {
    const scrubber = new SecretScrubber()
    scrubber.register('secret://b/left', 'abcdef12')
    scrubber.register('secret://b/right', 'ef123456')
    const out = Buffer.from(scrubber.scrub(Buffer.from('>abcdef123456<'))).toString('utf8')
    assert.equal(out, `>${redactionMarker('secret://b/left')}${redactionMarker('secret://b/right')}<`)
    for (const [ref, value] of [['secret://vault/abcdefgh', 'abcdefgh'], ['secret://x/y', 'REDACTED secret']] as const) {
      try {
        scrubber.register(ref, value)
        assert.fail('expected marker_collision')
      } catch (error) {
        assert.ok(error instanceof EgressScrubberError && error.code === 'marker_collision')
        assert.equal(error.message.includes(value), false)
      }
    }
  })
})
