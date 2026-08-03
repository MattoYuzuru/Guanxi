import type { Page } from '@playwright/test'
import { runtimeBrowserSnapshot } from './runtime-snapshot.ts'

export type ChatFixtureScenario =
  | 'completed'
  | 'connect_timeout'
  | 'runtime_protocol'
  | 'durable_navigation'

export type ChatFixtureAction = 'releaseHeaders' | 'releaseNext'

export interface ChatFixtureSnapshot {
  state: 'new' | 'created' | 'running' | 'terminal'
  detailReads: number
  responsePending: boolean
  streamReady: boolean
  emittedEvents: number
  createBody: unknown
  messageBody: unknown
}

const THREAD_IDS: Record<ChatFixtureScenario, string> = {
  completed: 'thread-p0-e-full',
  connect_timeout: 'thread-p0-e-connect-timeout',
  runtime_protocol: 'thread-p0-e-runtime-protocol',
  durable_navigation: 'thread-p1-d-durable-navigation',
}

export function chatFixtureThreadId(scenario: ChatFixtureScenario): string {
  return THREAD_IDS[scenario]
}

export async function installChatApiFixture(
  page: Page,
  scenario: ChatFixtureScenario,
): Promise<void> {
  await page.addInitScript(
    ({ scenario: fixtureScenario, runtimeSnapshot }) => {
      type StoredState = 'new' | 'created' | 'running' | 'terminal'
      type FixtureControl = {
        releaseHeaders: () => void
        releaseNext: () => void
        snapshot: () => {
          state: StoredState
          detailReads: number
          responsePending: boolean
          streamReady: boolean
          emittedEvents: number
          createBody: unknown
          messageBody: unknown
        }
      }

      const scenarioIds = {
        completed: 'thread-p0-e-full',
        connect_timeout: 'thread-p0-e-connect-timeout',
        runtime_protocol: 'thread-p0-e-runtime-protocol',
        durable_navigation: 'thread-p1-d-durable-navigation',
      } as const
      const scenarioTitles = {
        completed: 'P0-E release gate',
        connect_timeout: 'P0-E connect timeout',
        runtime_protocol: 'P0-E missing terminal',
        durable_navigation: 'P1-D durable navigation',
      } as const
      const scenarioPrompts = {
        completed: 'Run the P0-E release flow',
        connect_timeout: 'Trigger connect timeout',
        runtime_protocol: 'Trigger missing terminal',
        durable_navigation: 'Navigate away during durable generation',
      } as const

      const encoder = new TextEncoder()
      const observedAt = '2026-08-02T12:00:00.000Z'
      const threadId = scenarioIds[fixtureScenario]
      const jobId = '11111111-1111-4111-8111-111111111111'
      const idempotencyKey = '22222222-2222-4222-8222-222222222222'
      const storagePrefix = `alamo:p0e:${fixtureScenario}`
      const stateKey = `${storagePrefix}:state`
      const readsKey = `${storagePrefix}:detailReads`
      const createBodyKey = `${storagePrefix}:createBody`
      const messageBodyKey = `${storagePrefix}:messageBody`

      const readState = (): StoredState => {
        const stored = sessionStorage.getItem(stateKey) as StoredState | null
        if (stored) return stored
        return fixtureScenario === 'completed' ? 'new' : 'created'
      }
      const writeState = (state: StoredState) => sessionStorage.setItem(stateKey, state)
      if (sessionStorage.getItem(stateKey) === null && fixtureScenario !== 'completed') {
        writeState('created')
      }

      const thread = {
        id: threadId,
        title: scenarioTitles[fixtureScenario],
        mode: 'chat',
        model: 'fixture:latest',
        workspaceId: null,
        options: { numCtx: 8192, temperature: 0.7, think: 'off' },
        createdAt: observedAt,
        updatedAt: observedAt,
        messageCount:
          readState() === 'terminal' ||
          (fixtureScenario === 'durable_navigation' && readState() === 'running')
            ? 2
            : 0,
      }
      const emptyContext = {
        usedTokens: 0,
        allocatedTokens: 8192,
        percent: 0,
        cacheHit: false,
        cachedTokens: 0,
        compactable: false,
        estimatedRepefillMs: 0,
      }
      const terminalContext = {
        ...emptyContext,
        usedTokens: 42,
        percent: 0.51,
      }
      const health = {
        ok: true,
        appVersion: 'test',
        application: {
          state: 'reachable',
          source: 'application_http',
          observedAt,
        },
        ollama: {
          installed: true,
          installSource: 'runtime_response',
          running: true,
          state: 'reachable',
          source: 'ollama_api_version',
          observedAt,
          version: 'test',
          host: 'http://127.0.0.1:11434',
          installHint: null,
        },
        hardware: {
          platform: 'darwin',
          arch: 'arm64',
          cpuModel: 'fixture',
          cpuCores: 8,
          totalMemoryBytes: 16_000_000_000,
          usableMemoryBytes: 12_000_000_000,
          accelerator: 'metal',
          acceleratorName: 'fixture',
          unifiedMemory: true,
          freeDiskBytes: 100_000_000_000,
        },
        network: {
          ollamaComReachable: null,
          checkedAt: null,
          status: 'unknown',
          source: 'not_checked',
        },
      }
      const model = {
        name: 'fixture:latest',
        digest: 'sha256:fixture',
        sizeBytes: 1_000_000,
        modifiedAt: observedAt,
        family: 'fixture',
        parameterSize: '1B',
        quantization: 'Q4',
        contextLength: 8192,
        capabilities: ['completion'],
        isCloud: false,
        fit: {
          level: 'green',
          summary: 'Fixture fit',
          contextLength: 8192,
          modelBytes: 1_000_000,
          kvCacheBytes: 100_000,
          requiredBytes: 1_100_000,
          usableBytes: 12_000_000_000,
          utilization: 0.01,
          basis: 'estimate',
          measured: null,
        },
      }
      const running = {
        name: model.name,
        digest: model.digest,
        sizeBytes: model.sizeBytes,
        sizeVramBytes: null,
        gpuPercent: null,
        processorLabel: null,
        contextLength: model.contextLength,
        expiresAt: null,
        source: 'ollama_api_ps',
        observedAt,
      }
      const runtimeState = {
        ...runtimeSnapshot,
        models: [
          {
            ...running,
            normalizedName: model.name,
            ownerState: 'unknown',
            leaseId: null,
            owner: null,
            decisionCode: 'observed_unknown_owner',
            identityBasis: 'runtime_observation_only',
            artifactIdentity: 'unknown',
            currentFit: {
              state: 'unknown',
              basis: 'insufficient_evidence',
              reason: 'runtime_owner_unknown',
              observedAt,
              requestedContext: null,
              observedContext: model.contextLength,
              runtimeAllocationBytes: model.sizeBytes,
              runtimeAcceleratorAllocationBytes: null,
              pressureLevel: 'unknown',
              futureAdmissionGuarantee: false,
            },
          },
        ],
        decisions: [
          {
            code: 'observed_unknown_owner',
            modelName: model.name,
            normalizedModelName: model.name,
            leaseId: null,
            owner: null,
            runtimeDigest: model.digest,
            requestedContext: null,
            observedContext: model.contextLength,
            identityBasis: 'runtime_observation_only',
            artifactIdentity: 'unknown',
          },
        ],
      }
      const terminalAssistant = {
        completed: {
          content: 'Persisted canonical answer',
          thinking: 'Persisted canonical reasoning',
          turnStatus: 'completed',
          turnError: null,
          stopReason: 'stop',
        },
        connect_timeout: {
          content: '',
          thinking: null,
          turnStatus: 'failed',
          turnError: {
            code: 'ollama_connect_timeout',
            message: 'Ollama did not accept the connection before the deadline',
          },
          stopReason: 'provider_error',
        },
        runtime_protocol: {
          content: 'Persisted partial after EOF',
          thinking: null,
          turnStatus: 'failed',
          turnError: {
            code: 'runtime_protocol',
            message: 'Ollama ended the stream without the required terminal chunk',
          },
          stopReason: 'protocol_error',
        },
        durable_navigation: {
          content: 'Persisted answer after navigation',
          thinking: null,
          turnStatus: 'completed',
          turnError: null,
          stopReason: 'stop',
        },
      } as const
      const messages = [
        {
          id: `user-${fixtureScenario}`,
          threadId,
          jobId: fixtureScenario === 'durable_navigation' ? jobId : null,
          role: 'user',
          content: scenarioPrompts[fixtureScenario],
          thinking: null,
          toolCalls: [],
          usage: null,
          createdAt: observedAt,
          isCompaction: false,
          turnStatus: null,
          turnError: null,
          stopReason: null,
        },
        {
          id: `assistant-${fixtureScenario}`,
          threadId,
          jobId: fixtureScenario === 'durable_navigation' ? jobId : null,
          role: 'assistant',
          ...terminalAssistant[fixtureScenario],
          toolCalls: [],
          usage: null,
          createdAt: observedAt,
          isCompaction: false,
        },
      ]
      const pendingMessages = messages.map((message) =>
        message.role === 'assistant'
          ? {
              ...message,
              content: '',
              thinking: null,
              turnStatus: 'pending',
              turnError: null,
              stopReason: null,
            }
          : message,
      )

      const events = {
        completed: [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-completed',
              model: model.name,
              step: 0,
              status: 'pending',
            },
          },
          { type: 'thinking', seq: 1, data: { delta: 'Live reasoning' } },
          { type: 'token', seq: 2, data: { delta: 'Live stream draft' } },
          { type: 'context', seq: 3, data: terminalContext },
          {
            type: 'done',
            seq: 4,
            data: {
              messageId: 'assistant-completed',
              outcome: 'completed',
              stopReason: 'stop',
              terminalStopReason: 'stop',
              steps: 1,
            },
          },
        ],
        connect_timeout: [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-connect_timeout',
              model: model.name,
              step: 0,
              status: 'pending',
            },
          },
          {
            type: 'error',
            seq: 1,
            data: {
              code: 'upstream_error',
              message: 'Ollama did not accept the connection before the deadline',
              details: null,
              turnError: {
                code: 'ollama_connect_timeout',
                message: 'Ollama did not accept the connection before the deadline',
              },
            },
          },
          {
            type: 'done',
            seq: 2,
            data: {
              messageId: 'assistant-connect_timeout',
              outcome: 'failed',
              stopReason: 'error',
              terminalStopReason: 'provider_error',
              steps: 1,
            },
          },
        ],
        runtime_protocol: [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-runtime_protocol',
              model: model.name,
              step: 0,
              status: 'pending',
            },
          },
          { type: 'token', seq: 1, data: { delta: 'Live partial before EOF' } },
          {
            type: 'error',
            seq: 2,
            data: {
              code: 'upstream_error',
              message: 'Ollama ended the stream without the required terminal chunk',
              details: null,
              turnError: {
                code: 'runtime_protocol',
                message: 'Ollama ended the stream without the required terminal chunk',
              },
            },
          },
          {
            type: 'done',
            seq: 3,
            data: {
              messageId: 'assistant-runtime_protocol',
              outcome: 'failed',
              stopReason: 'error',
              terminalStopReason: 'protocol_error',
              steps: 1,
            },
          },
        ],
        durable_navigation: [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-durable_navigation',
              model: model.name,
              step: 0,
              status: 'pending',
              jobId,
            },
          },
          { type: 'token', seq: 1, data: { delta: 'Live partial before navigation' } },
          { type: 'token', seq: 2, data: { delta: ' and after reattach' } },
          {
            type: 'done',
            seq: 3,
            data: {
              messageId: 'assistant-durable_navigation',
              outcome: 'completed',
              stopReason: 'stop',
              terminalStopReason: 'stop',
              steps: 1,
            },
          },
        ],
      } as const

      let responseResolver: ((response: Response) => void) | null = null
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
      let streamMode: 'compatibility' | 'job' | null = null
      let emittedEvents = 0

      const persistTerminal = () => writeState('terminal')
      const jobEvent = (index: number) => {
        const event = events[fixtureScenario][index]
        if (!event) throw new Error('No fixture event remains')
        const sequence = index + 3
        const terminal = event.type === 'done'
        const state = terminal
          ? 'completed'
          : event.type === 'token'
            ? 'generating'
            : 'loading'
        const { seq: _compatibilitySequence, ...output } = event
        return {
          id: `job-event-${sequence}`,
          jobId,
          sequence,
          type: terminal ? 'lifecycle' : 'output',
          state,
          phase: state,
          metadata: { channel: event.type },
          output: {
            privacyClassification: 'private_chat',
            event: output,
          },
          createdAt: observedAt,
        }
      }
      const job = () => ({
        id: jobId,
        kind: 'inference',
        operation: 'chat',
        status: readState() === 'terminal' ? 'completed' : 'generating',
        phase: readState() === 'terminal' ? 'generating' : 'generating',
        idempotencyScope: `chat:${threadId}:send:v1`,
        idempotencyKey,
        createdAt: observedAt,
        startedAt: observedAt,
        finishedAt: readState() === 'terminal' ? observedAt : null,
        error: null,
        outcome:
          readState() === 'terminal'
            ? { code: 'chat_completed', metadata: { messageId: `assistant-${fixtureScenario}` } }
            : null,
        stopReason: readState() === 'terminal' ? 'stop' : null,
        lastEventSequence: Math.max(1, emittedEvents + 2),
      })
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      const parseBody = (body: BodyInit | null | undefined): unknown => {
        if (typeof body !== 'string') return null
        try {
          return JSON.parse(body) as unknown
        } catch {
          return null
        }
      }
      const fixtureControl: FixtureControl = {
        releaseHeaders() {
          if (!responseResolver) throw new Error('No pending message response')
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
              streamMode = 'compatibility'
            },
          })
          const resolve = responseResolver
          responseResolver = null
          resolve(
            new Response(body, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
              },
            }),
          )
        },
        releaseNext() {
          if (!streamController) throw new Error('Message stream is not ready')
          const event = events[fixtureScenario][emittedEvents]
          if (!event) throw new Error('No fixture event remains')
          emittedEvents += 1
          if (event.type === 'done') persistTerminal()
          const payload = streamMode === 'job' ? jobEvent(emittedEvents - 1) : event
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
          if (emittedEvents === events[fixtureScenario].length) {
            streamController.close()
            streamController = null
            streamMode = null
          }
        },
        snapshot() {
          return {
            state: readState(),
            detailReads: Number(sessionStorage.getItem(readsKey) ?? '0'),
            responsePending: responseResolver !== null,
            streamReady: streamController !== null,
            emittedEvents,
            createBody: JSON.parse(sessionStorage.getItem(createBodyKey) ?? 'null') as unknown,
            messageBody: JSON.parse(sessionStorage.getItem(messageBodyKey) ?? 'null') as unknown,
          }
        },
      }
      ;(
        window as typeof window & {
          __alamoP0EFixture?: FixtureControl
        }
      ).__alamoP0EFixture = fixtureControl

      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: () => Promise.resolve(),
      })

      window.fetch = async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : input.url
        const url = new URL(rawUrl, window.location.origin)
        const method =
          (init?.method ??
            (typeof input === 'string' ? undefined : input.method) ??
            'GET').toUpperCase()

        if (url.pathname === '/api/health') return json(health)
        if (url.pathname === '/api/runtime') return json(runtimeState)
        if (url.pathname === '/api/models') return json({ models: [model] })
        if (url.pathname === '/api/workspaces') return json({ workspaces: [] })
        if (url.pathname === '/api/settings') {
          return json({
            ollamaHost: health.ollama.host,
            defaultModel: model.name,
            defaultNumCtx: 32768,
            autoApproveTools: false,
            enableBash: false,
            webSearch: { provider: 'none', baseUrl: null, hasApiKey: false },
            theme: 'system',
          })
        }
        if (url.pathname === '/api/threads' && method === 'POST') {
          sessionStorage.setItem(createBodyKey, JSON.stringify(parseBody(init?.body)))
          writeState('created')
          return json(thread)
        }
        if (url.pathname === '/api/threads' && method === 'GET') {
          const hasMessages =
            readState() === 'terminal' ||
            (fixtureScenario === 'durable_navigation' && readState() === 'running')
          return json({
            threads:
              readState() === 'new'
                ? []
                : [{ ...thread, messageCount: hasMessages ? 2 : 0 }],
          })
        }
        if (url.pathname === `/api/threads/${threadId}` && method === 'GET') {
          const reads = Number(sessionStorage.getItem(readsKey) ?? '0') + 1
          sessionStorage.setItem(readsKey, String(reads))
          const terminal = readState() === 'terminal'
          const durableRunning =
            fixtureScenario === 'durable_navigation' && readState() === 'running'
          return json({
            thread: {
              ...thread,
              messageCount: terminal || durableRunning ? messages.length : 0,
            },
            messages: terminal ? messages : durableRunning ? pendingMessages : [],
            context: terminal ? terminalContext : emptyContext,
          })
        }
        if (url.pathname === `/api/jobs/${jobId}` && method === 'GET') {
          return json({ job: job() })
        }
        if (url.pathname === `/api/jobs/${jobId}/events` && method === 'GET') {
          const requestHeaders = new Headers(
            init?.headers ?? (typeof input === 'string' ? undefined : input.headers),
          )
          const after = Number(requestHeaders.get('Last-Event-ID') ?? '0')
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < emittedEvents; index += 1) {
                const persisted = jobEvent(index)
                if (persisted.sequence <= after) continue
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(persisted)}\n\n`))
              }
              if (readState() === 'terminal') {
                controller.close()
                return
              }
              streamController = controller
              streamMode = 'job'
            },
            cancel() {
              streamController = null
              streamMode = null
            },
          })
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        if (url.pathname === `/api/threads/${threadId}/messages` && method === 'POST') {
          sessionStorage.setItem(messageBodyKey, JSON.stringify(parseBody(init?.body)))
          writeState('running')
          init?.signal?.addEventListener(
            'abort',
            () => {
              try {
                streamController?.error(new DOMException('aborted', 'AbortError'))
              } catch {
                // The stream may already be closed by a terminal fixture event.
              }
              streamController = null
              streamMode = null
            },
            { once: true },
          )
          return new Promise<Response>((resolve) => {
            responseResolver = resolve
          })
        }

        return json(
          {
            code: 'internal_error',
            message: `Unhandled fixture route: ${url.pathname}`,
            details: null,
          },
          500,
        )
      }
    },
    { scenario, runtimeSnapshot: runtimeBrowserSnapshot() },
  )
}

export async function advanceChatFixture(
  page: Page,
  action: ChatFixtureAction,
): Promise<void> {
  await page.waitForFunction(
    (nextAction) => {
      const fixture = (
        window as typeof window & {
          __alamoP0EFixture?: {
            snapshot: () => ChatFixtureSnapshot
          }
        }
      ).__alamoP0EFixture
      if (!fixture) return false
      const snapshot = fixture.snapshot()
      return nextAction === 'releaseHeaders' ? snapshot.responsePending : snapshot.streamReady
    },
    action,
  )
  await page.evaluate((nextAction) => {
    const fixture = (
      window as typeof window & {
        __alamoP0EFixture?: Record<ChatFixtureAction, () => void>
      }
    ).__alamoP0EFixture
    if (!fixture) throw new Error('P0-E fixture is unavailable')
    fixture[nextAction]()
  }, action)
}

export async function readChatFixture(page: Page): Promise<ChatFixtureSnapshot> {
  await page.waitForFunction(
    () =>
      Boolean(
        (
          window as typeof window & {
            __alamoP0EFixture?: unknown
          }
        ).__alamoP0EFixture,
      ),
  )
  return page.evaluate(() => {
    const fixture = (
      window as typeof window & {
        __alamoP0EFixture?: {
          snapshot: () => ChatFixtureSnapshot
        }
      }
    ).__alamoP0EFixture
    if (!fixture) throw new Error('P0-E fixture is unavailable')
    return fixture.snapshot()
  })
}
