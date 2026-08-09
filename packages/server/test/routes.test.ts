import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import { FeatureFlagRegistry } from '../src/config/feature-flags.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { UnsupportedHostTelemetry } from '../src/hardware/telemetry.ts'
import { JobService } from '../src/jobs/service.ts'
import { ChatJobExecutionOwner } from '../src/jobs/chat-execution.ts'
import {
  ModelContextLimitExceededError,
  type ModelService,
} from '../src/models/service.ts'
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
import { ProjectStore } from '../src/store/projects.ts'
import { ProjectService } from '../src/projects/service.ts'

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
    projects: new ProjectService(new ProjectStore(db)),
    settings,
    featureFlags: new FeatureFlagRegistry({ environment: { state: 'available', values: {} } }),
    calibration: new CalibrationStore(db),
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware: HARDWARE,
    hardwareObservedAt: '2026-08-09T12:00:00.000Z',
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
        return {
          supportsTools: async () => false,
          assertContextAllowed: async () => undefined,
        } as unknown as ModelService
      }),
  }
  const runtimeBase = {
    ...base,
    runtime: new RuntimeReconciliationService({
      governor: base.governor,
      hostTelemetry: base.hostTelemetry,
      models: base.models,
    }),
    estimatedParallelAdmission: null as never,
  }
  return {
    ...runtimeBase,
    completionProbe: { execute: async () => { throw new Error('not invoked') } } as never,
    capabilityOverrides: {
      apply: async () => { throw new Error('not invoked') },
      clear: async () => { throw new Error('not invoked') },
    } as never,
    // P2-J discovery is unrelated to these flows: reaching it is a defect.
    huggingFace: {
      search: async () => { throw new Error('not invoked') },
      repository: async () => { throw new Error('not invoked') },
    } as never,
    huggingFaceDownloads: { download: async function* () {} } as never,
    huggingFaceImports: { import: async function* () {} } as never,
    chatExecution: new ChatJobExecutionOwner(runtimeBase),
  }
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
        assertContextAllowed: async () => undefined,
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

  it('returns sourced context-limit details while unknown evidence allows the exact request', async () => {
    const contextLimit = {
      state: 'declared' as const,
      value: 32_768,
      source: 'ollama_api_tags' as const,
      observedAt: '2026-08-03T00:00:00.000Z',
      confidence: 'declared' as const,
    }
    const checked: Array<{ model: string; requestedContext: number }> = []
    const context = testContext({
      models: () =>
        ({
          supportsTools: async () => false,
          assertContextAllowed: async (model: string, requestedContext: number) => {
            checked.push({ model, requestedContext })
            if (model === 'declared-limit:latest') {
              throw new ModelContextLimitExceededError(model, requestedContext, contextLimit)
            }
            // No provider declaration is represented by the absence of a refusal.
          },
        }) as unknown as ModelService,
    })
    const app = createApp(context)
    try {
      const rejected = await app.request('/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'chat',
          model: 'declared-limit:latest',
          options: { numCtx: 32_769 },
        }),
      })
      assert.equal(rejected.status, 400)
      assert.deepEqual(await rejected.json(), {
        code: 'context_limit_exceeded',
        message: 'Requested context 32769 exceeds the declared model limit 32768',
        details: {
          model: 'declared-limit:latest',
          requestedContext: 32_769,
          contextLimit,
        },
      })

      const customContext = 1_048_577
      const allowed = await app.request('/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'chat',
          model: 'unknown-limit:latest',
          options: { numCtx: customContext },
        }),
      })
      assert.equal(allowed.status, 201)
      assert.equal(
        ((await allowed.json()) as { options: { numCtx: number } }).options.numCtx,
        customContext,
      )
      assert.deepEqual(checked, [
        { model: 'declared-limit:latest', requestedContext: 32_769 },
        { model: 'unknown-limit:latest', requestedContext: customContext },
      ])
    } finally {
      context.db.close()
    }
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

  it('round-trips the additive prewarm setting through the public settings route', async () => {
    const context = testContext()
    const app = createApp(context)
    try {
      const initial = (await (await app.request('/api/settings')).json()) as {
        prewarmEnabled: boolean
      }
      assert.equal(initial.prewarmEnabled, true)

      const updated = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prewarmEnabled: false }),
      })
      assert.equal(updated.status, 200)
      assert.equal(((await updated.json()) as { prewarmEnabled: boolean }).prewarmEnabled, false)
      assert.equal(context.settings.get().prewarmEnabled, false)
    } finally {
      context.db.close()
    }
  })

  it('saves and reloads an exact default context above the retired ceiling', async () => {
    const customContext = 1_048_577
    const context = testContext()
    const app = createApp(context)
    try {
      const updated = await app.request('/api/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultNumCtx: customContext }),
      })
      assert.equal(updated.status, 200)
      assert.equal(((await updated.json()) as { defaultNumCtx: number }).defaultNumCtx, customContext)
      const reloaded = await app.request('/api/settings')
      assert.equal(((await reloaded.json()) as { defaultNumCtx: number }).defaultNumCtx, customContext)
    } finally {
      context.db.close()
    }
  })
})

describe('project routes', () => {
  it('creates and reads a logical Project without path, binding or external side effects', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-project-route-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const beforeEntries = await readdir(root)
    const context = testContext()
    test.after(() => context.db.close())
    const app = createApp(context)
    const jobCountBefore = (
      context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }
    ).count

    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Logical container  ' }),
    })
    assert.equal(response.status, 201)
    const created = (await response.json()) as Record<string, unknown>
    assert.equal(created.name, 'Logical container')
    assert.deepEqual(created.filesystemBindings, [])
    assert.equal(Object.hasOwn(created, 'rootPath'), false)
    assert.equal(Object.hasOwn(created, 'path'), false)

    const loaded = await app.request(`/api/projects/${String(created.id)}`)
    assert.equal(loaded.status, 200)
    assert.deepEqual(await loaded.json(), created)
    assert.deepEqual(await readdir(root), beforeEntries)
    assert.equal(
      (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      jobCountBefore,
    )
    assert.equal(context.governor.snapshot().activeLease, null)
  })

  it('rejects invalid Project names before any database mutation', async (test) => {
    const context = testContext()
    test.after(() => context.db.close())
    const app = createApp(context)

    for (const body of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: 'valid', rootPath: '/must-not-be-accepted' },
    ]) {
      const response = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json() as { code: string }).code, 'validation_failed')
    }
    assert.equal(
      (context.db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count,
      0,
    )
  })

  it('keeps legacy Workspace JSON byte-compatible and maps it exactly once', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-workspace-bridge-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const context = testContext()
    test.after(() => context.db.close())
    const app = createApp(context)

    const createdResponse = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootPath: root, name: 'Legacy exact response' }),
    })
    assert.equal(createdResponse.status, 201)
    const legacy = await createdResponse.json() as Record<string, unknown>
    assert.deepEqual(Object.keys(legacy).sort(), [
      'createdAt', 'exists', 'id', 'lastUsedAt', 'name', 'rootPath',
    ])

    const legacyListBefore = await (await app.request('/api/workspaces')).text()
    const projectList = await app.request('/api/projects')
    const projects = (await projectList.json() as { projects: Array<Record<string, unknown>> }).projects
    const bridged = projects.filter((project) => project.id === legacy.id)
    assert.equal(bridged.length, 1)
    assert.deepEqual(bridged[0]?.filesystemBindings, [{
      id: `workspace:${String(legacy.id)}`,
      workspaceId: legacy.id,
      createdAt: legacy.createdAt,
    }])
    assert.equal(
      (context.db.prepare(
        'SELECT COUNT(*) AS count FROM project_filesystem_bindings WHERE workspace_id = ?',
      ).get(String(legacy.id)) as { count: number }).count,
      1,
    )

    const unrelated = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Independent Project' }),
    })
    assert.equal(unrelated.status, 201)
    assert.equal(await (await app.request('/api/workspaces')).text(), legacyListBefore)

    const projectless = String(legacy.id)
    context.db.prepare('DELETE FROM projects WHERE id = ?').run(projectless)
    const readable = await app.request(`/api/workspaces/${projectless}`)
    assert.equal(readable.status, 200)
    assert.deepEqual(await readable.json(), legacy)
  })

  it('renames only Project metadata without changing a Workspace path', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-project-rename-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const context = testContext()
    test.after(() => context.db.close())
    const app = createApp(context)
    const workspace = context.workspaces.create(root, 'Bound name')
    context.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(
      '2026-08-01T00:00:00.000Z',
      workspace.id,
    )

    const response = await app.request(`/api/projects/${workspace.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Project' }),
    })
    assert.equal(response.status, 200)
    const renamed = await response.json() as { name: string; updatedAt: string }
    assert.equal(renamed.name, 'Renamed Project')
    assert.notEqual(renamed.updatedAt, '2026-08-01T00:00:00.000Z')
    assert.equal(context.workspaces.get(workspace.id)?.rootPath, root)
    assert.equal(context.workspaces.get(workspace.id)?.name, 'Bound name')
  })
})
