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
import { SessionLog, SessionLogError } from '../src/session-log/log.ts'
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

function setup(options: { ready: boolean; slow?: boolean; db?: Db; catchUpRetryMs?: number }) {
  const db = options.db ?? openDb(':memory:')
  const scrubber = new SecretScrubber({ expectedSources: options.ready ? [] : ['vault'] })
  const log = new SessionLog({ db, scrubber })
  const mirrorOptions = { log, db, catchUpRetryMs: options.catchUpRetryMs }
  const mirror = options.slow ? new SlowPromptMirror(mirrorOptions) : new ChatSessionMirror(mirrorOptions)
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

/** Prompt texts and the Job of every lifecycle event, in trace order. */
function order(db: Db, threadId: string) {
  const rows = db.prepare('SELECT type, job_id, payload FROM session_events WHERE session_id = ? ORDER BY seq').all(threadId) as { type: string; job_id: string | null; payload: string }[]
  return {
    prompts: rows.filter((row) => row.type === 'prompt').map((row) => (JSON.parse(row.payload) as { text: string }).text),
    lifecycle: rows.filter((row) => row.type === 'job.lifecycle').map((row) => row.job_id),
  }
}

function finish(jobs: JobStore, jobId: string): void {
  jobs.terminalize({ jobId, expectedStatus: 'queued', status: 'cancelled', stopReason: 'user_requested' })
}

function readCode(run: () => unknown): { code: string; failure: string | null } {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError, String(error))
    return { code: error.code, failure: error.catchUpFailure }
  }
  assert.fail('expected the read to refuse')
}

describe('K2 re-check N2: deferred history before anything newer, and visible until caught up', () => {
  it('a turn created right after ready, before the background pass, lands after the deferred one', async () => {
    const control = setup({ ready: true })
    const controlThread = thread(control.db)
    const firstControl = send(control.jobs, controlThread, 'first').job.id
    finish(control.jobs, firstControl)
    const secondControl = send(control.jobs, controlThread, 'second').job.id

    const { db, scrubber, jobs, mirror } = setup({ ready: false })
    const threadId = thread(db)
    const first = send(jobs, threadId, 'first').job.id
    finish(jobs, first)
    scrubber.ready('vault')
    // Synchronously, before the queued readiness callback runs.
    const second = send(jobs, threadId, 'second').job.id
    assert.deepEqual(order(db, threadId), { prompts: ['first', 'second'], lifecycle: [first, first, second] })
    await tick()
    assert.deepEqual(mirror.backlog(), [])
    assert.deepEqual(order(db, threadId), { prompts: ['first', 'second'], lifecycle: [first, first, second] })
    assert.deepEqual(order(control.db, controlThread), { prompts: ['first', 'second'], lifecycle: [firstControl, firstControl, secondControl] })
  })

  it('the background pass follows durable chat order, not the deferral time or the random Job id', async () => {
    const { db, scrubber, jobs } = setup({ ready: false })
    const threadId = thread(db)
    const first = send(jobs, threadId, 'first').job.id
    finish(jobs, first)
    const second = send(jobs, threadId, 'second').job.id
    // A clock step back (or one shared millisecond) must not reorder the turns.
    db.prepare('UPDATE session_mirror_backlog SET deferred_at = ? WHERE job_id = ?').run('2000-01-01T00:00:00.000Z', second)
    scrubber.ready('vault')
    await tick()
    assert.deepEqual(order(db, threadId), { prompts: ['first', 'second'], lifecycle: [first, first, second] })
  })

  it('a failed catch-up keeps the session explicitly catching up everywhere, and newer turns wait behind it', async () => {
    const { db, scrubber, jobs, log, mirror } = setup({ ready: false })
    const threadId = thread(db)
    const created = send(jobs, threadId, 'calls a tool')
    const jobId = created.job.id
    jobs.transition({ jobId, expectedStatus: 'queued', status: 'reserving' })
    jobs.transition({ jobId, expectedStatus: 'reserving', status: 'loading' })
    jobs.appendEvent({
      jobId,
      expectedNextSequence: jobs.get(jobId)!.lastEventSequence + 1,
      type: 'output',
      output: {
        privacyClassification: 'private_chat',
        event: {
          type: 'tool_call',
          data: {
            id: `call-${SECRET}`, name: 'lookup', arguments: {}, status: 'running', result: null, error: null,
            durationMs: null, source: 'builtin', parsedFrom: 'native', diff: null,
          },
        },
      },
    })
    // The tool call id now holds a registered value, so its trace is refused (identifier refusal).
    scrubber.register(REF, SECRET)
    scrubber.ready('vault')
    await tick()
    assert.deepEqual(mirror.backlog(), [jobId], 'the Job stays deferred')
    assert.equal(mirror.lastCatchUpFailure, 'invalid_event')

    for (const read of [
      () => log.session(threadId),
      () => log.read(threadId, { audience: 'person' }),
      () => log.counts(threadId),
      () => log.tokenMeter(threadId),
      () => log.search('tool', { sessionId: threadId, audience: 'person' }),
      () => querySessionLog(log, threadId, 'remote_agent', {}),
    ]) {
      assert.deepEqual(readCode(read), { code: 'session_catching_up', failure: 'invalid_event' })
    }
    assert.deepEqual(log.list(), { sessions: [], withheld: 0, catchingUp: 1, catchUpFailed: 1 })

    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const listed = listSessionsResponse.parse(await (await app.request('/api/sessions', {}, LOOPBACK)).json())
    assert.deepEqual(listed, { sessions: [], withheld: 0, catchingUp: 1, catchUpFailed: 1 }, 'never a plain empty list')
    for (const suffix of ['', '/events', '/spans', '/export', '/stream']) {
      const response = await app.request(`/api/sessions/${threadId}${suffix}`, {}, LOOPBACK)
      assert.equal(response.status, 503, suffix)
      const text = await response.text()
      assert.deepEqual(apiErrorSchema.parse(JSON.parse(text)).details, { failure: 'invalid_event' }, suffix)
      assert.equal(text.includes(SECRET), false)
    }
    const tool = createSessionQueryTool({ log, sessionId: threadId, audience: 'remote_agent' })
    await assert.rejects(
      tool.execute({}, { workspaceRoot: null, enableBash: false, signal: new AbortController().signal }),
      /still being restored/,
    )

    // A newer turn neither fails its Job write nor lands before the failed one.
    jobs.terminalize({ jobId, expectedStatus: 'loading', status: 'cancelled', stopReason: 'user_requested' })
    const newer = send(jobs, threadId, 'newer').job.id
    assert.deepEqual(mirror.backlog(), [jobId, newer])
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?').get(threadId) as { n: number }).n, 0)
  })

  it('a catch-up that failed while ready is retried, also through another readiness cycle', async () => {
    const { db, scrubber, jobs, log, mirror } = setup({ ready: false, catchUpRetryMs: 5 })
    const threadId = thread(db)
    const jobId = send(jobs, threadId, 'busy writer').job.id
    // Another live writer of this process holds the session while the scrubber becomes ready.
    const other = new SessionLog({ db, scrubber: new SecretScrubber(), writer: { id: 'other-writer', pid: process.pid, host: 'test' } })
    const handle = other.open(threadId, { kind: 'chat', threadId })
    scrubber.ready('vault')
    await tick()
    assert.deepEqual(mirror.backlog(), [jobId])
    assert.equal(mirror.lastCatchUpFailure, 'writer_busy')
    assert.deepEqual(readCode(() => log.read(threadId, { audience: 'person' })), { code: 'session_catching_up', failure: 'writer_busy' })

    handle.close()
    scrubber.expect('env.shell')
    scrubber.ready('env.shell')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(mirror.backlog(), [], 'the retry caught the Job up')
    assert.equal(mirror.lastCatchUpFailure, null)
    assert.deepEqual(order(db, threadId), { prompts: ['busy writer'], lifecycle: [jobId] })
    assert.equal(log.read(threadId, { audience: 'person' }).events.at(-1)!.type, 'job.lifecycle')
    other.close()
    log.close()
  })
})
