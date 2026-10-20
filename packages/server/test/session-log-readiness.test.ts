/**
 * K3 review H3: after a restart the session log may be asked to write before
 * every secret source (the vault) has registered. While the egress scrubber is
 * not ready the log never persists a payload: the job store mirror holds its
 * writes in a bounded buffer and flushes them, scrubbed and in order, once the
 * scrubber is ready; a full buffer refuses the write (the Job transaction rolls
 * back); handles, reads, routes, exports and the query tool fail closed.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { apiErrorSchema, type ChatJobOutput } from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { redactionMarker } from '../src/egress/types.ts'
import { ChatSessionMirror } from '../src/session-log/chat-mirror.ts'
import { SessionLog, SessionLogError } from '../src/session-log/log.ts'
import { createSessionQueryTool } from '../src/session-log/query-tool.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb, type Db } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ThreadStore } from '../src/store/threads.ts'

const SECRET = `fake-${randomBytes(16).toString('hex')}`
const REF = 'secret://vault/planted' as const

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError, `expected SessionLogError, got ${String(error)}`)
    return error.code
  }
  assert.fail('expected the call to throw')
}

function setup(options: { ready: boolean; pendingLimit?: { events: number; bytes: number } }) {
  const db = openDb(':memory:')
  const scrubber = new SecretScrubber({ expectedSources: options.ready ? [] : ['vault'] })
  if (options.ready) scrubber.register(REF, SECRET)
  const log = new SessionLog({ db, scrubber, pendingLimit: options.pendingLimit })
  const jobs = new JobStore(db, { sessionMirror: new ChatSessionMirror({ log, db }) })
  const threadId = new ThreadStore(db).create({
    title: 'Readiness',
    mode: 'chat',
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'high' },
  }).id
  return { db, scrubber, log, jobs, threadId }
}

function output(event: ChatJobOutput) {
  return { privacyClassification: 'private_chat' as const, event }
}

/** A Chat turn's Job writes: prompt, transitions, a reasoning and a token delta split around the secret, a tool call. */
function runTurn(jobs: JobStore, threadId: string): { jobId: string; ids: string[] } {
  const created = jobs.createChat({
    threadId,
    idempotencyScope: `chat:${threadId}:send:v1`,
    idempotencyKey: crypto.randomUUID(),
    requestFingerprint: 'fixture',
    input: { content: `my key is ${SECRET}`, attachments: [], autoApprove: null },
    derivedTitle: 'Readiness',
  })
  const jobId = created.job.id
  const step = (from: Parameters<JobStore['transition']>[0]['expectedStatus'], to: Parameters<JobStore['transition']>[0]['status']) =>
    jobs.transition({ jobId, expectedStatus: from, status: to })
  const append = (event: ChatJobOutput) =>
    jobs.appendEvent({ jobId, expectedNextSequence: jobs.get(jobId)!.lastEventSequence + 1, type: 'output', output: output(event) })
  step('queued', 'reserving')
  step('reserving', 'loading')
  append({ type: 'start', data: { messageId: created.assistantMessageId, model: 'fixture', step: 0 } })
  step('loading', 'prefill')
  step('prefill', 'thinking')
  append({ type: 'thinking', data: { delta: `thinking about ${SECRET.slice(0, 9)}` } })
  append({ type: 'thinking', data: { delta: `${SECRET.slice(9)} now` } })
  step('thinking', 'generating')
  append({ type: 'token', data: { delta: `using ${SECRET.slice(0, 12)}` } })
  append({ type: 'token', data: { delta: SECRET.slice(12) } })
  step('generating', 'waiting_tool')
  append({
    type: 'tool_call',
    data: {
      id: 'call-1', name: 'lookup', arguments: { key: SECRET }, status: 'running', result: null, error: null,
      durationMs: null, source: 'builtin', parsedFrom: 'native', diff: null,
    },
  })
  return { jobId, ids: [threadId, jobId, created.userMessageId, created.assistantMessageId] }
}

/** The trace with run-specific ids replaced, for comparing a buffered run with a ready run. */
function traceShape(log: SessionLog, sessionId: string, ids: string[] = []) {
  const events = log.readAll(sessionId, 'person').map((event) => ({
    seq: event.seq, type: event.type, data: event.data, spanId: event.spanId, parentSpanId: event.parentSpanId,
    redactions: event.redactions,
  }))
  let text = JSON.stringify(events)
  ids.forEach((id, index) => { text = text.replaceAll(id, `<id-${index}>`) })
  return JSON.parse(text) as typeof events
}

function sessionRows(db: Db): string {
  return JSON.stringify({
    sessions: db.prepare('SELECT * FROM sessions').all(),
    writers: db.prepare('SELECT * FROM session_writers').all(),
    events: db.prepare('SELECT * FROM session_events').all(),
  })
}

describe('session log while the egress scrubber is not ready', () => {
  it('a declared source that never becomes ready keeps a planted secret out of storage', async () => {
    const { db, log, jobs, threadId } = setup({ ready: false })
    runTurn(jobs, threadId)
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.ok(log.pendingCount > 0, 'the trace is held in memory')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0)
    assert.equal(sessionRows(db).includes(SECRET.slice(5)), false, 'no session table holds any part of the secret')
    db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES ('integrity-check')")

    log.close()
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, 0, 'closing never writes unscrubbed')
  })

  it('after ready, the held-back trace is written in order with the secret redacted, as if it had been ready', async () => {
    const buffered = setup({ ready: false })
    const bufferedRun = runTurn(buffered.jobs, buffered.threadId)
    const held = buffered.log.pendingCount
    assert.ok(held >= 12)

    buffered.scrubber.register(REF, SECRET)
    buffered.scrubber.ready('vault')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(buffered.log.pendingCount, 0, 'the buffer flushed once the scrubber was ready')

    const raw = sessionRows(buffered.db)
    assert.equal(raw.includes(SECRET), false)
    assert.ok(raw.includes(redactionMarker(REF)))

    const control = setup({ ready: true })
    const controlRun = runTurn(control.jobs, control.threadId)
    assert.deepEqual(
      traceShape(buffered.log, buffered.threadId, bufferedRun.ids),
      traceShape(control.log, control.threadId, controlRun.ids),
      'a buffered turn yields the same trace as a turn written while ready',
    )
    const types = traceShape(buffered.log, buffered.threadId).map((event) => event.type)
    assert.deepEqual(types.slice(0, 4), ['session.created', 'writer.acquired', 'prompt', 'job.lifecycle'])
    assert.equal(types.filter((type) => type === 'reasoning').length, 1, 'deltas held back are aggregated once, not twice')
    assert.equal(types.filter((type) => type === 'assistant.message').length, 1)

    // Writes after the flush go straight to storage again, after the flushed ones.
    buffered.jobs.transition({ jobId: bufferedRun.jobId, expectedStatus: 'waiting_tool', status: 'prefill' })
    assert.equal(buffered.log.pendingCount, 0)
    const after = traceShape(buffered.log, buffered.threadId)
    assert.equal(after.at(-1)!.type, 'job.lifecycle')
    assert.deepEqual(after.map((event) => event.seq), after.map((_event, index) => index + 1))
  })

  it('a full buffer fails closed: the Job write rolls back, nothing held is dropped', async () => {
    const { db, scrubber, log, jobs, threadId } = setup({ ready: false, pendingLimit: { events: 3, bytes: 1_000_000 } })
    const created = jobs.createChat({
      threadId,
      idempotencyScope: `chat:${threadId}:send:v1`,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: 'fixture',
      input: { content: `my key is ${SECRET}`, attachments: [], autoApprove: null },
      derivedTitle: 'Readiness',
    })
    const jobId = created.job.id
    assert.equal(log.pendingCount, 2, 'prompt and queued are held back')
    const jobEvents = () => (db.prepare('SELECT COUNT(*) AS n FROM job_events').get() as { n: number }).n
    const before = jobEvents()

    // One transaction holds back two writes (lifecycle, then intervention); the second overflows.
    assert.throws(
      () => jobs.transition({ jobId, expectedStatus: 'queued', status: 'cancelling', metadata: { stopReason: 'user_requested' } }),
      (error: unknown) => error instanceof SessionLogError && error.code === 'egress_buffer_full',
    )
    assert.equal(jobs.get(jobId)!.status, 'queued', 'the refused write never committed its Job event')
    assert.equal(jobEvents(), before)
    assert.equal(log.pendingCount, 2, 'the rolled-back transaction left none of its writes behind')

    jobs.transition({ jobId, expectedStatus: 'queued', status: 'reserving' })
    assert.equal(log.pendingCount, 3)
    assert.throws(
      () => jobs.transition({ jobId, expectedStatus: 'reserving', status: 'loading' }),
      (error: unknown) => error instanceof SessionLogError && error.code === 'egress_buffer_full',
    )
    assert.equal(jobs.get(jobId)!.status, 'reserving')
    assert.equal(log.pendingCount, 3, 'the held writes are still there')

    scrubber.register(REF, SECRET)
    scrubber.ready('vault')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(log.pendingCount, 0)
    const trace = log.readAll(threadId, 'person')
    assert.deepEqual(trace.map((event) => event.type), ['session.created', 'writer.acquired', 'prompt', 'job.lifecycle', 'job.lifecycle'])
    assert.deepEqual(trace.flatMap((event) => event.type === 'job.lifecycle' ? [event.data.state] : []), ['queued', 'reserving'])
    assert.equal(sessionRows(db).includes(SECRET), false)

    assert.equal(jobs.transition({ jobId, expectedStatus: 'reserving', status: 'loading' }).applied, true, 'the write succeeds once ready')
    assert.equal(log.readAll(threadId, 'person').at(-1)!.type, 'job.lifecycle')
  })

  it('a byte bound counts the held data, not only the number of writes', () => {
    const { log, jobs, threadId } = setup({ ready: false, pendingLimit: { events: 1_000, bytes: 64 } })
    assert.throws(
      () => jobs.createChat({
        threadId,
        idempotencyScope: `chat:${threadId}:send:v1`,
        idempotencyKey: crypto.randomUUID(),
        requestFingerprint: 'fixture',
        input: { content: 'x'.repeat(200), attachments: [], autoApprove: null },
        derivedTitle: 'Readiness',
      }),
      (error: unknown) => error instanceof SessionLogError && error.code === 'egress_buffer_full',
    )
    assert.equal(log.pendingCount, 0)
  })

  it('handles, reads, routes, exports and the query tool fail closed and name the pending source', async () => {
    const { log, scrubber } = setup({ ready: false })
    assert.equal(code(() => log.open('s-x', { kind: 'agent' })), 'egress_not_ready')
    for (const read of [
      () => log.list(),
      () => log.session('s-x'),
      () => log.read('s-x', { audience: 'person' }),
      () => log.readAll('s-x', 'remote_agent'),
      () => log.search('key', { audience: 'person' }),
      () => log.counts('s-x'),
      () => log.tokenMeter('s-x'),
      () => log.redact('x'),
    ]) {
      assert.equal(code(read), 'egress_not_ready')
    }
    await assert.rejects(log.subscribe('s-x', 0, 'person', new AbortController().signal).next(), /waiting for: vault/)

    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => log))
    for (const path of ['/api/sessions', '/api/sessions/s-x', '/api/sessions/s-x/events', '/api/sessions/s-x/export', '/api/sessions/s-x/spans', '/api/sessions/search?q=key', '/api/sessions/s-x/stream']) {
      const response = await app.request(path)
      assert.equal(response.status, 503, path)
      const body = apiErrorSchema.parse(await response.json())
      assert.equal(body.code, 'egress_not_ready', path)
      assert.deepEqual(body.details, { pendingSources: ['vault'] })
    }

    const tool = createSessionQueryTool({ log, sessionId: 's-x', audience: 'local_agent' })
    await assert.rejects(
      tool.execute({}, { workspaceRoot: null, enableBash: false, signal: new AbortController().signal }),
      /cannot be read until secret redaction is ready/,
    )

    scrubber.ready('vault')
    const handle = log.open('s-x', { kind: 'agent' })
    assert.equal(handle.append({ type: 'prompt', data: { origin: 'typed', messageId: 'm', text: 'ok', attachmentCount: 0 } }).duplicate, false)
    scrubber.expect('env.shell')
    assert.equal(
      code(() => handle.append({ type: 'prompt', data: { origin: 'typed', messageId: 'm2', text: 'late', attachmentCount: 0 } })),
      'egress_not_ready',
      'a source declared later closes the gate again',
    )
  })
})
