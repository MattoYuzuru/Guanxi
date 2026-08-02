import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { TURN_ABORT_REASON } from '../src/agent/loop.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { JobService } from '../src/jobs/service.ts'
import type { ModelService } from '../src/models/service.ts'
import { OllamaClient, OllamaError } from '../src/ollama/client.ts'
import type { OllamaChatChunk, OllamaChatRequest } from '../src/ollama/types.ts'
import { ExclusiveInferenceBridge } from '../src/runtime/exclusive-inference.ts'
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

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

function terminalChunk(content: string): OllamaChatChunk {
  return {
    model: 'fixture',
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

function partialChunk(content: string): OllamaChatChunk {
  return {
    model: 'fixture',
    created_at: '2026-08-02T12:00:00.000Z',
    message: { role: 'assistant', content },
    done: false,
  }
}

function stalledNdjsonResponse(
  signal: AbortSignal | null | undefined,
  firstChunk?: OllamaChatChunk,
  onAbort?: () => void,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(firstChunk)}\n`))
      }
      signal?.addEventListener(
        'abort',
        () => {
          onAbort?.()
          controller.error(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    },
  })
  return new Response(body, { status: 200 })
}

function terminalNdjsonResponse(content: string): Response {
  return new Response(`${JSON.stringify(terminalChunk(content))}\n`, { status: 200 })
}

function testContext(options: {
  client: Partial<OllamaClient>
  models?: Partial<ModelService>
}): AppContext {
  const db = openDb(':memory:')
  const settings = new SettingsStore(db, { ollamaHost: 'http://fixture.invalid' })
  const jobs = new JobStore(db)

  return {
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
    appVersion: 'inference-fixture',
    activeTurns: new Map(),
    inference: new ExclusiveInferenceBridge(),
    ollama: () => options.client as OllamaClient,
    models: () =>
      ({
        supportsTools: async () => false,
        ...options.models,
      }) as ModelService,
  }
}

function createThread(context: AppContext, model: string) {
  return context.threads.create({
    title: model,
    mode: 'chat',
    model,
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
}

function seedMessages(context: AppContext, threadId: string, from: number, to: number): void {
  for (let index = from; index <= to; index += 1) {
    context.threads.addMessage({
      threadId,
      role: 'user',
      content: `original-${index}`,
    })
  }
}

function send(app: ReturnType<typeof createApp>, threadId: string, content = 'hello') {
  return app.request(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

interface HeldCall {
  model: string
  signal: AbortSignal
  release: Deferred
}

function heldTurnClient(options: { partial?: boolean } = {}) {
  const calls: HeldCall[] = []
  let active = 0
  let maxActive = 0

  const client: Partial<OllamaClient> = {
    chatStream(request: OllamaChatRequest, signal?: AbortSignal) {
      const effectiveSignal = signal ?? new AbortController().signal
      return (async function* () {
        const release = deferred()
        calls.push({ model: request.model, signal: effectiveSignal, release })
        active += 1
        maxActive = Math.max(maxActive, active)

        try {
          if (options.partial) yield partialChunk(`partial-${request.model}`)
          if (!effectiveSignal.aborted) {
            await Promise.race([
              release.promise,
              new Promise<void>((resolve) => {
                effectiveSignal.addEventListener('abort', () => resolve(), { once: true })
              }),
            ])
          }
          if (effectiveSignal.aborted) return
          yield terminalChunk(`answer-${request.model}`)
        } finally {
          active -= 1
        }
      })()
    },
  }

  return {
    client,
    calls,
    get active() {
      return active
    },
    get maxActive() {
      return maxActive
    },
  }
}

async function assertTurnCompactionSerialized(sameThread: boolean): Promise<void> {
  const turnRelease = deferred()
  const events: string[] = []
  let active = 0
  let maxActive = 0
  let compactionCalls = 0

  const client: Partial<OllamaClient> = {
    chatStream() {
      return (async function* () {
        active += 1
        maxActive = Math.max(maxActive, active)
        events.push('turn-enter')
        try {
          await turnRelease.promise
          yield terminalChunk('turn complete')
        } finally {
          active -= 1
          events.push('turn-exit')
        }
      })()
    },
    async chat() {
      active += 1
      maxActive = Math.max(maxActive, active)
      compactionCalls += 1
      events.push('compaction-enter')
      active -= 1
      events.push('compaction-exit')
      return terminalChunk('summary')
    },
  }

  const context = testContext({ client })
  try {
    const app = createApp(context)
    const turnThread = createThread(context, 'turn-model')
    const compactThread = sameThread ? turnThread : createThread(context, 'compact-model')
    seedMessages(context, compactThread.id, 0, 6)

    const turnResponse = await send(app, turnThread.id, 'active turn')
    await waitFor(() => events.includes('turn-enter'), 'turn never entered fake Ollama')

    const compactResponsePromise = app.request(`/api/threads/${compactThread.id}/compact`, {
      method: 'POST',
    })
    await waitFor(() => context.inference.waiting === 1, 'compaction never waited for the turn')

    assert.equal(compactionCalls, 0)
    assert.equal(maxActive, 1)

    turnRelease.resolve()
    await turnResponse.text()
    const compactResponse = await compactResponsePromise

    assert.equal(compactResponse.status, 200)
    assert.equal(compactionCalls, 1)
    assert.equal(maxActive, 1)
    assert.ok(events.indexOf('turn-exit') < events.indexOf('compaction-enter'))
    assert.equal(context.inference.active, false)
  } finally {
    context.db.close()
  }
}

describe('exclusive inference routes', () => {
  it('serializes Chat turns across threads and leaves a waiter unpersisted until admission', async () => {
    const probe = heldTurnClient()
    const context = testContext({ client: probe.client })

    try {
      const app = createApp(context)
      const first = createThread(context, 'model-a')
      const second = createThread(context, 'model-b')

      const firstResponse = await send(app, first.id, 'first')
      await waitFor(() => probe.calls.length === 1, 'first turn never entered fake Ollama')

      const secondResponse = await send(app, second.id, 'second')
      await waitFor(() => context.inference.waiting === 1, 'second turn never waited')

      assert.deepEqual(probe.calls.map((call) => call.model), ['model-a'])
      assert.equal(probe.maxActive, 1)
      assert.deepEqual(context.threads.messages(second.id), [])

      probe.calls[0]!.release.resolve()
      const firstEvents = parseSse(await firstResponse.text())
      await waitFor(() => probe.calls.length === 2, 'second turn was not admitted after release')

      assert.deepEqual(probe.calls.map((call) => call.model), ['model-a', 'model-b'])
      assert.equal(probe.maxActive, 1)

      probe.calls[1]!.release.resolve()
      const secondEvents = parseSse(await secondResponse.text())

      assert.equal(
        (firstEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
        'completed',
      )
      assert.equal(
        (secondEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
        'completed',
      )
      assert.equal(context.inference.active, false)
      assert.equal(context.inference.waiting, 0)
    } finally {
      context.db.close()
    }
  })

  it('serializes a turn against compaction in the same thread', async () => {
    await assertTurnCompactionSerialized(true)
  })

  it('serializes a turn against compaction in a different thread', async () => {
    await assertTurnCompactionSerialized(false)
  })

  it('serializes two compactions across threads', async () => {
    const calls: Array<{ model: string; release: Deferred }> = []
    let active = 0
    let maxActive = 0
    const client: Partial<OllamaClient> = {
      async chat(request) {
        const release = deferred()
        calls.push({ model: request.model, release })
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await release.promise
          return terminalChunk(`summary-${request.model}`)
        } finally {
          active -= 1
        }
      },
    }
    const context = testContext({ client })

    try {
      const app = createApp(context)
      const first = createThread(context, 'compact-a')
      const second = createThread(context, 'compact-b')
      seedMessages(context, first.id, 0, 6)
      seedMessages(context, second.id, 0, 6)

      const firstResponsePromise = app.request(`/api/threads/${first.id}/compact`, { method: 'POST' })
      await waitFor(() => calls.length === 1, 'first compaction never entered fake Ollama')
      const secondResponsePromise = app.request(`/api/threads/${second.id}/compact`, { method: 'POST' })
      await waitFor(() => context.inference.waiting === 1, 'second compaction never waited')

      assert.deepEqual(calls.map((call) => call.model), ['compact-a'])
      assert.equal(maxActive, 1)

      calls[0]!.release.resolve()
      assert.equal((await firstResponsePromise).status, 200)
      await waitFor(() => calls.length === 2, 'second compaction was not admitted')

      calls[1]!.release.resolve()
      assert.equal((await secondResponsePromise).status, 200)
      assert.equal(maxActive, 1)
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('serializes explicit model warm/load behind an active turn', async () => {
    const probe = heldTurnClient()
    const warmCalls: Array<{ name: string; signal: AbortSignal | undefined }> = []
    const context = testContext({
      client: probe.client,
      models: {
        async warm(name, _contextLength, signal) {
          warmCalls.push({ name, signal })
          return null
        },
      },
    })

    try {
      const app = createApp(context)
      const thread = createThread(context, 'turn-model')
      const turnResponse = await send(app, thread.id)
      await waitFor(() => probe.calls.length === 1, 'turn never entered fake Ollama')

      const warmResponsePromise = app.request('/api/models/other-model/warm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextLength: 4_096 }),
      })
      await waitFor(() => context.inference.waiting === 1, 'warm request never waited')
      assert.equal(warmCalls.length, 0)

      probe.calls[0]!.release.resolve()
      await turnResponse.text()
      const warmResponse = await warmResponsePromise

      assert.equal(warmResponse.status, 404)
      assert.equal(warmCalls.length, 1)
      assert.equal(warmCalls[0]?.name, 'other-model')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('removes a cancelled waiting turn without cancelling the owner or persisting rows', async () => {
    const probe = heldTurnClient()
    const context = testContext({ client: probe.client })

    try {
      const app = createApp(context)
      const ownerThread = createThread(context, 'owner-model')
      const waitingThread = createThread(context, 'waiting-model')
      const nextThread = createThread(context, 'next-model')

      const ownerResponse = await send(app, ownerThread.id, 'owner')
      await waitFor(() => probe.calls.length === 1, 'owner never entered fake Ollama')
      const waitingResponse = await send(app, waitingThread.id, 'waiter')
      await waitFor(() => context.inference.waiting === 1, 'waiting turn was not queued')

      await waitingResponse.body!.cancel()
      await waitFor(
        () => context.inference.waiting === 0 && !context.activeTurns.has(waitingThread.id),
        'cancelled waiter was not removed',
      )

      assert.equal(probe.calls[0]?.signal.aborted, false)
      assert.equal(context.inference.active, true)
      assert.deepEqual(context.threads.messages(waitingThread.id), [])

      probe.calls[0]!.release.resolve()
      await ownerResponse.text()

      const nextResponse = await send(app, nextThread.id, 'next')
      await waitFor(() => probe.calls.length === 2, 'next turn did not acquire the permit')
      probe.calls[1]!.release.resolve()
      await nextResponse.text()

      assert.equal(context.threads.messages(nextThread.id).at(-1)?.turnStatus, 'completed')
      assert.equal(context.inference.active, false)
      assert.equal(context.inference.waiting, 0)
    } finally {
      context.db.close()
    }
  })

  it('releases connect, load, and stream-idle timed-out owners to a cross-thread waiter', async () => {
    const cases = [
      {
        phase: 'connect',
        errorCode: 'ollama_connect_timeout',
        stopReason: 'provider_error',
      },
      {
        phase: 'load',
        errorCode: 'ollama_load_timeout',
        stopReason: 'provider_error',
      },
      {
        phase: 'stream_idle',
        errorCode: 'ollama_stream_idle_timeout',
        stopReason: 'provider_error',
      },
    ] as const

    for (const timeoutCase of cases) {
      let calls = 0
      let active = 0
      let maxActive = 0
      const client = new OllamaClient({
        host: 'http://fixture.invalid',
        connectTimeoutMs: 20,
        loadTimeoutMs: 20,
        streamIdleTimeoutMs: 20,
        fetch: (_input, init) => {
          calls += 1
          active += 1
          maxActive = Math.max(maxActive, active)

          if (calls > 1) {
            active -= 1
            return Promise.resolve(terminalNdjsonResponse('waiter completed'))
          }

          if (timeoutCase.phase === 'connect') {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  active -= 1
                  reject(new DOMException('Aborted', 'AbortError'))
                },
                { once: true },
              )
            })
          }

          return Promise.resolve(
            stalledNdjsonResponse(
              init?.signal,
              timeoutCase.phase === 'stream_idle' ? partialChunk('timed partial') : undefined,
              () => {
                active -= 1
              },
            ),
          )
        },
      })
      const context = testContext({ client })

      try {
        const app = createApp(context)
        const owner = createThread(context, `${timeoutCase.phase}-owner`)
        const waiter = createThread(context, `${timeoutCase.phase}-waiter`)

        const ownerResponse = await send(app, owner.id, 'owner')
        await waitFor(() => calls === 1, `${timeoutCase.phase} owner never entered`)
        const waiterResponse = await send(app, waiter.id, 'waiter')
        await waitFor(
          () => context.inference.waiting === 1,
          `${timeoutCase.phase} waiter never queued`,
        )

        const ownerEvents = parseSse(await ownerResponse.text())
        const ownerDone = ownerEvents.find((event) => event['type'] === 'done')
        assert.equal(
          (ownerDone?.['data'] as { outcome: string }).outcome,
          'failed',
          timeoutCase.phase,
        )
        await waitFor(() => calls === 2, `${timeoutCase.phase} waiter was not admitted`)
        const waiterEvents = parseSse(await waiterResponse.text())

        assert.equal(
          (waiterEvents.find((event) => event['type'] === 'done')?.['data'] as {
            outcome: string
          }).outcome,
          'completed',
          timeoutCase.phase,
        )
        const persistedOwner = context.threads.messages(owner.id).at(-1)
        assert.equal(persistedOwner?.turnStatus, 'failed')
        assert.equal(persistedOwner?.turnError?.code, timeoutCase.errorCode)
        assert.equal(persistedOwner?.stopReason, timeoutCase.stopReason)
        if (timeoutCase.phase === 'stream_idle') {
          assert.equal(persistedOwner?.content, 'timed partial')
        }
        assert.equal(maxActive, 1)
        assert.equal(context.inference.active, false)
        assert.equal(context.inference.waiting, 0)
      } finally {
        context.db.close()
      }
    }
  })

  it('aborts a cold warm at the load deadline and admits the waiting turn', async () => {
    let modelCalls = 0
    let active = 0
    let maxActive = 0
    const client = new OllamaClient({
      host: 'http://fixture.invalid',
      connectTimeoutMs: 20,
      loadTimeoutMs: 20,
      streamIdleTimeoutMs: 20,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return new Response(JSON.stringify({ version: 'fixture' }), { status: 200 })
        }
        modelCalls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        if (modelCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                active -= 1
                reject(new DOMException('Aborted', 'AbortError'))
              },
              { once: true },
            )
          })
        }
        active -= 1
        return terminalNdjsonResponse('turn after warm')
      },
    })
    const context = testContext({
      client,
      models: {
        async warm(name, contextLength, signal) {
          await client.warm(name, contextLength, '10m', signal)
          return null
        },
      },
    })

    try {
      const app = createApp(context)
      const next = createThread(context, 'next-after-warm')
      const warmResponsePromise = app.request('/api/models/cold-model/warm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextLength: 4_096 }),
      })
      await waitFor(() => modelCalls === 1, 'cold warm never entered fake Ollama')

      const nextResponse = await send(app, next.id, 'wait after warm')
      await waitFor(() => context.inference.waiting === 1, 'turn did not wait for cold warm')

      const warmResponse = await warmResponsePromise
      assert.equal(warmResponse.status, 504)
      assert.equal(
        ((await warmResponse.json()) as { code: string }).code,
        'ollama_load_timeout',
      )
      await waitFor(() => modelCalls === 2, 'turn was not admitted after warm timeout')
      await nextResponse.text()

      assert.equal(context.threads.messages(next.id).at(-1)?.turnStatus, 'completed')
      assert.equal(maxActive, 1)
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('releases a compaction load timeout to the waiting turn', async () => {
    let modelCalls = 0
    const client = new OllamaClient({
      host: 'http://fixture.invalid',
      connectTimeoutMs: 20,
      loadTimeoutMs: 20,
      streamIdleTimeoutMs: 20,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/api/version') {
          return new Response(JSON.stringify({ version: 'fixture' }), { status: 200 })
        }
        modelCalls += 1
        if (modelCalls === 1) return stalledNdjsonResponse(init?.signal)
        return terminalNdjsonResponse('turn after compact timeout')
      },
    })
    const context = testContext({ client })

    try {
      const app = createApp(context)
      const compactThread = createThread(context, 'compact-timeout')
      const nextThread = createThread(context, 'next-after-compact')
      seedMessages(context, compactThread.id, 0, 6)

      const compactResponsePromise = app.request(`/api/threads/${compactThread.id}/compact`, {
        method: 'POST',
      })
      await waitFor(() => modelCalls === 1, 'compaction never entered fake Ollama')
      const nextResponse = await send(app, nextThread.id, 'wait after compaction')
      await waitFor(() => context.inference.waiting === 1, 'turn did not wait for compaction')

      const compactResponse = await compactResponsePromise
      assert.equal(compactResponse.status, 504)
      assert.equal(
        ((await compactResponse.json()) as { code: string }).code,
        'ollama_load_timeout',
      )
      await waitFor(() => modelCalls === 2, 'turn was not admitted after compaction timeout')
      await nextResponse.text()

      assert.equal(context.threads.messages(nextThread.id).at(-1)?.turnStatus, 'completed')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('releases after completed, provider-error, and missing-terminal turns', async () => {
    const cases: Array<{
      name: string
      expected: string
      first(): AsyncGenerator<OllamaChatChunk>
    }> = [
      {
        name: 'completed',
        expected: 'completed',
        first: async function* () {
          yield terminalChunk('completed')
        },
      },
      {
        name: 'provider error',
        expected: 'failed',
        first: async function* () {
          throw new OllamaError('injected provider failure', 502)
        },
      },
      {
        name: 'missing terminal chunk',
        expected: 'failed',
        first: async function* () {
          yield partialChunk('partial without done')
        },
      },
    ]

    for (const failureCase of cases) {
      let call = 0
      const client: Partial<OllamaClient> = {
        chatStream() {
          call += 1
          return call === 1
            ? failureCase.first()
            : (async function* () {
                yield terminalChunk('next completed')
              })()
        },
      }
      const context = testContext({ client })

      try {
        const app = createApp(context)
        const first = createThread(context, `${failureCase.name}-first`)
        const next = createThread(context, `${failureCase.name}-next`)

        const firstEvents = parseSse(await (await send(app, first.id)).text())
        assert.equal(
          (firstEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
          failureCase.expected,
          failureCase.name,
        )
        assert.equal(context.inference.active, false, failureCase.name)

        const nextEvents = parseSse(await (await send(app, next.id)).text())
        assert.equal(
          (nextEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
          'completed',
          failureCase.name,
        )
        assert.equal(context.inference.active, false, failureCase.name)
      } finally {
        context.db.close()
      }
    }
  })

  it('releases after explicit Stop and preserves cancelled terminal truth', async () => {
    const probe = heldTurnClient({ partial: true })
    const context = testContext({ client: probe.client })

    try {
      const app = createApp(context)
      const stoppedThread = createThread(context, 'stopped-model')
      const nextThread = createThread(context, 'next-model')
      const stoppedResponse = await send(app, stoppedThread.id)
      await waitFor(() => probe.calls.length === 1, 'stopped turn never entered fake Ollama')

      const stopResponse = await app.request(`/api/threads/${stoppedThread.id}/stop`, {
        method: 'POST',
      })
      assert.equal(stopResponse.status, 200)
      await stoppedResponse.text()

      const stopped = context.threads.messages(stoppedThread.id).at(-1)
      assert.equal(stopped?.turnStatus, 'cancelled')
      assert.equal(stopped?.stopReason, 'stopped_by_user')
      assert.equal(context.inference.active, false)

      const nextResponse = await send(app, nextThread.id)
      await waitFor(() => probe.calls.length === 2, 'next turn never acquired after Stop')
      probe.calls[1]!.release.resolve()
      await nextResponse.text()

      assert.equal(context.threads.messages(nextThread.id).at(-1)?.turnStatus, 'completed')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('keeps an explicit cancellation authoritative when observed with the idle deadline', async () => {
    let context: AppContext
    let threadId = ''
    const client = new OllamaClient({
      host: 'http://fixture.invalid',
      connectTimeoutMs: 20,
      loadTimeoutMs: 20,
      streamIdleTimeoutMs: 20,
      fetch: async (_input, init) =>
        stalledNdjsonResponse(init?.signal, partialChunk('simultaneous partial'), () => {
          context.activeTurns.get(threadId)?.abort(TURN_ABORT_REASON.explicitStop)
        }),
    })
    context = testContext({ client })

    try {
      const app = createApp(context)
      const thread = createThread(context, 'simultaneous-stop')
      threadId = thread.id
      const events = parseSse(await (await send(app, thread.id)).text())
      const done = events.find((event) => event['type'] === 'done')
      const persisted = context.threads.messages(thread.id).at(-1)

      assert.equal((done?.['data'] as { outcome: string }).outcome, 'cancelled')
      assert.equal(
        (done?.['data'] as { terminalStopReason: string }).terminalStopReason,
        'stopped_by_user',
      )
      assert.equal(persisted?.turnStatus, 'cancelled')
      assert.equal(persisted?.turnError, null)
      assert.equal(persisted?.stopReason, 'stopped_by_user')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('releases after response-body cancellation/client generator return', async () => {
    const probe = heldTurnClient({ partial: true })
    const context = testContext({ client: probe.client })

    try {
      const app = createApp(context)
      const abortedThread = createThread(context, 'aborted-model')
      const nextThread = createThread(context, 'next-model')
      const abortedResponse = await send(app, abortedThread.id)
      const reader = abortedResponse.body!.getReader()
      let observed = ''

      for (let attempt = 0; attempt < 4 && !observed.includes('"type":"token"'); attempt += 1) {
        const chunk = await reader.read()
        if (chunk.done) break
        observed += new TextDecoder().decode(chunk.value)
      }
      assert.match(observed, /"type":"token"/)
      await reader.cancel()

      await waitFor(
        () => !context.inference.active && !context.activeTurns.has(abortedThread.id),
        'connection-aborted turn did not release',
      )

      const aborted = context.threads.messages(abortedThread.id).at(-1)
      assert.equal(aborted?.turnStatus, 'cancelled')
      assert.equal(aborted?.stopReason, 'connection_aborted')

      const nextResponse = await send(app, nextThread.id)
      await waitFor(() => probe.calls.length === 2, 'next turn never acquired after body cancel')
      probe.calls[1]!.release.resolve()
      await nextResponse.text()

      assert.equal(context.threads.messages(nextThread.id).at(-1)?.turnStatus, 'completed')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('releases after injected pre-assistant persistence failure without an ambiguous row', async () => {
    let calls = 0
    const client: Partial<OllamaClient> = {
      chatStream() {
        calls += 1
        return (async function* () {
          yield terminalChunk('completed')
        })()
      },
    }
    const context = testContext({ client })

    try {
      const app = createApp(context)
      const failedThread = createThread(context, 'storage-failure')
      const nextThread = createThread(context, 'next-model')
      const originalAdd = context.threads.addMessage.bind(context.threads)
      let failUserInsert = true
      context.threads.addMessage = (input) => {
        if (failUserInsert && input.role === 'user') {
          failUserInsert = false
          throw new Error('injected user persistence failure')
        }
        return originalAdd(input)
      }

      const failedEvents = parseSse(await (await send(app, failedThread.id)).text())
      assert.equal(failedEvents.at(-1)?.['type'], 'error')
      assert.deepEqual(context.threads.messages(failedThread.id), [])
      assert.equal(calls, 0)
      assert.equal(context.inference.active, false)

      const nextEvents = parseSse(await (await send(app, nextThread.id)).text())
      assert.equal(
        (nextEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
        'completed',
      )
      assert.equal(context.threads.messages(nextThread.id).at(-1)?.turnStatus, 'completed')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('releases when terminal persistence fails and never reports completed', async () => {
    const client: Partial<OllamaClient> = {
      chatStream() {
        return (async function* () {
          yield terminalChunk('would have completed')
        })()
      },
    }
    const context = testContext({ client })

    try {
      const app = createApp(context)
      const failedThread = createThread(context, 'terminal-storage-failure')
      const nextThread = createThread(context, 'next-model')
      const originalTerminalize = context.threads.terminalizeMessage.bind(context.threads)
      context.threads.terminalizeMessage = () => {
        throw new Error('injected terminal persistence failure')
      }

      const failedEvents = parseSse(await (await send(app, failedThread.id)).text())
      assert.equal(
        failedEvents.some(
          (event) =>
            event['type'] === 'done' &&
            (event['data'] as { outcome?: string }).outcome === 'completed',
        ),
        false,
      )
      assert.equal(
        (failedEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
        'failed',
      )
      assert.equal(context.threads.messages(failedThread.id).at(-1)?.turnStatus, 'pending')
      assert.equal(context.inference.active, false)

      context.threads.terminalizeMessage = originalTerminalize
      const nextEvents = parseSse(await (await send(app, nextThread.id)).text())
      assert.equal(
        (nextEvents.find((event) => event['type'] === 'done')?.['data'] as { outcome: string }).outcome,
        'completed',
      )
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })

  it('releases after an injected compaction persistence failure', async () => {
    const client: Partial<OllamaClient> = {
      async chat() {
        return terminalChunk('summary')
      },
    }
    const context = testContext({ client })

    try {
      const app = createApp(context)
      const thread = createThread(context, 'compact-model')
      seedMessages(context, thread.id, 0, 6)
      const originalReplace = context.threads.replaceWithSummary.bind(context.threads)
      let failReplace = true
      context.threads.replaceWithSummary = (...args) => {
        if (failReplace) {
          failReplace = false
          throw new Error('injected compaction persistence failure')
        }
        return originalReplace(...args)
      }

      const failed = await app.request(`/api/threads/${thread.id}/compact`, { method: 'POST' })
      assert.equal(failed.status, 500)
      assert.equal(context.inference.active, false)
      assert.equal(context.threads.messages(thread.id).some((message) => message.isCompaction), false)

      const recovered = await app.request(`/api/threads/${thread.id}/compact`, { method: 'POST' })
      assert.equal(recovered.status, 200)
      assert.equal(context.inference.active, false)
      assert.equal(context.threads.messages(thread.id).filter((message) => message.isCompaction).length, 1)
    } finally {
      context.db.close()
    }
  })

  it('uses persisted seq for repeated compaction and passes ordered history to the next turn', async () => {
    const compactionTranscripts: string[] = []
    const turnRequests: OllamaChatRequest[] = []
    let summaries = 0
    const client: Partial<OllamaClient> = {
      async chat(request) {
        compactionTranscripts.push(request.messages.at(-1)?.content ?? '')
        summaries += 1
        return terminalChunk(`summary-${summaries}`)
      },
      chatStream(request) {
        turnRequests.push(request)
        return (async function* () {
          yield terminalChunk('after compaction')
        })()
      },
    }
    const context = testContext({ client })

    try {
      const app = createApp(context)
      const thread = createThread(context, 'compact-model')
      seedMessages(context, thread.id, 0, 8)

      assert.equal(
        (await app.request(`/api/threads/${thread.id}/compact`, { method: 'POST' })).status,
        200,
      )
      seedMessages(context, thread.id, 9, 14)
      assert.equal(
        (await app.request(`/api/threads/${thread.id}/compact`, { method: 'POST' })).status,
        200,
      )

      assert.match(compactionTranscripts[1] ?? '', /original-10/)
      const rows = context.db
        .prepare(
          'SELECT seq, content, is_compaction FROM messages WHERE thread_id = ? ORDER BY seq',
        )
        .all(thread.id) as Array<{ seq: number; content: string; is_compaction: number }>

      assert.deepEqual(
        rows.map((row) => ({ seq: row.seq, content: row.content, compact: row.is_compaction })),
        [
          {
            seq: 10,
            content: 'Сводка предыдущей части диалога:\n\nsummary-2',
            compact: 1,
          },
          { seq: 11, content: 'original-11', compact: 0 },
          { seq: 12, content: 'original-12', compact: 0 },
          { seq: 13, content: 'original-13', compact: 0 },
          { seq: 14, content: 'original-14', compact: 0 },
        ],
      )
      assert.equal(new Set(rows.map((row) => row.seq)).size, rows.length)

      await (await send(app, thread.id, 'original-15')).text()
      const nextContext = turnRequests[0]?.messages.map((message) => message.content) ?? []
      assert.deepEqual(nextContext.slice(1), [
        'Сводка предыдущей части диалога:\n\nsummary-2',
        'original-11',
        'original-12',
        'original-13',
        'original-14',
        'original-15',
      ])
      assert.equal(context.threads.messages(thread.id).at(-1)?.turnStatus, 'completed')
      assert.equal(context.inference.active, false)
    } finally {
      context.db.close()
    }
  })
})
