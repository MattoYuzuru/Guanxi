/**
 * Fixes for the GPT/Codex cross-family review of K2 (REVIEW-GPT.md, R1–R6).
 * Each test reproduces the reviewer's scenario and fails without its fix.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog, SessionLogError } from '../src/session-log/log.ts'
import { querySessionLog } from '../src/session-log/query-tool.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb } from '../src/store/db.ts'

/** The Node server's request env with a loopback peer, for routes that check it. */
export const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

function fake(): string {
  return `fake-${randomBytes(12).toString('hex')}`
}

function prompt(text: string) {
  return { type: 'prompt' as const, data: { origin: 'typed' as const, messageId: 'm1', text, attachmentCount: 0 } }
}

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError, String(error))
    return error.code
  }
  assert.fail('expected the call to throw')
}

describe('R1: event identifiers never carry a secret', () => {
  it('refuses a secret in spanId, parentSpanId, jobId, the idempotency key or the session id, and stores nothing', () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const secret = fake()
    scrubber.register('secret://test/id', secret)
    const log = new SessionLog({ db, scrubber })
    const handle = log.open('s-ids', { kind: 'agent' })
    const head = () => (db.prepare("SELECT last_seq FROM sessions WHERE id = 's-ids'").get() as { last_seq: number }).last_seq
    const before = head()
    assert.equal(code(() => handle.append({ ...prompt('harmless'), spanId: `tool:${secret}` })), 'invalid_event')
    assert.equal(code(() => handle.append({ ...prompt('harmless'), parentSpanId: `step:${secret}` })), 'invalid_event')
    assert.equal(code(() => handle.append({ ...prompt('harmless'), jobId: secret })), 'invalid_event')
    assert.equal(code(() => handle.append(prompt('harmless'), { idempotencyKey: secret })), 'invalid_event')
    assert.equal(code(() => log.open(`s-${secret}`, { kind: 'agent' })), 'invalid_event')
    assert.equal(head(), before)
    const stored = JSON.stringify(db.prepare('SELECT * FROM session_events').all()) +
      JSON.stringify(db.prepare('SELECT * FROM sessions').all())
    assert.equal(stored.includes(secret), false)
  })

  it('hides a value registered after the write in every returned identifier: reads, query tool, HTTP', async () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber()
    const late = fake()
    const log = new SessionLog({ db, scrubber })
    const handle = log.open('s-late-ids', { kind: 'agent' })
    handle.append({ ...prompt('needle in a span'), spanId: `tool:${late}`, parentSpanId: `step:${late}`, jobId: late })
    scrubber.register('secret://test/late', late)

    for (const audience of ['person', 'local_agent', 'remote_agent'] as const) {
      assert.equal(JSON.stringify(log.readAll('s-late-ids', audience)).includes(late), false, audience)
    }
    assert.equal(JSON.stringify(querySessionLog(log, 's-late-ids', 'remote_agent', { limit: 100 })).includes(late), false)
    assert.equal(JSON.stringify(log.search('needle', { audience: 'person' })).includes(late), false)

    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    for (const path of ['/events?after=0', '/export', '/spans', '']) {
      const response = await app.request(`/api/sessions/s-late-ids${path}`, {}, LOOPBACK_ENV)
      assert.equal(response.status, 200, path)
      assert.equal((await response.text()).includes(late), false, path)
    }
    const listed = await app.request('/api/sessions', {}, LOOPBACK_ENV)
    assert.equal((await listed.text()).includes(late), false)
  })
})

describe('R4: a readiness change during the catch-up hand-off cannot strand the backlog', () => {
  it('re-arms when a new source closes the gate between ready and the queued callback', async () => {
    const { ChatSessionMirror } = await import('../src/session-log/chat-mirror.ts')
    const { JobStore } = await import('../src/store/jobs.ts')
    const { ThreadStore } = await import('../src/store/threads.ts')
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber({ expectedSources: ['vault'] })
    const log = new SessionLog({ db, scrubber })
    const mirror = new ChatSessionMirror({ log, db })
    const jobs = new JobStore(db, { sessionMirror: mirror })
    const threadId = new ThreadStore(db).create({
      title: 'Race', mode: 'chat', model: 'fixture', workspaceId: null,
      options: { numCtx: 4_096, temperature: 0, think: 'off' },
    }).id
    jobs.createChat({
      threadId,
      idempotencyScope: `chat:${threadId}:send:v1`,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: 'fixture',
      input: { content: 'race prompt', attachments: [], autoApprove: null },
      derivedTitle: 'Race',
    })
    assert.equal(mirror.backlog().length, 1)

    scrubber.ready('vault')
    scrubber.expect('env.shell') // synchronously, before the queued readiness callback runs
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(mirror.backlog().length, 1, 'still gated')
    scrubber.ready('env.shell')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(scrubber.isReady(), true)
    assert.deepEqual(mirror.backlog(), [], 'the backlog drained after the second ready transition')
    assert.deepEqual(log.readAll(threadId, 'person').map((event) => event.type), ['session.created', 'writer.acquired', 'prompt', 'job.lifecycle'])
  })
})

describe('R5: a closed log is not retained by a readiness wait that never resolves', () => {
  it('releases closed logs and mirrors while a declared source stays pending forever', async () => {
    const { setFlagsFromString } = await import('node:v8')
    const { runInNewContext } = await import('node:vm')
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const { ChatSessionMirror } = await import('../src/session-log/chat-mirror.ts')
    const { JobStore } = await import('../src/store/jobs.ts')
    const { ThreadStore } = await import('../src/store/threads.ts')

    const db = openDb(':memory:')
    const scrubber = new SecretScrubber({ expectedSources: ['vault'] }) // never becomes ready
    // Each log and mirror is created in its own call, so no frame of this test keeps one alive.
    const make = (index: number): WeakRef<object>[] => {
      const log = new SessionLog({ db, scrubber })
      const mirror = new ChatSessionMirror({ log, db })
      const threadId = new ThreadStore(db).create({
        title: `Leak ${index}`, mode: 'chat', model: 'fixture', workspaceId: null,
        options: { numCtx: 4_096, temperature: 0, think: 'off' },
      }).id
      new JobStore(db, { sessionMirror: mirror }).createChat({
        threadId,
        idempotencyScope: `chat:${threadId}:send:v1`,
        idempotencyKey: crypto.randomUUID(),
        requestFingerprint: 'fixture',
        input: { content: `deferred ${index}`, attachments: [], autoApprove: null },
        derivedTitle: 'Leak',
      })
      log.close()
      return [new WeakRef(log), new WeakRef(mirror)]
    }
    const refs = [0, 1, 2, 3, 4].flatMap(make)
    for (let round = 0; round < 10 && refs.some((ref) => ref.deref() !== undefined); round++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      gc()
    }
    assert.equal(refs.filter((ref) => ref.deref() !== undefined).length, 0, 'closed logs and mirrors were collected')
    assert.equal(scrubber.isReady(), false)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_mirror_backlog').get() as { n: number }).n, 5, 'the deferrals stay durable')
  })
})

describe('R6: the query tool applies its cursor and type filters before its limits', () => {
  it('finds the 101st hit after a cursor, and a type outside the first 100 unfiltered hits', () => {
    const db = openDb(':memory:')
    const log = new SessionLog({ db, scrubber: new SecretScrubber() })
    const handle = log.open('s-many', { kind: 'agent' })
    for (let index = 0; index < 101; index++) handle.append(prompt(`needle number ${index}`))
    const last = log.read('s-many', { audience: 'person', limit: 1 }).lastSeq
    assert.equal(last, 103)
    const after = querySessionLog(log, 's-many', 'remote_agent', { text: 'needle', afterSeq: 102, limit: 5 })
    assert.deepEqual(after.events.map((event) => event.seq), [103])

    handle.append({ type: 'tool.result', data: { toolCallId: 't1', status: 'ok', result: 'needle in a result', error: null, durationMs: 1 } })
    const typed = querySessionLog(log, 's-many', 'remote_agent', { text: 'needle', types: ['tool.result'], limit: 5 })
    assert.deepEqual(typed.events.map((event) => event.type), ['tool.result'])
    const firstFive = querySessionLog(log, 's-many', 'local_agent', { types: ['prompt'], afterSeq: 50, limit: 5 })
    assert.deepEqual(firstFive.events.map((event) => event.seq), [51, 52, 53, 54, 55])
  })
})

describe('R3: the person audience answers loopback peers only', () => {
  it('refuses a request from a non-loopback socket peer, and with no known peer, and keeps local access', async () => {
    const db = openDb(':memory:')
    const log = new SessionLog({ db, scrubber: new SecretScrubber() })
    log.open('s-peer', { kind: 'agent' }).append({ type: 'reasoning', data: { messageId: 'm', step: 0, text: 'peer-only reasoning' } })
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const peer = (remoteAddress: string | undefined) => ({ incoming: { socket: { remoteAddress } } })
    const refused = [peer('192.168.1.20'), peer('10.0.0.5'), peer('::ffff:192.168.1.20'), peer('fe80::1'), peer(undefined), undefined]
    for (const bindings of refused) {
      const response = await app.request('/api/sessions/s-peer/events', {}, bindings)
      assert.equal(response.status, 403, String(bindings?.incoming.socket.remoteAddress))
      const body = await response.text()
      assert.equal(body.includes('peer-only reasoning'), false)
      assert.match(body, /loopback_only/)
    }
    for (const address of ['127.0.0.1', '127.10.0.1', '::1', '::ffff:127.0.0.1']) {
      const response = await app.request('/api/sessions/s-peer/events', {}, peer(address))
      assert.equal(response.status, 200, address)
    }
  })

  it('a server listening on 0.0.0.0 refuses the inspector through a private address (the reviewer case)', { timeout: 30_000 }, async () => {
    const { networkInterfaces, tmpdir } = await import('node:os')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { start } = await import('../src/index.ts')
    const lan = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    const dataDir = await mkdtemp(join(tmpdir(), 'guanxi-k2-peer-'))
    const server = await start({ port: 0, host: '0.0.0.0', dataDir, webDir: dataDir, devOrigins: [] })
    try {
      server.context.sessionLog!.open('network-test', { kind: 'agent' }).append({
        type: 'reasoning', data: { messageId: 'm', step: 0, text: 'network reasoning' },
      })
      const local = await fetch(`http://127.0.0.1:${server.port}/api/sessions/network-test/events`)
      assert.equal(local.status, 200)
      assert.ok((await local.text()).includes('network reasoning'), 'local access keeps working')
      if (lan) {
        const remote = await fetch(`http://${lan.address}:${server.port}/api/sessions/network-test/events`)
        assert.equal(remote.status, 403)
        assert.equal((await remote.text()).includes('network reasoning'), false)
      }
    } finally {
      await server.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
