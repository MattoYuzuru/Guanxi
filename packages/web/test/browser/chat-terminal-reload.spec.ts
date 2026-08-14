import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test.use({ viewport: { width: 360, height: 720 } })

test('failed partial response and stop reason remain truthful after reload', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await page.addInitScript(({ runtimeSnapshot, settings }) => {
    const observedAt = '2026-08-02T12:00:00.000Z'
    const thread = {
      id: 'thread-p0-b',
      title: 'P0-B reload failure',
      mode: 'chat',
      model: 'fixture:latest',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'high' },
      createdAt: observedAt,
      updatedAt: observedAt,
      messageCount: 2,
    }
    const context = {
      usedTokens: 12,
      allocatedTokens: 8192,
      percent: 0.15,
      cacheHit: false,
      cachedTokens: 0,
      compactable: false,
      estimatedRepefillMs: 0,
    }
    const health = {
      ok: true,
      appVersion: 'test',
      ollama: {
        installed: true,
        running: true,
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
      network: { ollamaComReachable: false, checkedAt: observedAt },
    }
    const messages = [
      {
        id: 'user-1',
        threadId: thread.id,
        role: 'user',
        content: 'Explain the failure',
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
        id: 'assistant-1',
        threadId: thread.id,
        role: 'assistant',
        content: 'Partial answer survives',
        thinking: 'Partial thought survives',
        toolCalls: [],
        usage: null,
        createdAt: observedAt,
        isCompaction: false,
        turnStatus: 'failed',
        turnError: {
          code: 'runtime_protocol',
          message: 'Ollama ended the stream without the required terminal chunk',
        },
        stopReason: 'protocol_error',
      },
    ]

    if (sessionStorage.getItem('p0bReloads') === null) {
      sessionStorage.setItem('p0bReloads', '0')
    }

    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input.url
      const url = new URL(rawUrl, window.location.origin)
      const method =
        (init?.method ?? (typeof input === 'string' ? undefined : input.method) ?? 'GET').toUpperCase()
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })

      if (url.pathname === '/api/health') return json(health)
      if (url.pathname === '/api/settings') return json(settings)
      if (url.pathname === '/api/runtime') return json(runtimeSnapshot)
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json({ ownershipVersion: 1, scope: 'projectless', chats: [{ ...thread, ownershipVersion: 1, projectId: null }] })
      }
      if (url.pathname === '/api/workspaces') return json({ workspaces: [] })
      if (url.pathname === `/api/threads/${thread.id}` && method === 'GET') {
        const reloads = Number(sessionStorage.getItem('p0bReloads') ?? '0') + 1
        sessionStorage.setItem('p0bReloads', String(reloads))
        return json({ thread, messages, context })
      }

      return new Response(JSON.stringify({ code: 'internal_error', message: url.pathname }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }, { runtimeSnapshot: runtimeBrowserSnapshot(), settings: browserSettings() })

  await page.goto('/chat/thread-p0-b')
  await expect(page.getByText('Partial answer survives')).toBeVisible()
  await page.getByText('Рассуждение модели').click()
  await expect(page.getByText('Partial thought survives')).toBeVisible()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Генерация завершилась ошибкой')
  await expect(alert).toContainText('Причина остановки: ошибка протокола provider')

  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.focus()
  await expect(composer).toBeFocused()
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )

  await page.reload()
  await expect(page.getByText('Partial answer survives')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('ошибка протокола provider')
  expect(
    await page.evaluate(() => Number(sessionStorage.getItem('p0bReloads') ?? '0')),
  ).toBeGreaterThanOrEqual(2)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
  expect(pageErrors).toEqual([])
})

test('live partial output remains visible when terminal history cannot be reloaded', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.addInitScript(({ runtimeSnapshot, settings }) => {
    const encoder = new TextEncoder()
    const observedAt = '2026-08-02T12:00:00.000Z'
    let turnSent = false
    const thread = {
      id: 'thread-p0-b-live',
      title: 'P0-B live storage failure',
      mode: 'chat',
      model: 'fixture:latest',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'high' },
      createdAt: observedAt,
      updatedAt: observedAt,
      messageCount: 0,
    }
    const context = {
      usedTokens: 0,
      allocatedTokens: 8192,
      percent: 0,
      cacheHit: false,
      cachedTokens: 0,
      compactable: false,
      estimatedRepefillMs: 0,
    }
    const health = {
      ok: true,
      appVersion: 'test',
      ollama: {
        installed: true,
        running: true,
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
      network: { ollamaComReachable: false, checkedAt: observedAt },
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })

    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    })

    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input.url
      const url = new URL(rawUrl, window.location.origin)
      const method =
        (init?.method ?? (typeof input === 'string' ? undefined : input.method) ?? 'GET').toUpperCase()

      if (url.pathname === '/api/health') return json(health)
      if (url.pathname === '/api/settings') return json(settings)
      if (url.pathname === '/api/runtime') return json(runtimeSnapshot)
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json({ ownershipVersion: 1, scope: 'projectless', chats: [{ ...thread, ownershipVersion: 1, projectId: null }] })
      }
      if (url.pathname === '/api/workspaces') return json({ workspaces: [] })
      if (url.pathname === `/api/threads/${thread.id}` && method === 'GET') {
        return !turnSent
          ? json({ thread, messages: [], context })
          : json(
              {
                code: 'internal_error',
                message: 'injected terminal history read failure',
                details: null,
              },
              500,
            )
      }
      if (url.pathname === `/api/threads/${thread.id}/messages` && method === 'POST') {
        turnSent = true
        const events = [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-live',
              model: thread.model,
              step: 0,
              status: 'pending',
            },
          },
          { type: 'thinking', seq: 1, data: { delta: 'Buffered live thought' } },
          { type: 'token', seq: 2, data: { delta: 'Buffered live partial' } },
          {
            type: 'error',
            seq: 3,
            data: {
              code: 'internal_error',
              message: 'The final response state could not be saved',
              details: null,
              turnError: {
                code: 'storage_error',
                message: 'The final response state could not be saved',
              },
            },
          },
          {
            type: 'done',
            seq: 4,
            data: {
              messageId: 'assistant-live',
              outcome: 'failed',
              stopReason: 'error',
              terminalStopReason: 'storage_error',
              steps: 1,
            },
          },
        ]
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              }
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }

      return json({ code: 'internal_error', message: url.pathname, details: null }, 500)
    }
  }, { runtimeSnapshot: runtimeBrowserSnapshot(), settings: browserSettings() })

  await page.goto('/chat/thread-p0-b-live')
  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Trigger terminal storage failure')
  await composer.press('Enter')

  await expect(page.getByText('Buffered live partial')).toBeVisible()
  await expect(page.getByText('Buffered live thought')).toBeVisible()
  await expect(page.getByText('partial output не подтверждён')).toBeVisible()
  await expect(page.getByText('готов', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText(
    'The final response state could not be saved',
  )
  expect(pageErrors).toEqual([])
})

test('explicit Stop reloads the persisted cancelled partial outcome', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.addInitScript(({ runtimeSnapshot, settings }) => {
    const encoder = new TextEncoder()
    const observedAt = '2026-08-02T12:00:00.000Z'
    let stopped = sessionStorage.getItem('p0bStopped') === '1'
    const thread = {
      id: 'thread-p0-b-stop',
      title: 'P0-B explicit Stop',
      mode: 'chat',
      model: 'fixture:latest',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
      createdAt: observedAt,
      updatedAt: observedAt,
      messageCount: 0,
    }
    const context = {
      usedTokens: 0,
      allocatedTokens: 8192,
      percent: 0,
      cacheHit: false,
      cachedTokens: 0,
      compactable: false,
      estimatedRepefillMs: 0,
    }
    const health = {
      ok: true,
      appVersion: 'test',
      ollama: {
        installed: true,
        running: true,
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
      network: { ollamaComReachable: false, checkedAt: observedAt },
    }
    const messages = [
      {
        id: 'user-stop',
        threadId: thread.id,
        role: 'user',
        content: 'Stop this response',
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
        id: 'assistant-stop',
        threadId: thread.id,
        role: 'assistant',
        content: 'Partial before Stop',
        thinking: null,
        toolCalls: [],
        usage: null,
        createdAt: observedAt,
        isCompaction: false,
        turnStatus: 'cancelled',
        turnError: null,
        stopReason: 'stopped_by_user',
      },
    ]
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })

    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    })

    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input.url
      const url = new URL(rawUrl, window.location.origin)
      const method =
        (init?.method ?? (typeof input === 'string' ? undefined : input.method) ?? 'GET').toUpperCase()

      if (url.pathname === '/api/health') return json(health)
      if (url.pathname === '/api/settings') return json(settings)
      if (url.pathname === '/api/runtime') return json(runtimeSnapshot)
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json({ ownershipVersion: 1, scope: 'projectless', chats: [{ ...thread, ownershipVersion: 1, projectId: null }] })
      }
      if (url.pathname === '/api/workspaces') return json({ workspaces: [] })
      if (url.pathname === `/api/threads/${thread.id}` && method === 'GET') {
        return json({
          thread: { ...thread, messageCount: stopped ? messages.length : 0 },
          messages: stopped ? messages : [],
          context,
        })
      }
      if (url.pathname === `/api/threads/${thread.id}/stop` && method === 'POST') {
        stopped = true
        sessionStorage.setItem('p0bStopped', '1')
        return json({ ok: true })
      }
      if (url.pathname === `/api/threads/${thread.id}/messages` && method === 'POST') {
        const events = [
          {
            type: 'start',
            seq: 0,
            data: {
              messageId: 'assistant-stop',
              model: thread.model,
              step: 0,
              status: 'pending',
            },
          },
          { type: 'token', seq: 1, data: { delta: 'Partial before Stop' } },
        ]
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              }
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              )
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }

      return json({ code: 'internal_error', message: url.pathname, details: null }, 500)
    }
  }, { runtimeSnapshot: runtimeBrowserSnapshot(), settings: browserSettings() })

  await page.goto('/chat/thread-p0-b-stop')
  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Stop this response')
  await composer.press('Enter')
  await expect(page.getByText('Partial before Stop')).toBeVisible()

  const stopButton = page.getByRole('button', { name: /Остановить/ })
  await stopButton.focus()
  await expect(stopButton).toBeFocused()
  await stopButton.click()

  await expect(page.getByText('Генерация отменена')).toBeVisible()
  await expect(page.getByText(/Причина остановки: явная остановка/)).toBeVisible()
  await page.reload()
  await expect(page.getByText('Partial before Stop')).toBeVisible()
  await expect(page.getByText('Генерация отменена')).toBeVisible()
  expect(pageErrors).toEqual([])
})
