import type { Page } from '@playwright/test'

export type ChatFixtureScenario =
  | 'completed'
  | 'connect_timeout'
  | 'runtime_protocol'
  | 'navigation_abort'

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
  navigation_abort: 'thread-p0-e-navigation-abort',
}

export function chatFixtureThreadId(scenario: ChatFixtureScenario): string {
  return THREAD_IDS[scenario]
}

export async function installChatApiFixture(
  page: Page,
  scenario: ChatFixtureScenario,
): Promise<void> {
  await page.addInitScript(
    ({ scenario: fixtureScenario }) => {
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
        navigation_abort: 'thread-p0-e-navigation-abort',
      } as const
      const scenarioTitles = {
        completed: 'P0-E release gate',
        connect_timeout: 'P0-E connect timeout',
        runtime_protocol: 'P0-E missing terminal',
        navigation_abort: 'P0-E navigation abort',
      } as const
      const scenarioPrompts = {
        completed: 'Run the P0-E release flow',
        connect_timeout: 'Trigger connect timeout',
        runtime_protocol: 'Trigger missing terminal',
        navigation_abort: 'Navigate away during generation',
      } as const

      const encoder = new TextEncoder()
      const observedAt = '2026-08-02T12:00:00.000Z'
      const threadId = scenarioIds[fixtureScenario]
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
        messageCount: readState() === 'terminal' ? 2 : 0,
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
        navigation_abort: {
          content: 'Persisted partial before navigation',
          thinking: null,
          turnStatus: 'cancelled',
          turnError: null,
          stopReason: 'connection_aborted',
        },
      } as const
      const messages = [
        {
          id: `user-${fixtureScenario}`,
          threadId,
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
          role: 'assistant',
          ...terminalAssistant[fixtureScenario],
          toolCalls: [],
          usage: null,
          createdAt: observedAt,
          isCompaction: false,
        },
      ]

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
        navigation_abort: [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-navigation_abort',
              model: model.name,
              step: 0,
              status: 'pending',
            },
          },
          { type: 'token', seq: 1, data: { delta: 'Live partial before navigation' } },
        ],
      } as const

      let responseResolver: ((response: Response) => void) | null = null
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
      let emittedEvents = 0

      const persistTerminal = () => writeState('terminal')
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
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          if (
            emittedEvents === events[fixtureScenario].length &&
            fixtureScenario !== 'navigation_abort'
          ) {
            streamController.close()
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
        if (url.pathname === '/api/models/running') {
          return json({ models: [running], observedAt })
        }
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
          return json({
            threads:
              readState() === 'new'
                ? []
                : [{ ...thread, messageCount: readState() === 'terminal' ? 2 : 0 }],
          })
        }
        if (url.pathname === `/api/threads/${threadId}` && method === 'GET') {
          const reads = Number(sessionStorage.getItem(readsKey) ?? '0') + 1
          sessionStorage.setItem(readsKey, String(reads))
          const terminal = readState() === 'terminal'
          return json({
            thread: { ...thread, messageCount: terminal ? messages.length : 0 },
            messages: terminal ? messages : [],
            context: terminal ? terminalContext : emptyContext,
          })
        }
        if (url.pathname === `/api/threads/${threadId}/messages` && method === 'POST') {
          sessionStorage.setItem(messageBodyKey, JSON.stringify(parseBody(init?.body)))
          writeState('running')
          init?.signal?.addEventListener(
            'abort',
            () => {
              if (fixtureScenario === 'navigation_abort') persistTerminal()
              try {
                streamController?.error(new DOMException('aborted', 'AbortError'))
              } catch {
                // The stream may already be closed by a terminal fixture event.
              }
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
    { scenario },
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
