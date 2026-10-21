/**
 * K2 focused GPT re-check (REVIEW-GPT-2): one regression test per finding
 * N1–N4, each built on the reviewer's scenario and failing without its fix.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChatJobInputSnapshot } from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { ChatSessionMirror } from '../src/session-log/chat-mirror.ts'
import { SessionLog } from '../src/session-log/log.ts'
import { openDb, type Db } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ThreadStore } from '../src/store/threads.ts'

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
