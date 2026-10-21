/**
 * K2 focused GPT re-check (REVIEW-GPT-2): one regression test per finding
 * N1–N4, each built on the reviewer's scenario and failing without its fix.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  apiErrorSchema,
  listSessionsResponse,
  sessionSearchResponse,
  type ChatJobInputSnapshot,
} from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { ChatSessionMirror } from '../src/session-log/chat-mirror.ts'
import { SessionLog } from '../src/session-log/log.ts'
import { createSessionQueryTool, querySessionLog } from '../src/session-log/query-tool.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb, type Db } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ThreadStore } from '../src/store/threads.ts'

const SECRET = `fake-${randomBytes(16).toString('hex')}`
const REF = 'secret://vault/planted' as const

/** The Node server's request bindings with a loopback peer; the session routes refuse any other peer. */
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function busyWait(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Spin: the hook runs inside a synchronous Job transaction.
  }
}

/** A mirror whose prompt hook runs late, as on a loaded machine; no source row changes. */
class SlowPromptMirror extends ChatSessionMirror {
  override recordChatCreated(input: Parameters<ChatSessionMirror['recordChatCreated']>[0]): void {
    busyWait(20)
    super.recordChatCreated(input)
  }
}

function setup(options: { ready: boolean; slow?: boolean; db?: Db }) {
  const db = options.db ?? openDb(':memory:')
  const scrubber = new SecretScrubber({ expectedSources: options.ready ? [] : ['vault'] })
  const log = new SessionLog({ db, scrubber })
  const mirror = options.slow ? new SlowPromptMirror({ log, db }) : new ChatSessionMirror({ log, db })
  const jobs = new JobStore(db, { sessionMirror: mirror })
  return { db, scrubber, log, mirror, jobs }
}

function thread(db: Db, mode: 'chat' | 'agent' = 'chat'): string {
  return new ThreadStore(db).create({
    title: 'Re-check',
    mode,
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'high' },
  }).id
}

function send(jobs: JobStore, threadId: string, content: string) {
  const input: ChatJobInputSnapshot = { content, attachments: [], autoApprove: null }
  return jobs.createChat({
    threadId,
    idempotencyScope: `chat:${threadId}:send:v1`,
    idempotencyKey: crypto.randomUUID(),
    requestFingerprint: 'fixture',
    input,
    derivedTitle: 'Re-check',
  })
}

function promptTimes(db: Db, jobId: string) {
  const source = (db.prepare('SELECT created_at FROM chat_job_inputs WHERE job_id = ?').get(jobId) as { created_at: string }).created_at
  const queued = (db.prepare("SELECT created_at FROM job_events WHERE job_id = ? AND sequence = 1").get(jobId) as { created_at: string }).created_at
  const prompt = (db.prepare("SELECT created_at FROM session_events WHERE job_id = ? AND type = 'prompt'").get(jobId) as { created_at: string }).created_at
  const lifecycle = (db.prepare("SELECT created_at FROM session_events WHERE job_id = ? AND type = 'job.lifecycle' AND job_sequence = 1").get(jobId) as { created_at: string }).created_at
  return { source, queued, prompt, lifecycle }
}

describe('K2 re-check N3: one timestamp source for prompts', () => {
  it('a ready prompt carries the stored input time even when the hook runs late, like its reconstruction', async () => {
    const ready = setup({ ready: true, slow: true })
    const readyThread = thread(ready.db)
    const readyJob = send(ready.jobs, readyThread, 'timed prompt').job.id
    const live = promptTimes(ready.db, readyJob)
    assert.equal(live.prompt, live.source, 'the live prompt has the Chat input time, not the hook time')
    assert.equal(live.lifecycle, live.queued)
    assert.ok(live.prompt <= live.lifecycle, 'the prompt is never later than the lifecycle event after it')

    const deferred = setup({ ready: false, slow: true })
    const deferredThread = thread(deferred.db)
    const deferredJob = send(deferred.jobs, deferredThread, 'timed prompt').job.id
    deferred.scrubber.ready('vault')
    await tick()
    const rebuilt = promptTimes(deferred.db, deferredJob)
    assert.equal(rebuilt.prompt, rebuilt.source, 'the reconstructed prompt has the same source time')
    assert.equal(rebuilt.lifecycle, rebuilt.queued)
  })
})

describe('K2 re-check N4: no false-empty search after late redaction', () => {
  it('pages ranked candidates until the limit is filled, past more than 3 × limit now-redacted hits', () => {
    const needleSecret = `needle-${SECRET}`
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    const handle = log.open('s-needle', { kind: 'agent' })
    for (let index = 0; index < 20; index++) {
      handle.append({ type: 'prompt', data: { origin: 'typed', messageId: `m-${index}`, text: `${needleSecret} ${needleSecret} ${needleSecret}`, attachmentCount: 0 } })
    }
    const visible = handle.append({
      type: 'prompt',
      data: {
        origin: 'typed',
        messageId: 'm-public',
        text: 'a longer public note that mentions the needle only once among many other ordinary words',
        attachmentCount: 0,
      },
    }).event.seq
    assert.equal(visible, 23)
    // The value is registered after the writes: every higher-ranked hit is now redacted.
    scrubber.register(REF, needleSecret)

    for (const limit of [1, 5, 6]) {
      const result = querySessionLog(log, 's-needle', 'remote_agent', { text: 'needle', limit })
      assert.deepEqual(result.events.map((event) => event.seq), [visible], `limit ${limit}`)
      assert.deepEqual(log.search('needle', { sessionId: 's-needle', audience: 'person', limit }).map((hit) => hit.seq), [visible])
    }
    assert.equal(JSON.stringify(querySessionLog(log, 's-needle', 'remote_agent', { text: 'needle', limit: 5 })).includes(SECRET), false)
  })
})

describe('K2 re-check N1: a session id that holds a later-registered secret', () => {
  it('is withheld from the query tool, every route and the list, which stays valid for other sessions', async () => {
    const value = `late-${SECRET}`
    const sensitiveId = `agent:${value}`
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open(sensitiveId, { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'an ordinary prompt', attachmentCount: 0 } })
    log.open('agent-clean', { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-2', text: 'another ordinary prompt', attachmentCount: 0 } })
    // Registered after the session was created and written.
    scrubber.register(REF, value)

    assert.throws(() => querySessionLog(log, sensitiveId, 'remote_agent', {}), { code: 'session_withheld' })
    assert.throws(() => querySessionLog(log, sensitiveId, 'remote_agent', { text: 'ordinary' }), { code: 'session_withheld' })
    const tool = createSessionQueryTool({ log, sessionId: sensitiveId, audience: 'remote_agent' })
    await assert.rejects(
      tool.execute({}, { workspaceRoot: null, enableBash: false, signal: new AbortController().signal }),
      (error: Error) => {
        assert.equal(error.message.includes(SECRET), false, 'the tool error is content-free')
        assert.equal(error.message.includes(REF), false)
        return /withheld/.test(error.message)
      },
    )
    assert.equal(querySessionLog(log, 'agent-clean', 'remote_agent', {}).sessionId, 'agent-clean')

    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const list = await app.request('/api/sessions', {}, LOOPBACK)
    assert.equal(list.status, 200)
    const listText = await list.text()
    assert.equal(listText.includes(SECRET), false)
    const listed = listSessionsResponse.parse(JSON.parse(listText))
    assert.deepEqual(listed.sessions.map((session) => session.sessionId), ['agent-clean'])
    assert.equal(listed.withheld, 1)

    for (const suffix of ['', '/events', '/spans', '/export', '/stream']) {
      const response = await app.request(`/api/sessions/${sensitiveId}${suffix}`, {}, LOOPBACK)
      const text = await response.text()
      assert.equal(response.status, 403, suffix)
      assert.equal(apiErrorSchema.parse(JSON.parse(text)).code, 'session_withheld', suffix)
      assert.equal(text.includes(SECRET), false, suffix)
      assert.equal((response.headers.get('content-disposition') ?? '').includes(SECRET), false)
    }

    const everywhere = await app.request('/api/sessions/search?q=ordinary', {}, LOOPBACK)
    assert.equal(everywhere.status, 200)
    const everywhereText = await everywhere.text()
    assert.equal(everywhereText.includes(SECRET), false)
    assert.deepEqual(sessionSearchResponse.parse(JSON.parse(everywhereText)).hits.map((hit) => hit.sessionId), ['agent-clean'])
    const scoped = await app.request(`/api/sessions/search?q=ordinary&sessionId=${sensitiveId}`, {}, LOOPBACK)
    assert.equal(scoped.status, 403)
    assert.equal((await scoped.text()).includes(SECRET), false)
  })
})

describe('K2 re-check N1: an open stream when the value is registered', () => {
  it('ends with a content-free session_withheld frame at its next wake-up', async () => {
    const value = `late-${SECRET}`
    const sensitiveId = `agent:${value}`
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open(sensitiveId, { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'streamed', attachmentCount: 0 } })
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const response = await app.request(`/api/sessions/${sensitiveId}/stream?after=3`, {}, LOOPBACK)
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const pending = reader.read()
    await tick()
    scrubber.register(REF, value)
    log.notify([sensitiveId])
    const frame = new TextDecoder().decode((await pending).value)
    assert.match(frame, /event: guanxi-error/)
    assert.match(frame, /"code":"session_withheld"/)
    assert.equal(frame.includes(SECRET), false)
    assert.equal((await reader.read()).done, true, 'the stream ends after the error frame')
  })
})
