import { expect, test, type Page } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { expectValue, pickValue } from './fixtures/select.ts'

type FixtureSnapshot = {
  events: string[]
  prewarmCalls: number
  prewarmAborts: number
  prewarmReleases: number
  chatCalls: number
  prewarmBodies: unknown[]
}

async function installFixture(page: Page, enabled = true): Promise<void> {
  await page.addInitScript(
    ({ runtime, settings, initialEnabled }) => {
      const observedAt = '2026-08-03T00:00:00.000Z'
      const threadId = 'thread-prewarm-browser'
      const eventsKey = 'guanxi:p1k:events'
      const settingKey = 'guanxi:p1k:enabled'
      const callsKey = 'guanxi:p1k:calls'
      const abortsKey = 'guanxi:p1k:aborts'
      const releasesKey = 'guanxi:p1k:releases'
      const chatsKey = 'guanxi:p1k:chats'
      const bodiesKey = 'guanxi:p1k:bodies'
      if (sessionStorage.getItem(settingKey) === null) {
        sessionStorage.setItem(settingKey, String(initialEnabled))
      }
      const readNumber = (key: string) => Number(sessionStorage.getItem(key) ?? '0')
      const increment = (key: string) => sessionStorage.setItem(key, String(readNumber(key) + 1))
      const readEvents = () => JSON.parse(sessionStorage.getItem(eventsKey) ?? '[]') as string[]
      const record = (event: string) => {
        const events = readEvents()
        events.push(event)
        sessionStorage.setItem(eventsKey, JSON.stringify(events))
      }
      const readBodies = () => JSON.parse(sessionStorage.getItem(bodiesKey) ?? '[]') as unknown[]
      const json = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      const models = ['model-a:latest', 'model-b:latest', 'model-c:latest'].map(
        (name, index) => ({
          name,
          digest: `sha256:model-${index}`,
          sizeBytes: 1_000_000_000 + index,
          modifiedAt: observedAt,
          family: 'fixture',
          parameterSize: '1B',
          quantization: 'Q4',
          contextLength: 32_768,
          capabilities: ['completion'],
          isCloud: false,
          fit: {
            level: 'green',
            summary: 'Fixture fit',
            contextLength: 8_192,
            modelBytes: 1_000_000_000 + index,
            kvCacheBytes: 100_000_000,
            requiredBytes: 1_100_000_000 + index,
            usableBytes: 12_000_000_000,
            utilization: 0.1,
            basis: 'estimate',
            measured: null,
          },
        }),
      )
      const thread = {
        id: threadId,
        title: 'P1-K prewarm browser',
        mode: 'chat',
        model: 'model-c:latest',
        workspaceId: null,
        options: { numCtx: 8_192, temperature: 0.7, think: 'off' },
        createdAt: observedAt,
        updatedAt: observedAt,
        messageCount: readNumber(chatsKey) > 0 ? 2 : 0,
      }
      const context = {
        usedTokens: 0,
        allocatedTokens: 8_192,
        percent: 0,
        cacheHit: false,
        cachedTokens: 0,
        compactable: false,
        estimatedRepefillMs: 0,
      }
      const messages = [
        {
          id: 'user-prewarm-browser',
          threadId,
          jobId: null,
          role: 'user',
          content: 'Send after prewarm cleanup',
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
          id: 'assistant-prewarm-browser',
          threadId,
          jobId: null,
          role: 'assistant',
          content: 'Prewarm released before Chat dispatch',
          thinking: null,
          toolCalls: [],
          usage: null,
          createdAt: observedAt,
          isCompaction: false,
          turnStatus: 'completed',
          turnError: null,
          stopReason: 'stop',
        },
      ]
      const health = {
        ok: true,
        appVersion: 'test',
        application: { state: 'reachable', source: 'application_http', observedAt },
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

      ;(window as typeof window & {
        __prewarmFixture?: {
          snapshot(): FixtureSnapshot
          setEnabled(value: boolean): void
        }
      }).__prewarmFixture = {
        snapshot: () => ({
          events: readEvents(),
          prewarmCalls: readNumber(callsKey),
          prewarmAborts: readNumber(abortsKey),
          prewarmReleases: readNumber(releasesKey),
          chatCalls: readNumber(chatsKey),
          prewarmBodies: readBodies(),
        }),
        setEnabled: (value) => sessionStorage.setItem(settingKey, String(value)),
      }

      window.fetch = async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const url = new URL(rawUrl, window.location.origin)
        const method = (
          init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET'
        ).toUpperCase()
        if (url.pathname === '/api/health') return json(health)
        if (url.pathname === '/api/runtime') return json(runtime)
        if (url.pathname === '/api/models') return json({ models })
        if (url.pathname === '/api/workspaces') return json({ workspaces: [] })
        if (url.pathname === '/api/settings' && method === 'GET') {
          return json({
            ...settings,
            ollamaHost: health.ollama.host,
            defaultModel: 'model-a:latest',
            defaultNumCtx: 32_768,
            autoApproveTools: false,
            enableBash: false,
            prewarmEnabled: sessionStorage.getItem(settingKey) === 'true',
          })
        }
        if (url.pathname.endsWith('/prewarm') && method === 'POST') {
          increment(callsKey)
          record('prewarm-request')
          const bodies = readBodies()
          bodies.push(JSON.parse(String(init?.body ?? 'null')))
          sessionStorage.setItem(bodiesKey, JSON.stringify(bodies))
          return new Promise<Response>((_resolve, reject) => {
            const release = () => {
              increment(abortsKey)
              record('prewarm-abort')
              increment(releasesKey)
              record('prewarm-release')
              reject(new DOMException('prewarm cleanup', 'AbortError'))
            }
            if (init?.signal?.aborted) release()
            else init?.signal?.addEventListener('abort', release, { once: true })
          })
        }
        if (url.pathname === '/api/threads' && method === 'POST') {
          record('create-thread')
          return json(thread)
        }
        if (url.pathname === '/api/threads' && method === 'GET') {
          return json({
            ownershipVersion: 1,
            scope: 'projectless',
            chats: [{ ...thread, ownershipVersion: 1, projectId: null }],
          })
        }
        if (url.pathname === `/api/threads/${threadId}` && method === 'GET') {
          const terminal = readNumber(chatsKey) > 0
          return json({
            thread: { ...thread, messageCount: terminal ? 2 : 0 },
            messages: terminal ? messages : [],
            context,
          })
        }
        if (url.pathname === `/api/threads/${threadId}/messages` && method === 'POST') {
          increment(chatsKey)
          record('chat-dispatch')
          const start = {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-prewarm-browser',
              model: 'model-c:latest',
              step: 0,
              status: 'pending',
            },
          }
          const done = {
            type: 'done',
            seq: 1,
            data: {
              messageId: 'assistant-prewarm-browser',
              outcome: 'completed',
              stopReason: 'stop',
              terminalStopReason: 'stop',
              steps: 1,
            },
          }
          return new Response(
            `data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(done)}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return json(
          {
            code: 'internal_error',
            message: `Unhandled fixture route: ${method} ${url.pathname}`,
            details: null,
          },
          500,
        )
      }
    },
    { runtime: runtimeBrowserSnapshot(), settings: browserSettings(), initialEnabled: enabled },
  )
}

async function snapshot(page: Page): Promise<FixtureSnapshot> {
  return page.evaluate(() => {
    const fixture = (window as typeof window & {
      __prewarmFixture?: { snapshot(): FixtureSnapshot }
    }).__prewarmFixture
    if (!fixture) throw new Error('Prewarm fixture is unavailable')
    return fixture.snapshot()
  })
}

async function flushPassiveEffects(page: Page): Promise<void> {
  const painted = page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  )
  await page.clock.fastForward(20)
  await painted
}

test('stable exact selection prewarms once, then cleanup precedes one Chat dispatch', async ({
  page,
}) => {
  // Installing alone leaves time advancing during selector actionability waits.
  // Pause before app timers exist so only the steps below count toward debounce.
  await page.clock.install({ time: new Date('2026-08-03T00:00:00.000Z') })
  await page.clock.pauseAt(new Date('2026-08-03T00:00:01.000Z'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await installFixture(page)
  await page.goto('/chat')
  const selector = page.getByRole('combobox', { name: 'Модель для нового диалога' })
  await expectValue(selector, 'model-a:latest')

  await pickValue(page, selector, 'model-b:latest', { clockStepMs: 20 })
  await flushPassiveEffects(page)
  await page.clock.fastForward(400)
  expect((await snapshot(page)).prewarmCalls).toBe(0)
  await pickValue(page, selector, 'model-c:latest', { clockStepMs: 20 })
  await flushPassiveEffects(page)
  expect((await snapshot(page)).prewarmCalls).toBe(0)
  await page.clock.fastForward(600)
  await expect(page.getByText(/Прогреваем точную модель/u)).toBeVisible()
  const afterDebounce = await snapshot(page)
  expect(afterDebounce.prewarmBodies).toEqual([
    {
      operation: 'chat',
      contextLength: 8_192,
      selection: {
        digest: 'sha256:model-2',
        fitLevel: 'green',
        fitBasis: 'estimate',
      },
    },
  ])
  expect(afterDebounce.prewarmCalls).toBe(1)

  const create = page.getByRole('button', { name: 'Создать диалог' })
  await create.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/chat\/thread-prewarm-browser$/u)
  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Send after prewarm cleanup')
  await composer.press('Enter')
  await expect(page.getByText('Prewarm released before Chat dispatch')).toBeVisible()

  const state = await snapshot(page)
  expect(state.prewarmAborts).toBe(1)
  expect(state.prewarmReleases).toBe(1)
  expect(state.chatCalls).toBe(1)
  expect(state.events.indexOf('prewarm-release')).toBeLessThan(
    state.events.indexOf('chat-dispatch'),
  )
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )
})

test('settings-off, hidden document, and navigation cancel before any prewarm command', async ({
  page,
}) => {
  await page.clock.install()
  await installFixture(page, false)
  await page.goto('/chat')
  await page.clock.fastForward(1_200)
  await expect(page.getByText(/выключен в Настройках/u)).toBeVisible()
  expect((await snapshot(page)).prewarmCalls).toBe(0)

  await page.evaluate(() => {
    const fixture = (window as typeof window & {
      __prewarmFixture?: { setEnabled(value: boolean): void }
    }).__prewarmFixture
    fixture?.setEnabled(true)
  })
  await page.reload()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward(1_200)
  expect((await snapshot(page)).prewarmCalls).toBe(0)

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await pickValue(page, page.getByRole('combobox', { name: 'Модель для нового диалога' }), 'model-b:latest')
  await page.getByRole('link', { name: 'Настройки' }).click()
  await expect(page).toHaveURL(/\/settings$/u)
  await page.clock.fastForward(1_200)
  expect((await snapshot(page)).prewarmCalls).toBe(0)
})
