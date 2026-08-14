import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  PROJECT_PRESENTATION_VERSION,
  listProjectsResponse,
  listProjectsWithPresentationResponse,
  workspaceSchema,
  type HardwareInfo,
} from '@alamo/contract'
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
import { ChatRetentionService } from '../src/retention/service.ts'
import { ChatRetentionStore } from '../src/store/chat-retention.ts'

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
    retention: new ChatRetentionService(new ChatRetentionStore(db)),
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
    artifacts: null as never,
    artifactTransfers: null as never,
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

  it('round-trips an exact locale and rejects future or extra settings without partial writes', async () => {
    const context = testContext()
    const app = createApp(context)
    try {
      const initial = await (await app.request('/api/settings')).json() as {
        locale: string
        localeSource: string
      }
      assert.equal(initial.locale, 'en')
      assert.equal(initial.localeSource, 'default')

      const updated = await app.request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'ru' }),
      })
      assert.equal(updated.status, 200)
      const updatedBody = await updated.json() as { locale: string; localeSource: string }
      assert.equal(updatedBody.locale, 'ru')
      assert.equal(updatedBody.localeSource, 'user_setting')

      for (const body of [{ locale: 'future' }, { locale: 'en', future: true }]) {
        const rejected = await app.request('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        assert.equal(rejected.status, 400)
        assert.equal(context.settings.get().locale, 'ru')
      }
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
    const presentationList = await app.request('/api/projects?presentationVersion=1')
    const presentationProject = (
      await presentationList.json() as { projects: Array<Record<string, unknown>> }
    ).projects.find((project) => project.id === created.id)
    assert.equal(presentationProject?.iconKey, 'folder')
    assert.equal(presentationProject?.colorToken, 'slate')
    assert.deepEqual(presentationProject?.filesystemBindings, [])
    const presentationUpdate = await app.request(
      `/api/projects/${String(created.id)}/presentation`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presentationVersion: 1, iconKey: 'star', colorToken: 'green' }),
      },
    )
    assert.equal(presentationUpdate.status, 200)
    const presented = await presentationUpdate.json() as Record<string, unknown>
    assert.equal(presented.iconKey, 'star')
    assert.equal(presented.colorToken, 'green')
    assert.deepEqual(presented.filesystemBindings, [])
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
    const createdBytes = await createdResponse.text()
    const legacy = workspaceSchema.parse(JSON.parse(createdBytes))
    assert.match(
      legacy.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    assert.equal(Number.isNaN(Date.parse(legacy.createdAt)), false)
    const exactLegacy = {
      id: legacy.id,
      name: 'Legacy exact response',
      rootPath: root,
      createdAt: legacy.createdAt,
      lastUsedAt: null,
      exists: true,
    }
    assert.equal(createdBytes, JSON.stringify(exactLegacy))

    const legacyListBefore = await (await app.request('/api/workspaces')).text()
    assert.equal(legacyListBefore, JSON.stringify({ workspaces: [exactLegacy] }))
    const projectList = await app.request('/api/projects')
    const projects = (
      await projectList.json() as { projects: Array<Record<string, unknown>> }
    ).projects
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
    assert.equal(await readable.text(), JSON.stringify(exactLegacy))
  })

  it('preserves literal legacy Workspace GET bytes across the compatibility bridge', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-workspace-bytes-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const context = testContext()
    test.after(() => context.db.close())
    const app = createApp(context)
    const legacy = {
      id: 'legacy-byte-baseline',
      name: 'Literal legacy Workspace',
      rootPath: root,
      createdAt: '2026-08-09T10:00:00.000Z',
      lastUsedAt: null,
      exists: true,
    }
    context.db.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run(legacy.id, legacy.name, legacy.rootPath, legacy.createdAt)

    assert.equal(
      await (await app.request(`/api/workspaces/${legacy.id}`)).text(),
      JSON.stringify(legacy),
    )
    const expectedListBytes = JSON.stringify({ workspaces: [legacy] })
    assert.equal(await (await app.request('/api/workspaces')).text(), expectedListBytes)

    context.projects.reconcileLegacyWorkspaces()
    assert.equal(
      (context.db.prepare(
        'SELECT COUNT(*) AS count FROM projects WHERE id = ?',
      ).get(legacy.id) as { count: number }).count,
      1,
    )
    assert.equal(
      (context.db.prepare(
        'SELECT COUNT(*) AS count FROM project_filesystem_bindings WHERE workspace_id = ?',
      ).get(legacy.id) as { count: number }).count,
      1,
    )
    assert.equal(await (await app.request('/api/workspaces')).text(), expectedListBytes)

    context.db.prepare('DELETE FROM projects WHERE id = ?').run(legacy.id)
    assert.equal(
      await (await app.request(`/api/workspaces/${legacy.id}`)).text(),
      JSON.stringify(legacy),
    )
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

  it('opts into presentation v1 without changing strict legacy Project or Workspace bytes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-project-versioned-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const context = testContext()
    test.after(() => context.db.close())
    const app = createApp(context)
    context.workspaces.create(root, 'Legacy bridge')

    const legacyWorkspaceBytes = await (await app.request('/api/workspaces')).text()
    const legacyProjectBytes = await (await app.request('/api/projects')).text()
    assert.equal(listProjectsResponse.safeParse(JSON.parse(legacyProjectBytes)).success, true)
    assert.equal(legacyProjectBytes.includes('iconKey'), false)
    assert.equal(legacyProjectBytes.includes('colorToken'), false)

    const current = await app.request(
      `/api/projects?presentationVersion=${PROJECT_PRESENTATION_VERSION}`,
    )
    assert.equal(current.status, 200)
    const currentBody = await current.json()
    assert.equal(listProjectsWithPresentationResponse.safeParse(currentBody).success, true)
    assert.deepEqual(
      (currentBody as { projects: Array<{ iconKey: string; colorToken: string }> }).projects
        .map(({ iconKey, colorToken }) => ({ iconKey, colorToken })),
      [{ iconKey: 'folder', colorToken: 'slate' }],
    )
    assert.equal(await (await app.request('/api/projects')).text(), legacyProjectBytes)
    assert.equal(await (await app.request('/api/workspaces')).text(), legacyWorkspaceBytes)

    for (const query of [
      'presentationVersion=2',
      'presentationVersion=1&presentationVersion=1',
      'presentationVersion=1&extra=true',
      'unknown=true',
    ]) {
      assert.equal((await app.request(`/api/projects?${query}`)).status, 400)
    }
  })

  it('rejects invalid presentation before mutation and changes only metadata once', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-project-presentation-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    let ollamaBoundaryCalls = 0
    let modelBoundaryCalls = 0
    const context = testContext({
      ollama: () => {
        ollamaBoundaryCalls += 1
        throw new Error('Project presentation must not resolve Ollama')
      },
      models: () => {
        modelBoundaryCalls += 1
        throw new Error('Project presentation must not read model providers')
      },
    })
    test.after(() => context.db.close())
    const app = createApp(context)
    const workspace = context.workspaces.create(root, 'Bound identity')
    context.threads.create({
      title: 'Unrelated thread',
      mode: 'chat',
      model: 'test:latest',
      workspaceId: workspace.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    context.jobs.create({
      kind: 'inference',
      operation: 'unrelated',
      idempotencyScope: 'project-presentation-test',
      idempotencyKey: 'unrelated-job',
    })
    context.db.prepare("INSERT INTO settings (key, value) VALUES ('permission-sentinel', 'unchanged')").run()
    context.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(
      '2026-08-01T00:00:00.000Z',
      workspace.id,
    )

    const projectBefore = context.db.prepare('SELECT * FROM projects WHERE id = ?').get(workspace.id)
    const workspaceBefore = context.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace.id)
    const bindingBefore = context.db.prepare(
      'SELECT * FROM project_filesystem_bindings WHERE project_id = ?',
    ).get(workspace.id)
    const threadBefore = JSON.stringify(context.db.prepare('SELECT * FROM threads').all())
    const jobsBefore = JSON.stringify(context.db.prepare('SELECT * FROM jobs').all())
    const eventsBefore = JSON.stringify(context.db.prepare('SELECT * FROM job_events').all())
    const settingsBefore = JSON.stringify(context.db.prepare('SELECT * FROM settings ORDER BY key').all())
    const rootBefore = await readdir(root)

    const presentationRead = await app.request(
      `/api/projects?presentationVersion=${PROJECT_PRESENTATION_VERSION}`,
    )
    assert.equal(presentationRead.status, 200)
    assert.deepEqual(
      (await presentationRead.json() as {
        projects: Array<{ id: string; iconKey: string; colorToken: string }>
      }).projects.map(({ id, iconKey, colorToken }) => ({ id, iconKey, colorToken })),
      [{ id: workspace.id, iconKey: 'folder', colorToken: 'slate' }],
    )
    assert.equal(ollamaBoundaryCalls, 0)
    assert.equal(modelBoundaryCalls, 0)

    for (const body of [
      { presentationVersion: 2, iconKey: 'rocket', colorToken: 'blue' },
      { presentationVersion: 1, iconKey: 'future-icon', colorToken: 'blue' },
      { presentationVersion: 1, iconKey: 'rocket', colorToken: 'future-color' },
      { presentationVersion: 1, iconKey: 'x'.repeat(10_000), colorToken: 'blue' },
      { presentationVersion: 1, iconKey: 'rocket', colorToken: 'blue', extra: true },
    ]) {
      const response = await app.request(`/api/projects/${workspace.id}/presentation`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400)
      assert.deepEqual(
        context.db.prepare('SELECT * FROM projects WHERE id = ?').get(workspace.id),
        projectBefore,
      )
    }

    const mutation = {
      presentationVersion: PROJECT_PRESENTATION_VERSION,
      iconKey: 'rocket',
      colorToken: 'blue',
    } as const
    const first = await app.request(`/api/projects/${workspace.id}/presentation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation),
    })
    assert.equal(first.status, 200)
    const firstBody = await first.json() as Record<string, unknown>
    assert.equal(firstBody.id, workspace.id)
    assert.equal(firstBody.name, 'Bound identity')
    assert.equal(firstBody.iconKey, 'rocket')
    assert.equal(firstBody.colorToken, 'blue')
    assert.notEqual(firstBody.updatedAt, '2026-08-01T00:00:00.000Z')
    const updatedAt = firstBody.updatedAt

    const retry = await app.request(`/api/projects/${workspace.id}/presentation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mutation),
    })
    assert.equal(retry.status, 200)
    assert.equal((await retry.json() as { updatedAt: string }).updatedAt, updatedAt)

    const projectAfter = context.db.prepare('SELECT * FROM projects WHERE id = ?').get(workspace.id) as Record<string, unknown>
    assert.equal(projectAfter.id, (projectBefore as Record<string, unknown>).id)
    assert.equal(projectAfter.name, (projectBefore as Record<string, unknown>).name)
    assert.equal(projectAfter.created_at, (projectBefore as Record<string, unknown>).created_at)
    assert.equal(projectAfter.icon_key, 'rocket')
    assert.equal(projectAfter.color_token, 'blue')
    assert.notEqual(projectAfter.updated_at, (projectBefore as Record<string, unknown>).updated_at)
    assert.deepEqual(
      context.db.prepare('SELECT * FROM project_filesystem_bindings WHERE project_id = ?').get(workspace.id),
      bindingBefore,
    )
    assert.deepEqual(
      context.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace.id),
      workspaceBefore,
    )
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM threads').all()), threadBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM jobs').all()), jobsBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM job_events').all()), eventsBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM settings ORDER BY key').all()), settingsBefore)
    assert.deepEqual(await readdir(root), rootBefore)
    assert.equal(context.governor.snapshot().activeLease, null)
    assert.equal(ollamaBoundaryCalls, 0)
    assert.equal(modelBoundaryCalls, 0)
  })

  it('pins legacy Thread create/list/read/update bytes and rejects ownership query drift', async (test) => {
    const context = testContext({
      models: () => ({
        supportsTools: async () => false,
        assertContextAllowed: async () => undefined,
      }) as unknown as ModelService,
    })
    test.after(() => context.db.close())
    const app = createApp(context)
    const createdResponse = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Legacy raw',
        mode: 'chat',
        model: 'model',
        options: { numCtx: 8192, temperature: 0.7, think: 'off' },
      }),
    })
    const createBytes = await createdResponse.text()
    const created = JSON.parse(createBytes) as {
      id: string
      createdAt: string
      updatedAt: string
    }
    const expectedCreated = {
      id: created.id,
      title: 'Legacy raw',
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      messageCount: 0,
    }
    assert.equal(createdResponse.status, 201)
    assert.equal(createBytes, JSON.stringify(expectedCreated))
    assert.deepEqual(
      (await (await app.request(`/api/threads/${created.id}/retention`)).json() as { policy: unknown }).policy,
      { mode: 'ttl', expiresAfterDays: 7 },
    )
    assert.equal(
      await (await app.request('/api/threads')).text(),
      JSON.stringify({ threads: [expectedCreated] }),
    )

    const updatedResponse = await app.request(`/api/threads/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Legacy updated' }),
    })
    const updateBytes = await updatedResponse.text()
    const updated = JSON.parse(updateBytes) as { updatedAt: string }
    const expectedUpdated = {
      ...expectedCreated,
      title: 'Legacy updated',
      updatedAt: updated.updatedAt,
    }
    assert.equal(updatedResponse.status, 200)
    assert.equal(updateBytes, JSON.stringify(expectedUpdated))
    assert.equal(
      await (await app.request(`/api/threads/${created.id}`)).text(),
      JSON.stringify({
        thread: expectedUpdated,
        messages: [],
        context: {
          usedTokens: 0,
          allocatedTokens: 8192,
          percent: 0,
          cacheHit: false,
          cachedTokens: 0,
          compactable: false,
          estimatedRepefillMs: 0,
        },
      }),
    )
    for (const query of [
      '?ownershipVersion=2&scope=projectless',
      '?ownershipVersion=1&scope=projectless&future=1',
      '?ownershipVersion=1&ownershipVersion=1&scope=projectless',
    ]) {
      assert.equal((await app.request(`/api/threads${query}`)).status, 400)
    }
    assert.equal(
      (context.db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
      1,
    )
  })

  it('creates and reads Project Chats through one immutable scoped boundary', async (test) => {
    const modelValidationCalls: Array<[string, number]> = []
    const context = testContext({
      models: () => ({
        supportsTools: async () => false,
        assertContextAllowed: async (model: string, numCtx: number) => {
          modelValidationCalls.push([model, numCtx])
        },
      }) as unknown as ModelService,
    })
    test.after(() => context.db.close())
    const app = createApp(context)
    const first = context.projects.create('First Project')
    const second = context.projects.create('Second Project')
    const legacy = context.threads.create({
      title: 'Legacy projectless',
      mode: 'chat',
      model: 'model',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    const legacyBytes = await (await app.request(`/api/threads/${legacy.id}`)).text()
    const expectedLegacyBytes = JSON.stringify({
      thread: legacy,
      messages: [],
      context: {
        usedTokens: 0,
        allocatedTokens: 8192,
        percent: 0,
        cacheHit: false,
        cachedTokens: 0,
        compactable: false,
        estimatedRepefillMs: 0,
      },
    })
    assert.equal(legacyBytes, expectedLegacyBytes)
    const projectBefore = JSON.stringify(context.db.prepare('SELECT * FROM projects ORDER BY id').all())
    const bindingsBefore = JSON.stringify(context.db.prepare('SELECT * FROM project_filesystem_bindings ORDER BY id').all())
    const workspacesBefore = JSON.stringify(context.db.prepare('SELECT * FROM workspaces').all())
    const settingsBefore = JSON.stringify(context.db.prepare('SELECT * FROM settings ORDER BY key').all())

    const createdResponse = await app.request(`/api/projects/${first.id}/chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'model',
        options: { numCtx: 4096, temperature: 0.25, think: 'off' },
      }),
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json() as {
      id: string
      projectId: string
      workspaceId: string | null
      mode: string
      model: string
      options: { numCtx: number; temperature: number; think: string }
      ownershipVersion: number
    }
    assert.deepEqual(
      {
        projectId: created.projectId,
        workspaceId: created.workspaceId,
        mode: created.mode,
        model: created.model,
        options: created.options,
        ownershipVersion: created.ownershipVersion,
      },
      {
        projectId: first.id,
        workspaceId: null,
        mode: 'chat',
        model: 'model',
        options: { numCtx: 4096, temperature: 0.25, think: 'off' },
        ownershipVersion: 1,
      },
    )
    assert.deepEqual(modelValidationCalls, [['model', 4096]])
    const createdRetention = await (
      await app.request(`/api/threads/${created.id}/retention`)
    ).json() as { policy: unknown; projectId: string }
    assert.deepEqual(
      { policy: createdRetention.policy, projectId: createdRetention.projectId },
      { policy: { mode: 'ttl', expiresAfterDays: 7 }, projectId: first.id },
    )
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count, 2)
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 0)
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 0)

    const firstBody = await (await app.request(`/api/projects/${first.id}/chats`)).json() as {
      project: { id: string }
      chats: Array<{ id: string; projectId: string }>
    }
    assert.equal(firstBody.project.id, first.id)
    assert.deepEqual(firstBody.chats.map(({ id, projectId }) => ({ id, projectId })), [
      { id: created.id, projectId: first.id },
    ])
    assert.deepEqual(
      (await (await app.request(`/api/projects/${second.id}/chats`)).json() as { chats: unknown[] }).chats,
      [],
    )
    const projectless = await app.request('/api/threads?ownershipVersion=1&scope=projectless')
    assert.equal(projectless.status, 200)
    assert.deepEqual(
      (await projectless.json() as { chats: Array<{ id: string; projectId: null }> }).chats.map(
        ({ id, projectId }) => ({ id, projectId }),
      ),
      [{ id: legacy.id, projectId: null }],
    )

    const exactRead = await app.request(`/api/projects/${first.id}/chats/${created.id}`)
    assert.equal(exactRead.status, 200)
    const exactBody = await exactRead.json() as {
      project: { id: string }
      thread: { id: string; projectId: string; workspaceId: null }
      messages: unknown[]
      contextCheckpoints?: unknown[]
    }
    assert.equal('contextCheckpoints' in exactBody, false)
    assert.deepEqual(
      {
        projectId: exactBody.project.id,
        threadId: exactBody.thread.id,
        owner: exactBody.thread.projectId,
        workspaceId: exactBody.thread.workspaceId,
        messages: exactBody.messages,
      },
      { projectId: first.id, threadId: created.id, owner: first.id, workspaceId: null, messages: [] },
    )
    const checkpointRead = await app.request(
      `/api/projects/${first.id}/chats/${created.id}?contextCheckpointVersion=1`,
    )
    assert.equal(checkpointRead.status, 200)
    assert.deepEqual((await checkpointRead.json() as { contextCheckpoints: unknown[] }).contextCheckpoints, [])

    const projectThreads = new ThreadStore(context.db)
    for (let index = 0; index < 6; index += 1) {
      projectThreads.addMessage({
        threadId: created.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `project source ${index}`,
        turnStatus: index % 2 === 0 ? null : 'completed',
      })
    }
    const projectSelection = projectThreads.compactionCandidates(created.id, 4)!
    const projectCheckpoint = projectThreads.createContextCheckpoint({
      threadId: created.id,
      upToSeq: projectSelection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'project checkpoint',
    })
    projectThreads.addMessage({
      threadId: created.id,
      role: 'assistant',
      content: 'post-checkpoint measured tail',
      turnStatus: 'completed',
      usage: {
        promptTokens: 321,
        evalTokens: 8,
        promptEvalDurationMs: 50,
        evalDurationMs: 10,
        loadDurationMs: 0,
        totalDurationMs: 60,
        tokensPerSecond: 800,
        cacheHit: true,
        cachedTokens: 222,
      },
    })
    const measuredProjectRead = await app.request(
      `/api/projects/${first.id}/chats/${created.id}?contextCheckpointVersion=1`,
    )
    assert.equal(measuredProjectRead.status, 200)
    const measuredProjectBody = await measuredProjectRead.json() as {
      messages: unknown[]
      contextCheckpoints: Array<{ id: string }>
      context: { usedTokens: number; cacheHit: boolean; cachedTokens: number }
    }
    assert.equal(measuredProjectBody.messages.length, 7)
    assert.deepEqual(measuredProjectBody.contextCheckpoints.map(({ id }) => id), [projectCheckpoint.id])
    assert.equal(measuredProjectBody.context.usedTokens, 321)
    assert.equal(measuredProjectBody.context.cacheHit, true)
    assert.equal(measuredProjectBody.context.cachedTokens, 222)
    for (const query of [
      'contextCheckpointVersion=2',
      'contextCheckpointVersion=1&future=1',
      'contextCheckpointVersion=1&contextCheckpointVersion=1',
    ]) {
      assert.equal(
        (await app.request(`/api/projects/${first.id}/chats/${created.id}?${query}`)).status,
        400,
      )
    }
    const mismatch = await app.request(`/api/projects/${second.id}/chats/${created.id}`)
    assert.equal(mismatch.status, 409)
    assert.equal((await mismatch.json() as { code: string }).code, 'project_chat_mismatch')

    const rowBefore = JSON.stringify(context.db.prepare('SELECT * FROM threads WHERE id = ?').get(created.id))
    for (const invalid of [
      { model: 'model', projectId: second.id },
      { model: 'model', workspaceId: 'workspace-1' },
      { model: 'model', mode: 'agent' },
      { model: 'model', extra: true },
      { model: 'model', options: { futureField: true } },
    ]) {
      const response = await app.request(`/api/projects/${first.id}/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invalid),
      })
      assert.equal(response.status, 400)
    }
    const countsBeforeInvalidReferences = {
      threads: (context.db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
      messages: (context.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
      jobs: (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
    }
    for (const request of [
      { path: '/api/projects//chats', method: 'POST', status: 404 },
      { path: '/api/projects/%20/chats', method: 'POST', status: 400 },
      { path: `/api/projects/${'p'.repeat(256)}/chats`, method: 'POST', status: 400 },
      { path: `/api/projects/${first.id}/chats/%20`, method: 'GET', status: 400 },
    ]) {
      const response = await app.request(request.path, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: request.method === 'POST' ? JSON.stringify({ model: 'model' }) : undefined,
      })
      assert.equal(response.status, request.status)
    }
    assert.deepEqual(
      {
        threads: (context.db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count,
        messages: (context.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
        jobs: (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      },
      countsBeforeInvalidReferences,
    )
    for (const patch of [{ projectId: second.id }, { workspaceId: 'workspace-1' }]) {
      const rejected = await app.request(`/api/threads/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      assert.equal(rejected.status, 400)
    }
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM threads WHERE id = ?').get(created.id)), rowBefore)
    assert.deepEqual(modelValidationCalls, [['model', 4096]])
    assert.equal(await (await app.request(`/api/threads/${legacy.id}`)).text(), legacyBytes)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM projects ORDER BY id').all()), projectBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM project_filesystem_bindings ORDER BY id').all()), bindingsBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM workspaces').all()), workspacesBefore)
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM settings ORDER BY key').all()), settingsBefore)
    assert.equal(context.governor.snapshot().activeLease, null)
  })

  it('keeps the durable Message and Job lifecycle unchanged for a Project-owned Chat', async (test) => {
    const context = streamingContext(() =>
      (async function* () {
        yield terminalChunk('owned route success')
      })(),
    )
    test.after(() => context.db.close())
    const project = context.projects.create('Owned lifecycle')
    const owned = context.threads.createWithOwnership({
      title: 'Owned lifecycle Chat',
      model: 'qwen',
      projectId: project.id,
      options: { numCtx: 4096, temperature: 0, think: 'off' },
    })
    const app = createApp(context)

    const response = await app.request(`/api/threads/${owned.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'owned hello' }),
    })
    const events = parseSse(await response.text())
    assert.equal(
      (events.find((event) => event['type'] === 'done')?.['data'] as { outcome?: string }).outcome,
      'completed',
    )

    const reloaded = await app.request(`/api/projects/${project.id}/chats/${owned.id}`)
    assert.equal(reloaded.status, 200)
    const body = await reloaded.json() as {
      thread: { id: string; projectId: string }
      messages: Array<{ role: string; content: string; turnStatus: string | null }>
    }
    assert.deepEqual(
      body.messages.map(({ role, content, turnStatus }) => ({ role, content, turnStatus })),
      [
        { role: 'user', content: 'owned hello', turnStatus: null },
        { role: 'assistant', content: 'owned route success', turnStatus: 'completed' },
      ],
    )
    assert.deepEqual(
      { id: body.thread.id, projectId: body.thread.projectId },
      { id: owned.id, projectId: project.id },
    )
    assert.equal(
      (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      1,
    )
    assert.equal(context.threads.getWithOwnership(owned.id)?.projectId, project.id)
  })

  it('reads and mutates strict retention without crossing Chat or runtime boundaries', async (test) => {
    let modelCalls = 0
    let ollamaCalls = 0
    const context = testContext({
      models: () => {
        modelCalls += 1
        throw new Error('retention must not construct ModelService')
      },
      ollama: () => {
        ollamaCalls += 1
        throw new Error('retention must not construct OllamaClient')
      },
    })
    test.after(() => context.db.close())
    const allowedRoot = await mkdtemp(join(tmpdir(), 'alamo-retention-side-effects-'))
    test.after(() => rm(allowedRoot, { recursive: true, force: true }))
    context.workspaces.create(allowedRoot, 'Retention fixture root')
    const projectA = context.projects.create('A')
    const projectB = context.projects.create('B')
    const projectless = context.threads.create({
      title: 'Projectless',
      mode: 'chat',
      model: 'fixture',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    const ownedA = context.threads.createWithOwnership({
      title: 'Owned A', model: 'fixture', projectId: projectA.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    const ownedB = context.threads.createWithOwnership({
      title: 'Owned B', model: 'fixture', projectId: projectB.id,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    const fixtureMessage = context.threads.addMessage({
      threadId: ownedB.id, role: 'assistant', content: 'fixture output',
    })
    context.threads.recordToolRun(ownedB.id, fixtureMessage.id, {
      id: 'retention-route-tool', name: 'fixture', arguments: {}, status: 'ok',
      result: 'fixture result', error: null, durationMs: 1, source: 'builtin',
      parsedFrom: 'native', diff: null,
    })
    context.jobs.createChat({
      threadId: ownedB.id,
      idempotencyScope: `chat:${ownedB.id}:send:v1`,
      idempotencyKey: 'retention-side-effect-fixture',
      requestFingerprint: 'retention-side-effect-fingerprint',
      input: { content: 'fixture input', attachments: [], autoApprove: null },
      derivedTitle: 'fixture input',
    })
    const protectedTables = [
      'projects', 'project_filesystem_bindings', 'workspaces', 'messages', 'tool_runs',
      'jobs', 'job_events', 'chat_job_inputs', 'settings',
    ]
    const snapshotProtectedTables = () => JSON.stringify(Object.fromEntries(
      protectedTables.map((name) => [
        name,
        context.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    ))
    const unrelatedBefore = snapshotProtectedTables()
    const filesystemBefore = await readdir(allowedRoot)
    let jobServiceCalls = 0
    let workspaceCalls = 0
    let executionCalls = 0
    context.jobService = new Proxy(context.jobService, {
      get() {
        jobServiceCalls += 1
        throw new Error('retention must not invoke JobService')
      },
    })
    context.workspaces = new Proxy(context.workspaces, {
      get() {
        workspaceCalls += 1
        throw new Error('retention must not invoke WorkspaceStore/filesystem')
      },
    })
    context.chatExecution = new Proxy(context.chatExecution, {
      get() {
        executionCalls += 1
        throw new Error('retention must not invoke Chat execution')
      },
    })
    const app = createApp(context)

    for (const [chatId, projectId] of [
      [projectless.id, null], [ownedA.id, projectA.id], [ownedB.id, projectB.id],
    ] as const) {
      const response = await app.request(`/api/threads/${chatId}/retention`)
      assert.equal(response.status, 200)
      const body = await response.json() as {
        chatId: string
        projectId: string | null
        policy: unknown
        enforcement: string
      }
      assert.deepEqual(
        { chatId: body.chatId, projectId: body.projectId, policy: body.policy, enforcement: body.enforcement },
        {
          chatId,
          projectId,
          policy: { mode: 'ttl', expiresAfterDays: 7 },
          enforcement: 'rolling_ttl_trash',
        },
      )
    }

    const beforeInvalid = JSON.stringify(context.db.prepare('SELECT * FROM threads ORDER BY id').all())
    for (const body of [
      { retentionVersion: 2, policy: { mode: 'keep' } },
      { retentionVersion: 1, policy: { mode: 'unknown' } },
      { retentionVersion: 1, policy: { mode: 'ttl', expiresAfterDays: 7, future: true } },
      { retentionVersion: 1, policy: { mode: 'keep' }, future: true },
    ]) {
      const response = await app.request(`/api/threads/${projectless.id}/retention`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400)
    }
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM threads ORDER BY id').all()), beforeInvalid)

    const keep = await app.request(`/api/threads/${projectless.id}/retention`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retentionVersion: 1, policy: { mode: 'keep' } }),
    })
    const session = await app.request(`/api/threads/${ownedA.id}/retention`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retentionVersion: 1, policy: { mode: 'session' } }),
    })
    const ttl = await app.request(`/api/threads/${ownedB.id}/retention`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        retentionVersion: 1,
        policy: { mode: 'ttl', expiresAfterDays: 7 },
      }),
    })
    assert.deepEqual((await keep.json() as { policy: unknown }).policy, { mode: 'keep' })
    assert.deepEqual((await session.json() as { policy: unknown }).policy, { mode: 'session' })
    assert.deepEqual(
      (await ttl.json() as { policy: unknown }).policy,
      { mode: 'ttl', expiresAfterDays: 7 },
    )
    assert.equal(snapshotProtectedTables(), unrelatedBefore)
    assert.deepEqual(await readdir(allowedRoot), filesystemBefore)
    assert.equal(context.governor.snapshot().activeLease, null)
    assert.equal(jobServiceCalls, 0)
    assert.equal(workspaceCalls, 0)
    assert.equal(executionCalls, 0)
    assert.equal(modelCalls, 0)
    assert.equal(ollamaCalls, 0)
  })
})
