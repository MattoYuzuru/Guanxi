import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { UnsupportedHostTelemetry } from '../src/hardware/telemetry.ts'
import { JobService } from '../src/jobs/service.ts'
import { ChatJobExecutionOwner } from '../src/jobs/chat-execution.ts'
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
  cpuModel: 'test',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'test',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function testContext(
  overrides: Partial<Pick<AppContext, 'ollama' | 'models'>> = {},
): AppContext {
  const db = openDb(':memory:')
  const settings = new SettingsStore(db, { ollamaHost: 'http://127.0.0.1:11434' })
  const jobs = new JobStore(db)

  const base = {
    db,
    jobs,
    jobService: new JobService(jobs),
    threads: new ThreadStore(db),
    workspaces: new WorkspaceStore(db),
    settings,
    calibration: new CalibrationStore(db),
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware: HARDWARE,
    hostTelemetry: new UnsupportedHostTelemetry(HARDWARE),
    appVersion: 'test',
    activeTurns: new Map(),
    governor: new ResourceGovernor(),
    ollama:
      overrides.ollama ??
      (() => {
        throw new Error('Ollama не должна вызываться в этом тесте')
      }),
    models:
      overrides.models ??
      (() => {
        throw new Error('ModelService не должен вызываться в этом тесте')
      }),
  }
  const runtimeBase = {
    ...base,
    runtime: new RuntimeReconciliationService({
      governor: base.governor,
      hostTelemetry: base.hostTelemetry,
      models: base.models,
    }),
  }
  return { ...runtimeBase, chatExecution: new ChatJobExecutionOwner(runtimeBase) }
}

function terminalChunk(content: string): OllamaChatChunk {
  return {
    model: 'qwen',
    created_at: '2026-08-02T12:00:00.000Z',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    prompt_eval_duration: 500_000_000,
    eval_count: 3,
    eval_duration: 100_000_000,
    total_duration: 600_000_000,
  }
}

function streamingContext(
  stream: (signal: AbortSignal) => AsyncGenerator<OllamaChatChunk>,
): AppContext {
  return testContext({
    ollama: () =>
      ({
        chatStream(_request: unknown, signal: AbortSignal) {
          return stream(signal)
        },
      }) as unknown as OllamaClient,
    models: () =>
      ({
        supportsTools: async () => false,
      }) as unknown as ModelService,
  })
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

async function createChat(context: AppContext): Promise<string> {
  const thread = context.threads.create({
    title: 'route turn',
    mode: 'chat',
    model: 'qwen',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
  return thread.id
}

describe('thread routes', () => {
  it('отклоняет неизвестный workspace агентного треда', async () => {
    const context = testContext()
    const app = createApp(context)

    const response = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'agent',
        model: 'qwen',
        workspaceId: 'missing',
      }),
    })

    assert.equal(response.status, 404)
    assert.equal(((await response.json()) as { code: string }).code, 'workspace_not_found')
    context.db.close()
  })

  it('создаёт чат без файлового workspace и читает его обратно', async () => {
    const context = testContext()
    const app = createApp(context)

    const created = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat',
        model: 'qwen',
        workspaceId: 'ignored-for-chat',
      }),
    })

    assert.equal(created.status, 201)
    const thread = (await created.json()) as { id: string; workspaceId: string | null }
    assert.equal(thread.workspaceId, null)

    const loaded = await app.request(`/api/threads/${thread.id}`)
    assert.equal(loaded.status, 200)
    assert.equal(((await loaded.json()) as { thread: { id: string } }).thread.id, thread.id)
    context.db.close()
  })

  it('streams a persisted completed outcome and reloads the same projection', async () => {
    const context = streamingContext(() =>
      (async function* () {
        yield terminalChunk('route success')
      })(),
    )
    const app = createApp(context)
    const threadId = await createChat(context)

    const response = await app.request(`/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    const events = parseSse(await response.text())
    const done = events.find((event) => event['type'] === 'done')
    assert.equal((done?.['data'] as { outcome?: string }).outcome, 'completed')

    const loaded = await app.request(`/api/threads/${threadId}`)
    const body = (await loaded.json()) as {
      messages: Array<{
        role: string
        content: string
        turnStatus: string | null
        turnError: unknown
        stopReason: string | null
      }>
    }
    const assistant = body.messages.at(-1)
    assert.equal(assistant?.role, 'assistant')
    assert.equal(assistant?.content, 'route success')
    assert.equal(assistant?.turnStatus, 'completed')
    assert.equal(assistant?.turnError, null)
    assert.equal(assistant?.stopReason, 'stop')
    context.db.close()
  })

  it('reloads pending, failed, cancelled, and legacy-ambiguous rows distinctly', async () => {
    const context = testContext()
    const app = createApp(context)
    const threadId = await createChat(context)

    context.threads.addMessage({
      threadId,
      role: 'assistant',
      content: 'pending partial',
    })
    const failed = context.threads.addMessage({
      threadId,
      role: 'assistant',
      content: '',
    })
    context.threads.terminalizeMessage(failed.id, {
      outcome: 'failed',
      error: {
        code: 'runtime_protocol',
        message: 'Ollama ended the stream without the required terminal chunk',
      },
      stopReason: 'protocol_error',
      content: 'failed partial',
      thinking: null,
      toolCalls: [],
      usage: null,
    })
    const cancelled = context.threads.addMessage({
      threadId,
      role: 'assistant',
      content: '',
    })
    context.threads.terminalizeMessage(cancelled.id, {
      outcome: 'cancelled',
      error: null,
      stopReason: 'stopped_by_user',
      content: 'cancelled partial',
      thinking: null,
      toolCalls: [],
      usage: null,
    })
    context.db
      .prepare(
        `INSERT INTO messages (
           id, thread_id, seq, role, content, thinking, tool_calls, usage,
           is_compaction, created_at, turn_status, turn_error, stop_reason
         )
         VALUES ('legacy-row', ?, 3, 'assistant', '', NULL, '[]', NULL, 0, ?, NULL, NULL, NULL)`,
      )
      .run(threadId, '2026-08-02T12:00:00.000Z')

    const loaded = await app.request(`/api/threads/${threadId}`)
    const body = (await loaded.json()) as {
      messages: Array<{
        turnStatus: string | null
        turnError: { code: string; message: string } | null
        stopReason: string | null
      }>
    }
    assert.deepEqual(
      body.messages.map((message) => ({
        status: message.turnStatus,
        error: message.turnError?.code ?? null,
        reason: message.stopReason,
      })),
      [
        { status: 'pending', error: null, reason: null },
        { status: 'failed', error: 'runtime_protocol', reason: 'protocol_error' },
        { status: 'cancelled', error: null, reason: 'stopped_by_user' },
        { status: null, error: null, reason: null },
      ],
    )
    context.db.close()
  })

  it('persists explicit Stop as cancelled before the stream closes', async () => {
    const context = streamingContext((signal) =>
      (async function* () {
        yield {
          model: 'qwen',
          created_at: '2026-08-02T12:00:00.000Z',
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      })(),
    )
    const app = createApp(context)
    const threadId = await createChat(context)
    const response = await app.request(`/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let streamText = ''
    streamText += decoder.decode((await reader.read()).value)
    streamText += decoder.decode((await reader.read()).value)

    const stopped = await app.request(`/api/threads/${threadId}/stop`, { method: 'POST' })
    assert.equal(stopped.status, 200)

    while (true) {
      const next = await reader.read()
      if (next.done) break
      streamText += decoder.decode(next.value)
    }

    const done = parseSse(streamText).find((event) => event['type'] === 'done')
    assert.deepEqual(done?.['data'], {
      messageId: context.threads.messages(threadId).at(-1)?.id,
      outcome: 'cancelled',
      stopReason: 'stopped_by_user',
      terminalStopReason: 'stopped_by_user',
      steps: 1,
    })
    assert.equal(context.threads.messages(threadId).at(-1)?.turnStatus, 'cancelled')
    context.db.close()
  })

  it('keeps the durable Job running after response-body cancellation', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const context = streamingContext(() =>
      (async function* () {
        yield {
          model: 'qwen',
          created_at: '2026-08-02T12:00:00.000Z',
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }
        await released
        yield terminalChunk(' completed')
      })(),
    )
    const app = createApp(context)
    const threadId = await createChat(context)
    const response = await app.request(`/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    await reader.cancel()

    const pending = context.threads.messages(threadId).at(-1)
    assert.equal(context.activeTurns.has(threadId), true)
    assert.equal(pending?.turnStatus, 'pending')

    release()
    for (let attempt = 0; attempt < 100 && context.activeTurns.has(threadId); attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    const assistant = context.threads.messages(threadId).at(-1)
    assert.equal(context.activeTurns.has(threadId), false)
    assert.equal(assistant?.content, 'partial completed')
    assert.equal(assistant?.turnStatus, 'completed')
    assert.equal(assistant?.stopReason, 'stop')
    context.db.close()
  })
})
