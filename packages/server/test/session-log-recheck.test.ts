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

/** A deferred turn whose tool call id holds SECRET, so once SECRET is registered its trace is refused. */
function failingToolTurn(jobs: JobStore, threadId: string): string {
  const jobId = send(jobs, threadId, 'calls a tool').job.id
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
  return jobId
}

describe('K2 re-check fixes, in-session review', () => {
  it('M1: later Job events of a failed session defer without rebuilding it, and no pass runs before the retry delay', async () => {
    const db = openDb(':memory:')
    const scrubber = new SecretScrubber({ expectedSources: ['vault'] })
    let inserted = 0
    const log = new SessionLog({ db, scrubber, fault: (point) => { if (point === 'event_inserted') inserted++ } })
    const mirror = new ChatSessionMirror({ log, db, catchUpRetryMs: 60_000 })
    const jobs = new JobStore(db, { sessionMirror: mirror })
    const threadId = thread(db)
    const failed = failingToolTurn(jobs, threadId)
    scrubber.register(REF, SECRET)
    scrubber.ready('vault')
    await tick()
    assert.equal(mirror.lastCatchUpFailure, 'invalid_event')

    inserted = 0
    jobs.terminalize({ jobId: failed, expectedStatus: 'loading', status: 'cancelled', stopReason: 'user_requested' })
    const newer = send(jobs, threadId, 'newer').job.id
    jobs.transition({ jobId: newer, expectedStatus: 'queued', status: 'reserving' })
    jobs.transition({ jobId: newer, expectedStatus: 'reserving', status: 'loading' })
    await tick()
    await tick()
    assert.equal(inserted, 0, 'no rebuild of the failed Job on the hot path or in an immediate pass')
    assert.deepEqual(mirror.backlog(), [failed, newer], 'the newer turn waits behind it')
    log.close()
  })

  it('L1: an unknown id holding a registered value answers exactly like an unknown clean id', async () => {
    const scrubber = new SecretScrubber()
    scrubber.register(REF, SECRET)
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const answer = async (path: string) => {
      const response = await app.request(path, {}, LOOPBACK)
      const text = await response.text()
      assert.equal(text.includes(SECRET), false, path)
      return { status: response.status, body: text }
    }
    const guess = `agent:${SECRET}`
    const clean = 'agent:not-a-session'
    assert.equal(log.session(guess), null)
    assert.deepEqual(log.search('anything', { sessionId: guess, audience: 'person' }), [])
    assert.throws(() => log.read(guess, { audience: 'person' }), { code: 'session_not_found' })
    for (const suffix of ['', '/events', '/spans', '/export', '/stream']) {
      const unknown = await answer(`/api/sessions/${guess}${suffix}`)
      assert.equal(unknown.status, 404, suffix)
      assert.deepEqual(unknown, await answer(`/api/sessions/${clean}${suffix}`), suffix)
    }
    const search = await answer(`/api/sessions/search?q=anything&sessionId=${guess}`)
    assert.equal(search.status, 200)
    assert.deepEqual(search, await answer(`/api/sessions/search?q=anything&sessionId=${clean}`))
  })
})

describe('K2 re-check fixes, in-session review M2: claimed properties with their own assertions', () => {
  it('cross-session search leaves out a catching-up session with indexed events', () => {
    const { db, scrubber, jobs, log } = setup({ ready: true })
    const older = thread(db)
    send(jobs, older, 'shared words in the older chat')
    busyWait(5)
    const recent = thread(db)
    const recentJob = send(jobs, recent, 'shared words in the recent chat').job.id
    assert.deepEqual(log.search('shared', { audience: 'person' }).map((hit) => hit.sessionId).sort(), [older, recent].sort())

    scrubber.expect('env.shell')
    jobs.transition({ jobId: recentJob, expectedStatus: 'queued', status: 'reserving' })
    scrubber.ready('env.shell')
    // Synchronously, before the background pass: the recent chat has a deferred Job.
    assert.deepEqual(log.search('shared', { audience: 'person' }).map((hit) => hit.sessionId), [older])
    const listed = log.list(1)
    assert.deepEqual(listed.sessions.map((session) => session.sessionId), [older], 'excluded before the limit, not after')
    assert.equal(listed.catchingUp, 1)
  })

  it('the list leaves a withheld most recent session out before its limit', () => {
    let now = Date.parse('2026-10-21T00:00:00.000Z')
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber, clock: () => new Date(now += 1_000) })
    log.open('agent-older', { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'older', attachmentCount: 0 } })
    log.open(`agent:${SECRET}`, { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-2', text: 'recent', attachmentCount: 0 } })
    assert.deepEqual(log.list(1).sessions.map((session) => session.sessionId), [`agent:${SECRET}`])
    scrubber.register(REF, SECRET)
    const listed = log.list(1)
    assert.deepEqual(listed.sessions.map((session) => session.sessionId), ['agent-older'])
    assert.equal(listed.withheld, 1)
  })

  it('a failing session does not hold back another session\'s catch-up', async () => {
    const { db, scrubber, jobs, log, mirror } = setup({ ready: false, catchUpRetryMs: 60_000 })
    const [first, second] = [thread(db), thread(db)].sort()
    const failing = failingToolTurn(jobs, first!)
    send(jobs, second!, 'fine')
    scrubber.register(REF, SECRET)
    scrubber.ready('vault')
    await tick()
    assert.deepEqual(mirror.backlog(), [failing], 'the other session was caught up')
    assert.equal(log.read(second!, { audience: 'person' }).events.filter((event) => event.type === 'prompt').length, 1)
    assert.deepEqual(log.list(), { sessions: [log.session(second!)!], withheld: 0, catchingUp: 1, catchUpFailed: 1 })
    log.close()
  })
})

/** Reads one SSE frame per call; the stream pulls only when a frame is asked for. */
function frames(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next(): Promise<string | null> {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read()
        if (chunk.done) return null
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      const end = buffer.indexOf('\n\n')
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      return frame
    },
  }
}

function dataOf(frame: string): { type?: string; code?: string; details?: unknown; data?: unknown; sessionId?: string } {
  return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as never
}

describe('K2 final check N5: an open stream checks and scrubs each frame when it is emitted', () => {
  it('a session id registered after the first frame of a page withholds the next frame', async () => {
    const value = `late-${SECRET}`
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open(`agent:${value}`, { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'ordinary', attachmentCount: 0 } })
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const stream = frames(await app.request(`/api/sessions/agent:${value}/stream?after=0`, {}, LOOPBACK))
    assert.equal(dataOf((await stream.next())!).type, 'session.created', 'the first frame of a three-event page')
    scrubber.register(REF, value)
    const next = (await stream.next())!
    assert.equal(next.includes(SECRET), false)
    assert.match(next, /^event: guanxi-error/)
    assert.equal(dataOf(next).code, 'session_withheld')
    assert.equal(await stream.next(), null)
  })

  it('a payload value registered after the first frame is scrubbed in the frames that follow', async () => {
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open('agent-clean', { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: `my key is ${SECRET}`, attachmentCount: 0 } })
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const stream = frames(await app.request('/api/sessions/agent-clean/stream?after=0', {}, LOOPBACK))
    assert.equal(dataOf((await stream.next())!).type, 'session.created')
    scrubber.register(REF, SECRET)
    const rest = [(await stream.next())!, (await stream.next())!]
    assert.deepEqual(rest.map((frame) => dataOf(frame).type), ['writer.acquired', 'prompt'])
    assert.equal(rest.join('\n').includes(SECRET), false)
    assert.ok(rest[1]!.includes('REDACTED secret://vault/planted'))
  })

  it('layer 1: the log subscription itself refuses at the next yield, for any consumer', async () => {
    const value = `late-${SECRET}`
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open(`agent:${value}`, { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'ordinary', attachmentCount: 0 } })
    const events = log.subscribe(`agent:${value}`, 0, 'person', new AbortController().signal)
    assert.equal((await events.next()).value?.type, 'session.created')
    scrubber.register(REF, value)
    await assert.rejects(events.next(), { code: 'session_withheld' })
  })

  it('layer 2: the route checks again after its await, right before serialising', async () => {
    const value = `late-${SECRET}`
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open(`agent:${value}`, { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'ordinary', attachmentCount: 0 } })
    // A consumer-side gap: the value is registered after the log has checked and yielded the second event.
    const gap = Object.create(log) as SessionLog
    gap.subscribe = async function* (...args: Parameters<SessionLog['subscribe']>) {
      let yielded = 0
      for await (const event of log.subscribe(...args)) {
        if (yielded++ === 1) scrubber.register(REF, value)
        yield event
      }
    }
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => gap))
    const stream = frames(await app.request(`/api/sessions/agent:${value}/stream?after=0`, {}, LOOPBACK))
    assert.equal(dataOf((await stream.next())!).type, 'session.created')
    const next = (await stream.next())!
    assert.equal(next.includes(SECRET), false)
    assert.equal(dataOf(next).code, 'session_withheld')
  })

  it('a session that starts catching up after the first frame answers session_catching_up on the next one', async () => {
    const { db, scrubber, jobs, log, mirror } = setup({ ready: true, catchUpRetryMs: 60_000 })
    const threadId = thread(db)
    send(jobs, threadId, 'streamed chat')
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    const stream = frames(await app.request(`/api/sessions/${threadId}/stream?after=0`, {}, LOOPBACK))
    assert.equal(dataOf((await stream.next())!).type, 'session.created')

    scrubber.expect('env.shell')
    failingToolTurn(jobs, threadId)
    scrubber.register(REF, SECRET)
    scrubber.ready('env.shell')
    await tick()
    assert.equal(mirror.backlog().length, 1)
    assert.equal(mirror.lastCatchUpFailure, 'invalid_event')
    const next = (await stream.next())!
    assert.equal(dataOf(next).code, 'session_catching_up')
    assert.deepEqual(dataOf(next).details, { failure: 'invalid_event' })
    assert.equal(next.includes(SECRET), false)
    assert.equal(await stream.next(), null)
    log.close()
  })
})

describe('K2 final check N6: the generated event id', () => {
  it('an event id registered later leaves by no outward path: reads, routes, the tool and an open stream refuse', async () => {
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db: openDb(':memory:'), scrubber })
    log.open('agent-clean', { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-1', text: 'ordinary', attachmentCount: 0 } })
    const eventId = log.read('agent-clean', { audience: 'person' }).events.find((event) => event.type === 'prompt')!.id
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    // A stream that read its first page before the value is registered.
    const stream = frames(await app.request('/api/sessions/agent-clean/stream?after=0', {}, LOOPBACK))
    assert.equal(dataOf((await stream.next())!).type, 'session.created')

    scrubber.register(REF, eventId)

    assert.throws(() => log.read('agent-clean', { audience: 'person' }), { code: 'session_withheld' })
    assert.throws(() => querySessionLog(log, 'agent-clean', 'remote_agent', {}), { code: 'session_withheld' })
    const tool = createSessionQueryTool({ log, sessionId: 'agent-clean', audience: 'remote_agent' })
    await assert.rejects(
      tool.execute({}, { workspaceRoot: null, enableBash: false, signal: new AbortController().signal }),
      (error: Error) => !error.message.includes(eventId) && /withheld/.test(error.message),
    )
    for (const suffix of ['/events', '/spans', '/export']) {
      const response = await app.request(`/api/sessions/agent-clean${suffix}`, {}, LOOPBACK)
      const text = await response.text()
      assert.equal(response.status, 403, suffix)
      assert.equal(apiErrorSchema.parse(JSON.parse(text)).code, 'session_withheld')
      assert.equal(text.includes(eventId), false, suffix)
    }
    const summary = await app.request('/api/sessions/agent-clean', {}, LOOPBACK)
    assert.equal((await summary.text()).includes(eventId), false, 'the summary carries no event id')

    const frame = [(await stream.next())!, (await stream.next())!]
    assert.equal(dataOf(frame[0]!).type, 'writer.acquired', 'an event with another id still streams')
    assert.equal(dataOf(frame[1]!).code, 'session_withheld', 'the cached prompt is refused at emit time')
    assert.equal(frame.join('\n').includes(eventId), false)
  })
})
