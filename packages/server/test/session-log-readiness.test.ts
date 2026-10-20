/**
 * K3 review H3 and GPT review R2: after a restart the session log may be asked
 * to write before every secret source (the vault) has registered. While the
 * egress scrubber is not ready the log never persists a payload: the job store
 * mirror records only the Job id in `session_mirror_backlog` (no payload) and
 * reconstructs the trace from the durable Job store once the scrubber is
 * ready, so even a crash before readiness loses nothing. Handles, reads,
 * routes, exports and the query tool fail closed.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
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
const WORKER = fileURLToPath(new URL('./fixtures/session-log-crash-worker.ts', import.meta.url))

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionLogError, `expected SessionLogError, got ${String(error)}`)
    return error.code
  }
  assert.fail('expected the call to throw')
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(options: { ready: boolean; db?: Db }) {
  const db = options.db ?? openDb(':memory:')
  const scrubber = new SecretScrubber({ expectedSources: options.ready ? [] : ['vault'] })
  if (options.ready) scrubber.register(REF, SECRET)
  const log = new SessionLog({ db, scrubber })
  const mirror = new ChatSessionMirror({ log, db })
  const jobs = new JobStore(db, { sessionMirror: mirror })
  return { db, scrubber, log, mirror, jobs }
}

function thread(db: Db): string {
  return new ThreadStore(db).create({
    title: 'Readiness',
    mode: 'chat',
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'high' },
  }).id
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

/** The trace with run-specific ids replaced, for comparing a deferred run with a ready run. */
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
    backlog: db.prepare('SELECT * FROM session_mirror_backlog').all(),
  })
}

function counts(log: SessionLog, sessionId: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const event of log.readAll(sessionId, 'person')) result[event.type] = (result[event.type] ?? 0) + 1
  return result
}

describe('session log while the egress scrubber is not ready', () => {
  it('a declared source that never becomes ready keeps a planted secret out of storage; only the Job id is noted', async () => {
    const { db, log, mirror, jobs } = setup({ ready: false })
    const threadId = thread(db)
    const { jobId } = runTurn(jobs, threadId)
    await tick()

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0)
    assert.deepEqual(mirror.backlog(), [jobId])
    assert.deepEqual(Object.keys(db.prepare('SELECT * FROM session_mirror_backlog').get() as object).sort(), ['deferred_at', 'job_id', 'thread_id'])
    assert.equal(sessionRows(db).includes(SECRET.slice(5)), false, 'no session table, the backlog included, holds any part of the secret')
    db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES ('integrity-check')")

    log.close()
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, 0, 'closing never writes unscrubbed')
  })

  it('after ready, the deferred turn is reconstructed in order, redacted, with Job times, as if it had been ready', async () => {
    const deferred = setup({ ready: false })
    const deferredThread = thread(deferred.db)
    const deferredRun = runTurn(deferred.jobs, deferredThread)

    deferred.scrubber.register(REF, SECRET)
    deferred.scrubber.ready('vault')
    await tick()
    assert.deepEqual(deferred.mirror.backlog(), [], 'the backlog drained once the scrubber was ready')

    const raw = sessionRows(deferred.db)
    assert.equal(raw.includes(SECRET), false)
    assert.ok(raw.includes(redactionMarker(REF)))

    const control = setup({ ready: true })
    const controlThread = thread(control.db)
    const controlRun = runTurn(control.jobs, controlThread)
    assert.deepEqual(
      traceShape(deferred.log, deferredThread, deferredRun.ids),
      traceShape(control.log, controlThread, controlRun.ids),
      'a deferred turn yields the same trace as a turn written while ready',
    )
    const types = traceShape(deferred.log, deferredThread).map((event) => event.type)
    assert.deepEqual(types.slice(0, 4), ['session.created', 'writer.acquired', 'prompt', 'job.lifecycle'])
    assert.equal(types.filter((type) => type === 'reasoning').length, 1, 'deltas are aggregated once, not twice')

    // Mirrored events carry the time of the Job event they reproduce, not the catch-up time.
    const jobTimes = new Map((deferred.db.prepare('SELECT sequence, created_at FROM job_events WHERE job_id = ?').all(deferredRun.jobId) as { sequence: number; created_at: string }[])
      .map((row) => [row.sequence, row.created_at]))
    for (const row of deferred.db.prepare('SELECT job_sequence, created_at FROM session_events WHERE job_sequence IS NOT NULL').all() as { job_sequence: number; created_at: string }[]) {
      assert.equal(row.created_at, jobTimes.get(row.job_sequence))
    }

    // Writes after the catch-up go straight to storage again, after the reconstructed ones.
    deferred.jobs.transition({ jobId: deferredRun.jobId, expectedStatus: 'waiting_tool', status: 'prefill' })
    const after = traceShape(deferred.log, deferredThread)
    assert.equal(after.at(-1)!.type, 'job.lifecycle')
    assert.deepEqual(after.map((event) => event.seq), after.map((_event, index) => index + 1))
  })

  it('a Job event after ready catches its Job up inside the Job transaction, before the background pass', async () => {
    const { db, scrubber, mirror, jobs, log } = setup({ ready: false })
    const threadId = thread(db)
    const created = jobs.createChat({
      threadId,
      idempotencyScope: `chat:${threadId}:send:v1`,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: 'fixture',
      input: { content: 'lazy catch-up', attachments: [], autoApprove: null },
      derivedTitle: 'Readiness',
    })
    scrubber.ready('vault')
    jobs.transition({ jobId: created.job.id, expectedStatus: 'queued', status: 'reserving' })
    assert.deepEqual(Object.entries(counts(log, threadId)).sort(), [['job.lifecycle', 2], ['prompt', 1], ['session.created', 1], ['writer.acquired', 1]])
    assert.deepEqual(mirror.backlog(), [])
    await tick()
    assert.equal(counts(log, threadId)['job.lifecycle'], 2, 'the background pass adds nothing')
  })

  it('a writer SIGKILLed before the source is ready loses nothing: the restart reconstructs it exactly once', { timeout: 60_000 }, async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-k2-deferred-crash-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    openDb(path).close()
    const child = spawn(process.execPath, [WORKER, path, 'deferred', SECRET, '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    const exit = await new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    assert.equal(exit, 'SIGKILL')
    const { threadId, jobId } = JSON.parse(stdout.trim()) as { threadId: string; jobId: string }

    const db = openDb(path)
    test.after(() => db.close())
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'lifecycle'").get(jobId) as { n: number }).n, 2)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n, 0, 'nothing was written before the crash')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_mirror_backlog').get() as { n: number }).n, 1, 'the deferral is durable')

    const scrubber = new SecretScrubber()
    scrubber.register(REF, SECRET)
    const log = new SessionLog({ db, scrubber, writer: { id: 'restarted', pid: process.pid, host: hostname() } })
    const mirror = new ChatSessionMirror({ log, db })
    await tick()
    assert.deepEqual(counts(log, threadId), { 'session.created': 1, 'writer.acquired': 1, prompt: 1, 'job.lifecycle': 2 })
    assert.equal(sessionRows(db).includes(SECRET), false)
    assert.ok(log.readAll(threadId, 'person').some((event) => event.type === 'prompt' && event.data.text.includes(redactionMarker(REF))))

    const jobs = new JobStore(db, { sessionMirror: mirror })
    jobs.transition({ jobId, expectedStatus: 'reserving', status: 'loading' })
    assert.equal(mirror.catchUpBacklog(), 0)
    new ChatSessionMirror({ log, db })
    await tick()
    assert.deepEqual(counts(log, threadId), { 'session.created': 1, 'writer.acquired': 1, prompt: 1, 'job.lifecycle': 3 }, 'a second reconstruction adds nothing')
    const lifecycle = (db.prepare("SELECT sequence FROM job_events WHERE job_id = ? AND type = 'lifecycle' ORDER BY sequence").all(jobId) as { sequence: number }[]).map((row) => row.sequence)
    const mirrored = (db.prepare("SELECT job_sequence FROM session_events WHERE type = 'job.lifecycle' ORDER BY seq").all() as { job_sequence: number }[]).map((row) => row.job_sequence)
    assert.deepEqual(mirrored, lifecycle, 'Job and trace agree')
  })

  it('a graceful close before ready loses nothing either', async () => {
    const db = openDb(':memory:')
    const first = setup({ ready: false, db })
    const threadId = thread(db)
    const { jobId } = runTurn(first.jobs, threadId)
    first.log.close()

    const second = setup({ ready: true, db })
    await tick()
    assert.deepEqual(second.mirror.backlog(), [])
    assert.equal(counts(second.log, threadId).prompt, 1)
    const lifecycle = (db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'lifecycle'").get(jobId) as { n: number }).n
    assert.equal(counts(second.log, threadId)['job.lifecycle'], lifecycle)
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
