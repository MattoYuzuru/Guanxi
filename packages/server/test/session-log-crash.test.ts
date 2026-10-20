/**
 * K2 exit gate: a crash at every append point never yields a torn or
 * duplicated event. Two fault models:
 * - in process: the append throws at the point, the caller sees the error and
 *   retries with the same idempotency key;
 * - real process death: a child process SIGKILLs itself at the point, and a
 *   new writer takes over and retries.
 * Both run for a handle's own transaction and for the legacy job store mirror,
 * whose session events must commit or roll back with the Job event.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ChatJobInputSnapshot } from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { ChatSessionMirror } from '../src/session-log/chat-mirror.ts'
import { SESSION_APPEND_POINTS, SessionLog, type SessionAppendPoint } from '../src/session-log/log.ts'
import { openDb, type Db } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ThreadStore } from '../src/store/threads.ts'

const WORKER = fileURLToPath(new URL('./fixtures/session-log-crash-worker.ts', import.meta.url))
const IN_TRANSACTION_POINTS: SessionAppendPoint[] = ['writer_checked', 'head_advanced', 'event_inserted']
const COMMITTED_BEFORE = 3

class InjectedCrash extends Error {}

/** Every structural invariant a torn or duplicated append would break. */
function assertIntact(db: Db, sessionId: string): void {
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
  db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES ('integrity-check')")
  const head = (db.prepare('SELECT last_seq FROM sessions WHERE id = ?').get(sessionId) as { last_seq: number }).last_seq
  const seqs = (db.prepare('SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq').all(sessionId) as { seq: number }[])
    .map((row) => row.seq)
  assert.deepEqual(seqs, Array.from({ length: head }, (_, index) => index + 1), 'seqs are exactly 1..head')
  const ids = db.prepare('SELECT COUNT(DISTINCT id) AS distinct_ids, COUNT(*) AS n FROM session_events WHERE session_id = ?')
    .get(sessionId) as { distinct_ids: number; n: number }
  assert.equal(ids.distinct_ids, ids.n)
  const keys = db.prepare(
    `SELECT idempotency_key, COUNT(*) AS n FROM session_events
     WHERE session_id = ? AND idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING n > 1`,
  ).all(sessionId)
  assert.deepEqual(keys, [], 'no idempotency key appears twice')
  // Every stored payload still matches its checksum and parses as a contract event.
  new SessionLog({ db, scrubber: new SecretScrubber() }).readAll(sessionId, 'person')
}

function countText(db: Db, sessionId: string, text: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND type = 'prompt' AND json_extract(payload, '$.text') = ?",
  ).get(sessionId, text) as { n: number }).n
}

function promptInput(index: number | 'torn') {
  return {
    type: 'prompt' as const,
    data: {
      origin: 'typed' as const,
      messageId: `m-${index}`,
      text: index === 'torn' ? 'tornmarker' : `committed-${index}`,
      attachmentCount: 0,
    },
  }
}

function runWorker(args: string[]): Promise<{ signal: NodeJS.Signals | null; code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout })
    })
  })
}

function chatFixture(db: Db, log: SessionLog) {
  const thread = new ThreadStore(db).create({
    title: 'Crash',
    mode: 'chat',
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
  const jobs = new JobStore(db, { sessionMirror: new ChatSessionMirror({ log, db }) })
  const input: ChatJobInputSnapshot = { content: 'crash prompt', attachments: [], autoApprove: null }
  const created = jobs.createChat({
    threadId: thread.id,
    idempotencyScope: `chat:${thread.id}:send:v1`,
    idempotencyKey: crypto.randomUUID(),
    requestFingerprint: 'fixture',
    input,
    derivedTitle: 'Crash',
  })
  return { threadId: thread.id, jobId: created.job.id, jobs }
}

/** The Job's events and its trace agree: every lifecycle Job event has exactly one mirrored event. */
function assertJobAndTraceAgree(db: Db, threadId: string, jobId: string): void {
  const lifecycle = (db.prepare(
    "SELECT sequence FROM job_events WHERE job_id = ? AND type = 'lifecycle' ORDER BY sequence",
  ).all(jobId) as { sequence: number }[]).map((row) => row.sequence)
  const mirrored = (db.prepare(
    "SELECT job_sequence FROM session_events WHERE session_id = ? AND job_id = ? AND type = 'job.lifecycle' ORDER BY seq",
  ).all(threadId, jobId) as { job_sequence: number }[]).map((row) => row.job_sequence)
  assert.deepEqual(mirrored, lifecycle)
}

describe('session log crash safety: in-process faults', () => {
  for (const point of SESSION_APPEND_POINTS) {
    it(`handle append interrupted at ${point} leaves no torn or duplicate event`, () => {
      const db = openDb(':memory:')
      let armed = false
      const log = new SessionLog({
        db,
        scrubber: new SecretScrubber(),
        fault(at, detail) {
          if (armed && at === point && detail.type === 'prompt') {
            armed = false
            throw new InjectedCrash(point)
          }
        },
      })
      const handle = log.open('s-fault', { kind: 'agent' })
      for (let index = 0; index < COMMITTED_BEFORE; index++) {
        handle.append(promptInput(index), { idempotencyKey: `k-${index}` })
      }
      const headBefore = log.read('s-fault', { audience: 'person', limit: 1 }).lastSeq
      armed = true
      assert.throws(() => handle.append(promptInput('torn'), { idempotencyKey: 'k-torn' }), InjectedCrash)
      assertIntact(db, 's-fault')
      const durable = point === 'committed'
      assert.equal(countText(db, 's-fault', 'tornmarker'), durable ? 1 : 0)
      assert.equal(log.read('s-fault', { audience: 'person', limit: 1 }).lastSeq, headBefore + (durable ? 1 : 0))
      assert.equal(log.search('tornmarker', { audience: 'person' }).length, durable ? 1 : 0, 'the index matches the table')

      const retry = handle.append(promptInput('torn'), { idempotencyKey: 'k-torn' })
      assert.equal(retry.duplicate, durable, 'a retry after a committed append returns the stored event')
      assertIntact(db, 's-fault')
      assert.equal(countText(db, 's-fault', 'tornmarker'), 1)
      assert.equal(log.read('s-fault', { audience: 'person', limit: 1 }).lastSeq, headBefore + 1)
    })
  }

  for (const point of IN_TRANSACTION_POINTS) {
    it(`job store mirror interrupted at ${point} rolls the Job event back with its trace`, () => {
      const db = openDb(':memory:')
      let armed = false
      const log = new SessionLog({
        db,
        scrubber: new SecretScrubber(),
        fault(at, detail) {
          if (armed && at === point && detail.type === 'job.lifecycle') {
            armed = false
            throw new InjectedCrash(point)
          }
        },
      })
      const { threadId, jobId, jobs } = chatFixture(db, log)
      const jobEventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM job_events').get() as { n: number }).n
      armed = true
      assert.throws(
        () => jobs.transition({ jobId, expectedStatus: 'queued', status: 'reserving', phase: 'resource_admission' }),
        InjectedCrash,
      )
      assert.equal(jobs.get(jobId)?.status, 'queued', 'the Job transition rolled back')
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM job_events').get() as { n: number }).n, jobEventsBefore)
      assertIntact(db, threadId)
      assertJobAndTraceAgree(db, threadId, jobId)

      const applied = jobs.transition({ jobId, expectedStatus: 'queued', status: 'reserving', phase: 'resource_admission' })
      assert.equal(applied.applied, true)
      assertIntact(db, threadId)
      assertJobAndTraceAgree(db, threadId, jobId)
    })
  }
})

describe('session log crash safety: SIGKILL at every append point', { timeout: 120_000 }, () => {
  for (const point of SESSION_APPEND_POINTS) {
    it(`a writer killed at ${point} leaves an intact log, and the next writer takes over and retries once`, async (test) => {
      const root = await mkdtemp(join(tmpdir(), `guanxi-k2-crash-${point}-`))
      test.after(() => rm(root, { recursive: true, force: true }))
      const path = join(root, 'guanxi.db')
      openDb(path).close()

      const result = await runWorker([path, 'handle', point, String(COMMITTED_BEFORE)])
      assert.equal(result.signal, 'SIGKILL', `the worker died at ${point} (exit ${String(result.code)})`)

      const db = openDb(path)
      test.after(() => db.close())
      assertIntact(db, 'crash-session')
      const durable = point === 'committed'
      for (let index = 0; index < COMMITTED_BEFORE; index++) {
        assert.equal(countText(db, 'crash-session', `committed-${index}`), 1)
      }
      assert.equal(countText(db, 'crash-session', 'tornmarker'), durable ? 1 : 0)

      const next = new SessionLog({ db, scrubber: new SecretScrubber(), writer: { id: 'recovery', pid: process.pid, host: hostname() } })
      const handle = next.open('crash-session', { kind: 'agent' })
      assert.equal(handle.epoch, 2)
      const handover = next.readAll('crash-session', 'person').at(-1)!
      assert.equal(handover.type === 'writer.acquired' && handover.data.reason, 'writer_process_gone')
      const retry = handle.append(promptInput('torn'), { idempotencyKey: `k-${COMMITTED_BEFORE}` })
      assert.equal(retry.duplicate, durable)
      assertIntact(db, 'crash-session')
      assert.equal(countText(db, 'crash-session', 'tornmarker'), 1)
    })
  }

  for (const point of IN_TRANSACTION_POINTS) {
    it(`a job store mirror killed at ${point} keeps the Job and its trace in agreement`, async (test) => {
      const root = await mkdtemp(join(tmpdir(), `guanxi-k2-mirror-crash-${point}-`))
      test.after(() => rm(root, { recursive: true, force: true }))
      const path = join(root, 'guanxi.db')
      openDb(path).close()

      const result = await runWorker([path, 'mirror', point, '0'])
      assert.equal(result.signal, 'SIGKILL', `the worker died at ${point} (exit ${String(result.code)})`)
      const { threadId, jobId } = JSON.parse(result.stdout.trim()) as { threadId: string; jobId: string }

      const db = openDb(path)
      test.after(() => db.close())
      const log = new SessionLog({ db, scrubber: new SecretScrubber(), writer: { id: 'recovery', pid: process.pid, host: hostname() } })
      const jobs = new JobStore(db, { sessionMirror: new ChatSessionMirror({ log, db }) })
      assert.equal(jobs.get(jobId)?.status, 'queued', 'the killed transition never committed')
      assertIntact(db, threadId)
      assertJobAndTraceAgree(db, threadId, jobId)

      assert.equal(jobs.transition({ jobId, expectedStatus: 'queued', status: 'reserving', phase: 'resource_admission' }).applied, true)
      assertIntact(db, threadId)
      assertJobAndTraceAgree(db, threadId, jobId)
      const reasons = log.readAll(threadId, 'person').flatMap((event) => event.type === 'writer.acquired' ? [event.data.reason] : [])
      assert.deepEqual(reasons, ['initial', 'writer_process_gone'])
    })
  }
})
