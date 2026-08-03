import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { ChatJobExecutionOwner } from '../src/jobs/chat-execution.ts'
import { JobService } from '../src/jobs/service.ts'
import type { ModelService } from '../src/models/service.ts'
import type { OllamaClient } from '../src/ollama/client.ts'
import type { OllamaChatChunk } from '../src/ollama/types.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { RuntimeReconciliationService } from '../src/runtime/reconciliation.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { WorkspaceStore } from '../src/store/workspaces.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

const IDEMPOTENCY_KEY = '7d40a711-fc74-41c7-92e2-0046f73baef7'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

function terminalChunk(content: string): OllamaChatChunk {
  return {
    model: 'fixture',
    created_at: '2026-08-03T10:00:00.000Z',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    prompt_eval_duration: 100_000_000,
    eval_count: 3,
    eval_duration: 50_000_000,
    total_duration: 150_000_000,
  }
}

function fixture(
  stream: (signal: AbortSignal, call: number) => AsyncGenerator<OllamaChatChunk>,
): { app: ReturnType<typeof createApp>; context: AppContext; calls: () => number } {
  const db = openDb(':memory:')
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
    appVersion: 'chat-job-fixture',
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
      models: base.models,
    }),
  }
  const context: AppContext = {
    ...runtimeBase,
    chatExecution: new ChatJobExecutionOwner(runtimeBase),
  }
  return { app: createApp(context), context, calls: () => callCount }
}

function createThread(context: AppContext, title = 'New Chat'): string {
  return context.threads.create({
    title,
    mode: 'chat',
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  }).id
}

async function submit(
  app: ReturnType<typeof createApp>,
  threadId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function onlyJob(context: AppContext) {
  const row = context.db.prepare('SELECT id FROM jobs').get() as { id: string }
  return context.jobService.get(row.id)!
}

describe('durable Chat Job execution owner', () => {
  it('deduplicates one key into one Job, initial event, Message pair and adapter call', async () => {
    const { app, context, calls } = fixture(() =>
      (async function* () {
        yield terminalChunk('one answer')
      })(),
    )
    const threadId = createThread(context)

    const [first, duplicate] = await Promise.all([
      submit(app, threadId, { content: 'same prompt', idempotencyKey: IDEMPOTENCY_KEY }),
      submit(app, threadId, { content: 'same prompt', idempotencyKey: IDEMPOTENCY_KEY }),
    ])
    await Promise.all([first.text(), duplicate.text()])

    const job = onlyJob(context)
    assert.equal(job.status, 'completed')
    assert.equal(calls(), 1)
    assert.equal(
      (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      1,
    )
    assert.equal(context.threads.messages(threadId).length, 2)
    assert.equal(context.threads.messages(threadId)[0]?.jobId, job.id)
    assert.equal(context.threads.messages(threadId)[1]?.jobId, job.id)
    assert.equal(
      (context.db
        .prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND sequence = 1")
        .get(job.id) as { count: number }).count,
      1,
    )
    context.db.close()
  })

  it('rejects malformed body/key, missing thread and fingerprint conflict before extra mutation', async () => {
    const { app, context } = fixture(() =>
      (async function* () {
        yield terminalChunk('unused')
      })(),
    )
    const threadId = createThread(context)

    assert.equal((await submit(app, threadId, { content: 'bad', idempotencyKey: 'bad' })).status, 400)
    assert.equal(
      (await submit(app, '00000000-0000-4000-8000-000000000000', {
        content: 'missing',
        idempotencyKey: IDEMPOTENCY_KEY,
      })).status,
      404,
    )
    assert.equal(
      (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      0,
    )

    const gate = deferred()
    const slow = fixture(() =>
      (async function* () {
        await gate.promise
        yield terminalChunk('done')
      })(),
    )
    const slowThread = createThread(slow.context)
    const first = await submit(slow.app, slowThread, {
      content: 'first body',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    await first.body?.cancel()
    const conflict = await submit(slow.app, slowThread, {
      content: 'changed body',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    assert.equal(conflict.status, 409)
    assert.equal(slow.context.threads.messages(slowThread).length, 2)
    gate.resolve()
    await waitFor(() => onlyJob(slow.context).status === 'completed', 'Job did not finish')
    slow.context.db.close()
    context.db.close()
  })

  it('discovers the Job association from persisted Messages and canonical GET', async () => {
    const gate = deferred()
    const { app, context } = fixture(() =>
      (async function* () {
        await gate.promise
        yield terminalChunk('rehydrated')
      })(),
    )
    const threadId = createThread(context)
    const response = await submit(app, threadId, {
      content: 'persist association',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    await response.body?.cancel()
    await waitFor(() => context.threads.messages(threadId).length === 2, 'Message pair missing')

    const loaded = (await (await app.request(`/api/threads/${threadId}`)).json()) as {
      messages: Array<{ role: string; jobId: string | null; turnStatus: string | null }>
    }
    const pending = loaded.messages.find((message) => message.role === 'assistant')!
    assert.equal(pending.turnStatus, 'pending')
    assert.ok(pending.jobId)
    const canonical = (await (await app.request(`/api/jobs/${pending.jobId}`)).json()) as {
      job: { id: string; status: string }
    }
    assert.equal(canonical.job.id, pending.jobId)
    assert.notEqual(canonical.job.status, 'completed')

    gate.resolve()
    await waitFor(() => onlyJob(context).status === 'completed', 'Job did not finish')
    context.db.close()
  })

  it('disconnects only the subscriber and replays ordered output through terminal state', async () => {
    const started = deferred()
    const release = deferred()
    const { app, context } = fixture(() =>
      (async function* () {
        started.resolve()
        yield {
          model: 'fixture',
          created_at: '2026-08-03T10:00:00.000Z',
          message: { role: 'assistant', content: 'partial ' },
          done: false,
        }
        await release.promise
        yield terminalChunk('complete')
      })(),
    )
    const threadId = createThread(context)
    const response = await submit(app, threadId, {
      content: 'detach safely',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    await started.promise
    await response.body?.cancel()
    assert.equal(context.jobService.subscriberCount(), 0)
    assert.notEqual(onlyJob(context).status, 'cancelled')

    release.resolve()
    await waitFor(() => onlyJob(context).status === 'completed', 'Detached Job did not complete')
    const job = onlyJob(context)
    const assistant = context.threads.messages(threadId).at(-1)!
    assert.equal(assistant.turnStatus, 'completed')
    assert.equal(assistant.content, 'partial complete')

    const replay = await app.request(`/api/jobs/${job.id}/events`, {
      headers: { 'Last-Event-ID': '3' },
    })
    const frames = (await replay.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            sequence: number
            output: null | { event: { type: string; data: { delta?: string } } }
          },
      )
    assert.deepEqual(
      frames.map((event) => event.sequence),
      [...frames.map((event) => event.sequence)].sort((left, right) => left - right),
    )
    assert.equal(new Set(frames.map((event) => event.sequence)).size, frames.length)
    assert.equal(
      frames
        .filter((event) => event.output?.event.type === 'token')
        .map((event) => event.output?.event.data.delta ?? '')
        .join(''),
      'partial complete',
    )
    context.db.close()
  })

  it('cancels before admission without calling Ollama and keeps repeated cancel idempotent', async () => {
    const { app, context, calls } = fixture(() =>
      (async function* () {
        yield terminalChunk('must not run')
      })(),
    )
    const blockerTicket = context.governor.enqueue({
      owner: { kind: 'operation', operationId: 'test:blocker' },
      operation: 'model_warm',
      model: { provider: 'ollama', name: 'fixture-blocker' },
      requestedContext: 4_096,
      priority: 'normal',
      enqueuedAt: '2026-08-03T10:00:00.000Z',
    })
    const blocker = await context.governor.acquire(blockerTicket)
    const threadId = createThread(context)
    const response = await submit(app, threadId, {
      content: 'cancel in queue',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    await response.body?.cancel()
    await waitFor(() => onlyJob(context).status === 'reserving', 'Job did not enter admission wait')
    const job = onlyJob(context)

    const first = await app.request(`/api/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(first.status, 200)
    await waitFor(() => context.jobService.get(job.id)?.status === 'cancelled', 'Job not cancelled')
    const before = context.jobService.get(job.id)!.lastEventSequence
    await app.request(`/api/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(context.jobService.get(job.id)!.lastEventSequence, before)
    assert.equal(calls(), 0)
    assert.deepEqual(
      context.jobs.eventsAfter(job.id, 0).map((event) => event.state),
      ['queued', 'reserving', 'cancelling', 'cancelled'],
    )
    assert.equal(context.threads.messages(threadId).at(-1)?.turnStatus, 'cancelled')
    blocker.release()
    context.db.close()
  })

  it('persists cancelling before abort confirmation and writes one terminal projection', async () => {
    const providerStarted = deferred()
    const providerStopped = deferred()
    const { app, context } = fixture((signal) =>
      (async function* () {
        providerStarted.resolve()
        yield {
          model: 'fixture',
          created_at: '2026-08-03T10:00:00.000Z',
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        providerStopped.resolve()
      })(),
    )
    const threadId = createThread(context)
    const response = await submit(app, threadId, {
      content: 'active cancel',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    await providerStarted.promise
    await response.body?.cancel()
    const job = onlyJob(context)

    await app.request(`/api/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.ok(context.jobs.eventsAfter(job.id, 0).some((event) => event.state === 'cancelling'))
    await providerStopped.promise
    await waitFor(() => context.jobService.get(job.id)?.status === 'cancelled', 'Active cancel did not finish')
    const events = context.jobs.eventsAfter(job.id, 0)
    assert.equal(events.filter((event) => event.state === 'cancelled').length, 1)
    assert.equal(context.threads.messages(threadId).at(-1)?.turnStatus, 'cancelled')
    context.db.close()
  })

  it('maps missing terminal provider output to one failed Job and Message', async () => {
    const { app, context } = fixture(() =>
      (async function* () {
        yield {
          model: 'fixture',
          created_at: '2026-08-03T10:00:00.000Z',
          message: { role: 'assistant', content: 'partial without done' },
          done: false,
        }
      })(),
    )
    const threadId = createThread(context)
    const response = await submit(app, threadId, {
      content: 'protocol failure',
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    await response.text()

    const job = onlyJob(context)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.category, 'runtime_protocol')
    const assistant = context.threads.messages(threadId).at(-1)!
    assert.equal(assistant.turnStatus, 'failed')
    assert.equal(assistant.turnError?.code, 'runtime_protocol')
    assert.equal(context.jobs.eventsAfter(job.id, 0).filter((event) => event.state === 'failed').length, 1)
    context.db.close()
  })

  it('never publishes completed when the atomic terminal transaction is injected to fail', async () => {
    const { context } = fixture(() =>
      (async function* () {
        yield terminalChunk('must roll back')
      })(),
    )
    const threadId = createThread(context)
    context.db.exec(`
      CREATE TRIGGER fail_chat_terminal_event
      BEFORE INSERT ON job_events
      WHEN NEW.state IN ('completed','failed','cancelled','interrupted')
      BEGIN
        SELECT RAISE(ABORT, 'private prompt /secret /tmp/private must not escape');
      END;
    `)
    const created = context.chatExecution.createAndStart({
      threadId,
      idempotencyKey: IDEMPOTENCY_KEY,
      snapshot: { content: 'private prompt', attachments: ['/tmp/private'], autoApprove: null },
      derivedTitle: 'private prompt',
    })
    await waitFor(
      () => context.jobService.get(created.job.id)?.status === 'finalizing' && !context.governor.active,
      'Owner did not expose finalizing recovery state and release the inference permit',
    )

    const job = context.jobService.get(created.job.id)!
    assert.equal(job.status, 'finalizing')
    assert.equal(context.threads.messages(threadId).at(-1)?.turnStatus, 'pending')
    const serializedSafeMetadata = context.jobs
      .eventsAfter(job.id, 0)
      .map((event) => JSON.stringify(event.metadata))
      .join('\n')
    assert.doesNotMatch(serializedSafeMetadata, /private prompt|secret|\/tmp\/private/)
    assert.equal(context.jobs.eventsAfter(job.id, 0).some((event) => event.state === 'completed'), false)
    assert.equal(context.governor.active, false)
    context.db.close()
  })

  it('keeps two threads in the single process-local inference lane', async () => {
    const releases = [deferred(), deferred()]
    let activeProviders = 0
    let maxActiveProviders = 0
    const { context } = fixture((_signal, call) =>
      (async function* () {
        activeProviders += 1
        maxActiveProviders = Math.max(maxActiveProviders, activeProviders)
        await releases[call - 1]!.promise
        yield terminalChunk(`answer-${call}`)
        activeProviders -= 1
      })(),
    )
    const firstThread = createThread(context, 'first')
    const secondThread = createThread(context, 'second')
    const first = context.chatExecution.createAndStart({
      threadId: firstThread,
      idempotencyKey: IDEMPOTENCY_KEY,
      snapshot: { content: 'first', attachments: [], autoApprove: null },
      derivedTitle: 'first',
    })
    const second = context.chatExecution.createAndStart({
      threadId: secondThread,
      idempotencyKey: 'e2a32d55-44b8-4fa8-8c21-8414cfeac52e',
      snapshot: { content: 'second', attachments: [], autoApprove: null },
      derivedTitle: 'second',
    })
    await waitFor(() => activeProviders === 1 && context.governor.waiting === 1, 'Second Job did not queue')
    releases[0]!.resolve()
    await waitFor(() => context.jobService.get(first.job.id)?.status === 'completed', 'First Job did not finish')
    await waitFor(() => activeProviders === 1, 'Second provider did not start')
    releases[1]!.resolve()
    await waitFor(() => context.jobService.get(second.job.id)?.status === 'completed', 'Second Job did not finish')
    assert.equal(maxActiveProviders, 1)
    context.db.close()
  })

  it('splits oversized streaming deltas into bounded ordered replay without truncation', async () => {
    const content = 'аб'.repeat(20_000)
    const { context } = fixture(() =>
      (async function* () {
        yield terminalChunk(content)
      })(),
    )
    const threadId = createThread(context)
    const created = context.chatExecution.createAndStart({
      threadId,
      idempotencyKey: IDEMPOTENCY_KEY,
      snapshot: { content: 'large output', attachments: [], autoApprove: null },
      derivedTitle: 'large output',
    })
    await waitFor(() => context.jobService.get(created.job.id)?.status === 'completed', 'Large Job did not finish')

    const outputEvents = context.jobs
      .eventsAfter(created.job.id, 0)
      .filter((event) => event.output?.event.type === 'token')
    assert.ok(outputEvents.length > 1)
    assert.ok(
      outputEvents.every(
        (event) => Buffer.byteLength(JSON.stringify(event.output!.event), 'utf8') < 17_000,
      ),
    )
    assert.equal(
      outputEvents
        .map((event) =>
          event.output?.event.type === 'token' ? event.output.event.data.delta : '',
        )
        .join(''),
      content,
    )
    assert.equal(context.threads.messages(threadId).at(-1)?.content, content)
    context.db.close()
  })

  it('resolves disconnect/cancel/terminal races to one matching terminal projection in 10 repeats', async () => {
    for (let repeat = 0; repeat < 10; repeat += 1) {
      const started = deferred()
      const release = deferred()
      const { context } = fixture((signal) =>
        (async function* () {
          started.resolve()
          await release.promise
          if (!signal.aborted) yield terminalChunk(`race-${repeat}`)
        })(),
      )
      const threadId = createThread(context)
      const created = context.chatExecution.createAndStart({
        threadId,
        idempotencyKey: IDEMPOTENCY_KEY,
        snapshot: { content: `race-${repeat}`, attachments: [], autoApprove: null },
        derivedTitle: `race-${repeat}`,
      })
      await started.promise
      const cancel = context.chatExecution.cancel(created.job.id, 'user_requested')
      release.resolve()
      await cancel
      await waitFor(
        () => context.jobService.get(created.job.id)?.status === 'cancelled',
        `Race ${repeat} did not cancel`,
      )

      const job = context.jobService.get(created.job.id)!
      const assistant = context.threads.messages(threadId).at(-1)!
      assert.equal(job.status, 'cancelled')
      assert.equal(assistant.turnStatus, 'cancelled')
      assert.equal(
        context.jobs
          .eventsAfter(job.id, 0)
          .filter((event) =>
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(event.state),
          ).length,
        1,
      )
      context.db.close()
    }
  })
})
