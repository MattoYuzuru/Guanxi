import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type {
  ChatJobOutput,
  HardwareInfo,
  JobEventOutput,
  JobState,
  ToolCall,
  Usage,
} from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { UnsupportedHostTelemetry } from '../src/hardware/telemetry.ts'
import { ChatJobExecutionOwner } from '../src/jobs/chat-execution.ts'
import {
  ChatRecoveryError,
  recoverChatJobs,
  type ChatRecoveryOptions,
} from '../src/jobs/chat-recovery.ts'
import { JobService } from '../src/jobs/service.ts'
import { start } from '../src/index.ts'
import type { ModelService } from '../src/models/service.ts'
import type { OllamaClient } from '../src/ollama/client.ts'
import type { OllamaChatChunk } from '../src/ollama/types.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { RuntimeReconciliationService } from '../src/runtime/reconciliation.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb, type Db } from '../src/store/db.ts'
import {
  JobStore,
  type ChatJobAssociation,
} from '../src/store/jobs.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { WorkspaceStore } from '../src/store/workspaces.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'recovery-fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

const EXECUTING_STATES: JobState[] = [
  'reserving',
  'loading',
  'prefill',
  'thinking',
  'generating',
  'waiting_tool',
  'waiting_approval',
  'finalizing',
]

const PATHS: Partial<Record<JobState, JobState[]>> = {
  queued: [],
  reserving: ['reserving'],
  loading: ['reserving', 'loading'],
  prefill: ['reserving', 'loading', 'prefill'],
  thinking: ['reserving', 'loading', 'prefill', 'thinking'],
  generating: ['reserving', 'loading', 'prefill', 'generating'],
  waiting_tool: ['reserving', 'loading', 'prefill', 'generating', 'waiting_tool'],
  waiting_approval: [
    'reserving',
    'loading',
    'prefill',
    'generating',
    'waiting_tool',
    'waiting_approval',
  ],
  finalizing: ['reserving', 'loading', 'prefill', 'generating', 'finalizing'],
  cancelling: ['reserving', 'loading', 'prefill', 'generating', 'cancelling'],
}

const USAGE: Usage = {
  promptTokens: 12,
  evalTokens: 4,
  promptEvalDurationMs: 20,
  evalDurationMs: 10,
  loadDurationMs: 5,
  totalDurationMs: 35,
  tokensPerSecond: 400,
  cacheHit: false,
  cachedTokens: 0,
}

const TOOL_CALL: ToolCall = {
  id: 'tool-call-1',
  name: 'read_file',
  arguments: { path: 'fixture.txt' },
  status: 'running',
  result: null,
  error: null,
  durationMs: null,
  source: 'builtin',
  parsedFrom: 'native',
  diff: null,
}

function terminalChunk(content: string): OllamaChatChunk {
  return {
    model: 'fixture',
    created_at: '2026-08-03T10:00:00.000Z',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    prompt_eval_duration: 20_000_000,
    eval_count: 4,
    eval_duration: 10_000_000,
    load_duration: 5_000_000,
    total_duration: 35_000_000,
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

interface RuntimeFixture {
  context: AppContext
  calls(): number
}

function runtimeFixture(
  db: Db,
  stream: (
    signal: AbortSignal,
    call: number,
  ) => AsyncGenerator<OllamaChatChunk> = () =>
    (async function* () {
      yield terminalChunk('recovered queued answer')
    })(),
): RuntimeFixture {
  const settings = new SettingsStore(db, { ollamaHost: 'http://fixture.invalid' })
  const jobs = new JobStore(db)
  let callCount = 0
  const base = {
    db,
    jobs,
    jobService: new JobService(jobs, { replayPageSize: 2 }),
    threads: new ThreadStore(db),
    workspaces: new WorkspaceStore(db),
    settings,
    calibration: new CalibrationStore(db),
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware: HARDWARE,
    hostTelemetry: new UnsupportedHostTelemetry(HARDWARE),
    appVersion: 'recovery-fixture',
    activeTurns: new Map<string, AbortController>(),
    governor: new ResourceGovernor(),
    ollama: () =>
      ({
        chatStream(_request: unknown, signal: AbortSignal) {
          callCount += 1
          return stream(signal, callCount)
        },
      }) as unknown as OllamaClient,
    models: () =>
      ({
        supportsTools: async () => false,
      }) as unknown as ModelService,
  }
  const runtimeBase = {
    ...base,
    runtime: new RuntimeReconciliationService({
      governor: base.governor,
      hostTelemetry: base.hostTelemetry,
      models: base.models,
    }),
  }
  const context: AppContext = {
    ...runtimeBase,
    chatExecution: new ChatJobExecutionOwner(runtimeBase),
  }
  return { context, calls: () => callCount }
}

function createThread(threads: ThreadStore, title: string): string {
  return threads.create({
    title,
    mode: 'chat',
    model: `fixture-${title}`,
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  }).id
}

function advance(service: JobService, association: ChatJobAssociation, state: JobState): void {
  let current = association.job
  for (const next of PATHS[state] ?? []) {
    const result = service.transition({
      jobId: current.id,
      expectedStatus: current.status,
      status: next,
      phase: `fixture_${next}`,
      metadata: {},
    })
    assert.equal(result.applied, true)
    current = result.job
  }
}

function output(event: ChatJobOutput): JobEventOutput {
  return { privacyClassification: 'private_chat', event }
}

function appendOutput(service: JobService, jobId: string, event: ChatJobOutput): void {
  const job = service.get(jobId)!
  service.appendSafeEvent({
    jobId,
    expectedNextSequence: job.lastEventSequence + 1,
    type: event.type === 'tool_call' || event.type === 'tool_result' ? 'tool' : 'output',
    metadata: { channel: event.type },
    output: output(event),
  })
}

function seedChat(
  db: Db,
  key: string,
  state: JobState,
  options: { threadId?: string; partial?: boolean } = {},
): ChatJobAssociation {
  const threads = new ThreadStore(db)
  const jobs = new JobStore(db)
  const service = new JobService(jobs)
  const threadId = options.threadId ?? createThread(threads, key)
  const snapshot = { content: `private prompt ${key}`, attachments: [], autoApprove: null }
  const association = service.createChat({
    threadId,
    idempotencyScope: `chat:${threadId}:send:v1`,
    idempotencyKey: key,
    requestFingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    input: snapshot,
    derivedTitle: `private prompt ${key}`,
  })

  advance(service, association, state)
  if (options.partial) {
    appendOutput(service, association.job.id, {
      type: 'start',
      data: {
        messageId: association.assistantMessageId,
        model: 'fixture',
        step: 0,
        status: 'pending',
        jobId: association.job.id,
      },
    })
    appendOutput(service, association.job.id, {
      type: 'thinking',
      data: { delta: `thinking-${key}` },
    })
    appendOutput(service, association.job.id, {
      type: 'token',
      data: { delta: `partial-${key}` },
    })
  }
  return jobs.chatInput(association.job.id)!
}

function terminalCount(db: Db, jobId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM job_events
         WHERE job_id = ? AND state IN ('completed','failed','cancelled','interrupted')`,
      )
      .get(jobId) as { count: number }
  ).count
}

function recoveryOptions(overrides: ChatRecoveryOptions = {}): ChatRecoveryOptions {
  return { scanPageSize: 2, outputPageSize: 2, ...overrides }
}

describe('durable Chat startup recovery', () => {
  it('reconciles every unsafe state, confirms cancelling, and leaves terminal rows unchanged', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-matrix-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const first = openDb(path)
    const fixtures = new Map<JobState, ChatJobAssociation>()
    for (const state of EXECUTING_STATES) {
      fixtures.set(
        state,
        seedChat(first, `state-${state}`, state, {
          partial: !['reserving', 'loading'].includes(state),
        }),
      )
    }
    fixtures.set('cancelling', seedChat(first, 'state-cancelling', 'cancelling', { partial: true }))

    const terminal = seedChat(first, 'terminal-control', 'finalizing', { partial: true })
    const terminalService = new JobService(new JobStore(first))
    terminalService.terminalizeChat({
      jobId: terminal.job.id,
      expectedStatus: 'finalizing',
      status: 'completed',
      messageId: terminal.assistantMessageId,
      message: {
        outcome: 'completed',
        error: null,
        stopReason: 'stop',
        content: 'terminal control',
        thinking: null,
        toolCalls: [],
        usage: USAGE,
      },
      outcome: { code: 'chat_completed', metadata: { messageId: terminal.assistantMessageId } },
      stopReason: 'stop',
      output: output({
        type: 'done',
        data: {
          messageId: terminal.assistantMessageId,
          stopReason: 'stop',
          outcome: 'completed',
          terminalStopReason: 'stop',
          steps: 1,
        },
      }),
    })
    const terminalJobBefore = JSON.stringify(
      first.prepare('SELECT * FROM jobs WHERE id = ?').get(terminal.job.id),
    )
    const terminalEventsBefore = JSON.stringify(
      first.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence').all(terminal.job.id),
    )
    first.close()

    const restarted = openDb(path)
    const runtime = runtimeFixture(restarted)
    const report = await recoverChatJobs(runtime.context, recoveryOptions())

    assert.equal(report.scanned, 9)
    assert.equal(report.scanPages, 5)
    assert.equal(report.interrupted, 8)
    assert.equal(report.cancelled, 1)
    assert.equal(report.queuedScheduled, 0)
    assert.ok(report.outputPages > report.scanPages)
    assert.equal(runtime.calls(), 0)
    assert.equal(runtime.context.governor.snapshot().activeLease, null)
    assert.deepEqual(runtime.context.governor.snapshot().queued, [])
    for (const [state, association] of fixtures) {
      const job = runtime.context.jobService.get(association.job.id)!
      const message = runtime.context.threads.latestPendingAssistantForJob(job.id)
      assert.equal(job.status, state === 'cancelling' ? 'cancelled' : 'interrupted')
      assert.equal(terminalCount(restarted, job.id), 1)
      assert.equal(message, null)
      const projected = runtime.context.threads.messages(association.threadId).at(-1)!
      assert.equal(projected.turnStatus, state === 'cancelling' ? 'cancelled' : 'failed')
      assert.equal(
        projected.stopReason,
        state === 'cancelling' ? 'stopped_by_user' : 'internal_error',
      )
      const safeRows = JSON.stringify(
        restarted.prepare('SELECT error, outcome, stop_reason FROM jobs WHERE id = ?').get(job.id),
      )
      assert.doesNotMatch(safeRows, /private prompt|thinking-|partial-|\/tmp|secret/i)
    }
    assert.equal(
      JSON.stringify(restarted.prepare('SELECT * FROM jobs WHERE id = ?').get(terminal.job.id)),
      terminalJobBefore,
    )
    assert.equal(
      JSON.stringify(
        restarted.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY sequence').all(terminal.job.id),
      ),
      terminalEventsBefore,
    )

    const counts = new Map(
      [...fixtures.values()].map((association) => [
        association.job.id,
        runtime.context.jobService.get(association.job.id)!.lastEventSequence,
      ]),
    )
    for (let repeat = 0; repeat < 10; repeat += 1) {
      const repeated = await recoverChatJobs(runtime.context, recoveryOptions())
      assert.equal(repeated.scanned, 0)
      for (const [jobId, sequence] of counts) {
        assert.equal(runtime.context.jobService.get(jobId)?.lastEventSequence, sequence)
        assert.equal(terminalCount(restarted, jobId), 1)
      }
    }
    restarted.close()
  })

  it('starts an untouched queued Chat once and skips generic public Jobs', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-queued-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const first = openDb(path)
    const queued = seedChat(first, 'queued-safe', 'queued')
    const generic = new JobService(new JobStore(first)).create({
      kind: 'inference',
      operation: 'chat',
      idempotencyScope: 'local-api:v1',
      idempotencyKey: 'generic-chat',
    }).job
    first.close()

    const restarted = openDb(path)
    const runtime = runtimeFixture(restarted)
    const report = await recoverChatJobs(runtime.context, recoveryOptions({ scanPageSize: 1 }))
    assert.equal(report.queuedValidated, 1)
    assert.equal(report.queuedScheduled, 1)
    await waitFor(
      () => runtime.context.jobService.get(queued.job.id)?.status === 'completed',
      'Recovered queued Chat did not complete',
    )
    assert.equal(runtime.calls(), 1)
    assert.equal(runtime.context.jobService.get(generic.id)?.status, 'queued')
    const sequence = runtime.context.jobService.get(queued.job.id)!.lastEventSequence

    const repeated = await recoverChatJobs(runtime.context, recoveryOptions({ scanPageSize: 1 }))
    assert.equal(repeated.scanned, 0)
    assert.equal(runtime.calls(), 1)
    assert.equal(runtime.context.jobService.get(queued.job.id)?.lastEventSequence, sequence)
    assert.equal(terminalCount(restarted, queued.job.id), 1)
    restarted.close()
  })

  it('reduces only the latest pending assistant across bounded output pages and serves it by GET/SSE', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-output-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const first = openDb(path)
    const association = seedChat(first, 'partial-reducer', 'waiting_tool')
    const threads = new ThreadStore(first)
    threads.terminalizeMessage(association.assistantMessageId, {
      outcome: 'completed',
      error: null,
      stopReason: 'tool_calls',
      content: 'earlier tool-step',
      thinking: 'earlier thinking',
      toolCalls: [{ ...TOOL_CALL, status: 'ok', result: 'earlier result', durationMs: 2 }],
      usage: USAGE,
    })
    const pending = threads.addMessage({
      threadId: association.threadId,
      role: 'assistant',
      content: '',
      jobId: association.job.id,
    })
    const service = new JobService(new JobStore(first))
    appendOutput(service, association.job.id, {
      type: 'start',
      data: {
        messageId: association.assistantMessageId,
        model: 'fixture',
        step: 0,
        status: 'pending',
        jobId: association.job.id,
      },
    })
    appendOutput(service, association.job.id, { type: 'token', data: { delta: 'ignored' } })
    appendOutput(service, association.job.id, {
      type: 'start',
      data: {
        messageId: pending.id,
        model: 'fixture',
        step: 1,
        status: 'pending',
        jobId: association.job.id,
      },
    })
    appendOutput(service, association.job.id, { type: 'thinking', data: { delta: 'why ' } })
    appendOutput(service, association.job.id, { type: 'thinking', data: { delta: 'now' } })
    appendOutput(service, association.job.id, { type: 'token', data: { delta: 'partial ' } })
    appendOutput(service, association.job.id, { type: 'token', data: { delta: 'answer' } })
    appendOutput(service, association.job.id, { type: 'tool_call', data: TOOL_CALL })
    appendOutput(service, association.job.id, {
      type: 'tool_result',
      data: {
        toolCallId: TOOL_CALL.id,
        status: 'ok',
        result: 'tool result',
        error: null,
        durationMs: 7,
      },
    })
    appendOutput(service, association.job.id, { type: 'usage', data: USAGE })
    const earlierBefore = JSON.stringify(
      first.prepare('SELECT * FROM messages WHERE id = ?').get(association.assistantMessageId),
    )
    first.close()

    const restarted = openDb(path)
    const runtime = runtimeFixture(restarted)
    const report = await recoverChatJobs(runtime.context, recoveryOptions({ outputPageSize: 2 }))
    assert.equal(report.interrupted, 1)
    assert.ok(report.outputPages >= 6)
    assert.equal(runtime.calls(), 0)
    assert.equal(
      JSON.stringify(
        restarted.prepare('SELECT * FROM messages WHERE id = ?').get(association.assistantMessageId),
      ),
      earlierBefore,
    )
    const projected = runtime.context.threads.getMessage(pending.id)!
    assert.equal(projected.turnStatus, 'failed')
    assert.equal(projected.content, 'partial answer')
    assert.equal(projected.thinking, 'why now')
    assert.deepEqual(projected.usage, USAGE)
    assert.deepEqual(projected.toolCalls, [
      { ...TOOL_CALL, status: 'ok', result: 'tool result', durationMs: 7 },
    ])

    const app = createApp(runtime.context)
    const canonical = (await (await app.request(`/api/jobs/${association.job.id}`)).json()) as {
      job: { status: string }
    }
    assert.equal(canonical.job.status, 'interrupted')
    const stream = await app.request(`/api/jobs/${association.job.id}/events`)
    const frames = (await stream.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { sequence: number; state: string; output: unknown })
    assert.equal(frames.at(-1)?.state, 'interrupted')
    assert.ok(frames.at(-1)?.output)
    assert.equal(new Set(frames.map((frame) => frame.sequence)).size, frames.length)
    const history = (await (await app.request(`/api/threads/${association.threadId}`)).json()) as {
      messages: Array<{ id: string; content: string; turnStatus: string | null }>
    }
    assert.deepEqual(
      history.messages.map((message) => [message.id, message.content, message.turnStatus]),
      [
        [association.userMessageId, 'private prompt partial-reducer', null],
        [association.assistantMessageId, 'earlier tool-step', 'completed'],
        [pending.id, 'partial answer', 'failed'],
      ],
    )
    restarted.close()
  })

  it('converges after injected terminal and mid-scan failures without leaking private details', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-failure-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const first = openDb(path)
    const candidates = [
      seedChat(first, 'failure-a', 'generating', { partial: true }),
      seedChat(first, 'failure-b', 'generating', { partial: true }),
      seedChat(first, 'failure-c', 'generating', { partial: true }),
    ]
    first.close()

    const restarted = openDb(path)
    const firstAttempt = runtimeFixture(restarted)
    restarted.exec(`
      CREATE TRIGGER fail_recovery_terminal
      BEFORE INSERT ON job_events
      WHEN NEW.state = 'interrupted'
      BEGIN
        SELECT RAISE(ABORT, 'SELECT private prompt /tmp/secret provider body');
      END;
    `)
    await assert.rejects(
      recoverChatJobs(firstAttempt.context, recoveryOptions()),
      (error) => {
        assert.ok(error instanceof ChatRecoveryError)
        assert.doesNotMatch(String(error), /SELECT|private prompt|\/tmp|secret|provider body/i)
        return true
      },
    )
    assert.equal(firstAttempt.context.jobService.get(candidates[0]!.job.id)?.status, 'generating')
    assert.equal(firstAttempt.context.threads.getMessage(candidates[0]!.assistantMessageId)?.turnStatus, 'pending')
    assert.equal(terminalCount(restarted, candidates[0]!.job.id), 0)
    restarted.close()

    const secondDb = openDb(path)
    secondDb.exec('DROP TRIGGER fail_recovery_terminal')
    const secondAttempt = runtimeFixture(secondDb)

    let injected = false
    await assert.rejects(
      recoverChatJobs(
        secondAttempt.context,
        recoveryOptions({
          checkpoint: (checkpoint) => {
            if (!injected && checkpoint.phase === 'scan_page') {
              injected = true
              throw new Error('private prompt /tmp/secret SQL')
            }
          },
        }),
      ),
      (error) => {
        assert.ok(error instanceof ChatRecoveryError)
        assert.doesNotMatch(String(error), /private prompt|\/tmp|secret|SQL/i)
        return true
      },
    )
    secondDb.close()

    const finalDb = openDb(path)
    const finalAttempt = runtimeFixture(finalDb)
    const final = await recoverChatJobs(finalAttempt.context, recoveryOptions())
    assert.ok(final.interrupted >= 1)
    for (const association of candidates) {
      assert.equal(finalAttempt.context.jobService.get(association.job.id)?.status, 'interrupted')
      assert.equal(terminalCount(finalDb, association.job.id), 1)
    }
    assert.equal(firstAttempt.calls() + secondAttempt.calls() + finalAttempt.calls(), 0)
    finalDb.close()
  })

  it('fails closed on incomplete association and malformed private output while preserving retry rows', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-malformed-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const db = openDb(path)
    const incomplete = seedChat(db, 'incomplete', 'generating', { partial: true })
    const malformed = seedChat(db, 'malformed', 'generating', { partial: true })
    db.prepare('DELETE FROM chat_job_inputs WHERE job_id = ?').run(incomplete.job.id)
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare(
      `UPDATE job_events SET output = '{'
       WHERE job_id = ? AND output IS NOT NULL AND sequence = (
         SELECT MIN(sequence) FROM job_events WHERE job_id = ? AND output IS NOT NULL
       )`,
    ).run(malformed.job.id, malformed.job.id)
    db.exec('PRAGMA ignore_check_constraints = OFF')
    db.close()

    const restarted = openDb(path)
    const runtime = runtimeFixture(restarted)
    await assert.rejects(recoverChatJobs(runtime.context, recoveryOptions()), ChatRecoveryError)
    assert.equal(runtime.context.jobService.get(incomplete.job.id)?.status, 'generating')
    assert.equal(runtime.context.jobService.get(malformed.job.id)?.status, 'generating')
    assert.equal(runtime.calls(), 0)

    restarted.prepare(
      `INSERT INTO chat_job_inputs (
         job_id, thread_id, user_message_id, assistant_message_id,
         request_fingerprint, input_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      incomplete.job.id,
      incomplete.threadId,
      incomplete.userMessageId,
      incomplete.assistantMessageId,
      incomplete.requestFingerprint,
      JSON.stringify(incomplete.input),
      incomplete.createdAt,
    )
    restarted.prepare(
      `UPDATE job_events SET output = ?
       WHERE job_id = ? AND output IS NOT NULL AND sequence = (
         SELECT MIN(sequence) FROM job_events WHERE job_id = ? AND output IS NOT NULL
       )`,
    ).run(
      JSON.stringify({
        type: 'start',
        data: {
          messageId: malformed.assistantMessageId,
          model: 'fixture',
          step: 0,
          status: 'pending',
          jobId: malformed.job.id,
        },
      }),
      malformed.job.id,
      malformed.job.id,
    )
    await recoverChatJobs(runtime.context, recoveryOptions())
    assert.equal(runtime.context.jobService.get(incomplete.job.id)?.status, 'interrupted')
    assert.equal(runtime.context.jobService.get(malformed.job.id)?.status, 'interrupted')
    restarted.close()
  })

  it('rejects application startup before listen and closes the failed recovery database', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-startup-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const first = openDb(path)
    const association = seedChat(first, 'startup-incomplete', 'generating', { partial: true })
    first.prepare('DELETE FROM chat_job_inputs WHERE job_id = ?').run(association.job.id)
    first.close()

    await assert.rejects(start({ dataDir: root, port: 0 }), (error) => {
      assert.ok(error instanceof ChatRecoveryError)
      assert.doesNotMatch(String(error), /startup-incomplete|private prompt|\/tmp|SELECT|alamo\.db/i)
      return true
    })

    // Reopen succeeds only after the failed context released its SQLite handle.
    const verified = openDb(path)
    assert.equal(new JobStore(verified).get(association.job.id)?.status, 'generating')
    assert.equal(terminalCount(verified, association.job.id), 0)
    verified.close()
  })

  it('keeps recovered queued Jobs in one process-local lane, including two Jobs in one thread', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-chat-recovery-lane-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const first = openDb(path)
    const threads = new ThreadStore(first)
    const sharedThread = createThread(threads, 'shared')
    const jobs = [
      seedChat(first, 'lane-a', 'queued', { threadId: sharedThread }),
      seedChat(first, 'lane-b', 'queued', { threadId: sharedThread }),
      seedChat(first, 'lane-c', 'queued'),
    ]
    first.close()

    const gates = [deferred(), deferred(), deferred()]
    let activeProviders = 0
    let maximumProviders = 0
    const restarted = openDb(path)
    const runtime = runtimeFixture(restarted, (_signal, call) =>
      (async function* () {
        activeProviders += 1
        maximumProviders = Math.max(maximumProviders, activeProviders)
        await gates[call - 1]!.promise
        yield terminalChunk(`lane-${call}`)
        activeProviders -= 1
      })(),
    )
    const report = await recoverChatJobs(runtime.context, recoveryOptions({ scanPageSize: 1 }))
    assert.equal(report.queuedScheduled, 3)
    await waitFor(
      () => activeProviders === 1 && runtime.context.governor.waiting === 2,
      'Recovered queued Jobs did not enter one FIFO lane',
    )
    const governor = runtime.context.governor.snapshot()
    const recoveryOrder = jobs.slice().sort(
      (left, right) =>
        left.job.createdAt.localeCompare(right.job.createdAt) ||
        left.job.id.localeCompare(right.job.id),
    )
    assert.deepEqual(governor.activeLease?.owner, {
      kind: 'job',
      jobId: recoveryOrder[0]!.job.id,
    })
    assert.deepEqual(
      governor.queued.map((entry) => entry.owner),
      recoveryOrder.slice(1).map((job) => ({ kind: 'job' as const, jobId: job.job.id })),
    )
    assert.equal(governor.activeLease?.operation, 'chat')
    assert.equal(governor.queued.every((entry) => entry.operation === 'chat'), true)
    for (let index = 0; index < gates.length; index += 1) {
      gates[index]!.resolve()
      await waitFor(
        () => runtime.calls() >= Math.min(index + 2, gates.length),
        `Recovered Job ${index + 1} did not release the next waiter`,
      )
    }
    await waitFor(
      () => jobs.every((job) => runtime.context.jobService.get(job.job.id)?.status === 'completed'),
      'Recovered lane did not complete',
    )
    assert.equal(runtime.calls(), 3)
    assert.equal(maximumProviders, 1)
    assert.equal(runtime.context.governor.active, false)
    restarted.close()
  })

  it('uses interrupted rather than stopped_by_user for graceful owner shutdown', async () => {
    const db = openDb(':memory:')
    const started = deferred()
    const runtime = runtimeFixture(db, (signal) =>
      (async function* () {
        started.resolve()
        yield {
          model: 'fixture',
          created_at: '2026-08-03T10:00:00.000Z',
          message: { role: 'assistant', content: 'shutdown partial' },
          done: false,
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })(),
    )
    const threadId = createThread(runtime.context.threads, 'shutdown')
    const created = runtime.context.chatExecution.createAndStart({
      threadId,
      idempotencyKey: '2d75fc2a-bd1e-49cb-acba-e1a728fb0c50',
      snapshot: { content: 'shutdown prompt', attachments: [], autoApprove: null },
      derivedTitle: 'shutdown prompt',
    })
    await started.promise
    await waitFor(
      () => runtime.context.jobService.get(created.job.id)?.status === 'generating',
      'Shutdown fixture did not start generating',
    )

    await runtime.context.chatExecution.shutdown()
    const job = runtime.context.jobService.get(created.job.id)!
    const message = runtime.context.threads.messages(threadId).at(-1)!
    assert.equal(job.status, 'interrupted')
    assert.equal(job.stopReason, 'application_restart')
    assert.equal(message.turnStatus, 'failed')
    assert.equal(message.stopReason, 'internal_error')
    assert.equal(message.content, 'shutdown partial')
    assert.equal(runtime.context.governor.active, false)
    assert.equal(runtime.context.governor.waiting, 0)
    assert.equal(runtime.context.activeTurns.size, 0)
    assert.doesNotMatch(
      JSON.stringify(runtime.context.jobs.eventsAfter(job.id, 0)),
      /stopped_by_user/,
    )
    db.close()
  })
})
