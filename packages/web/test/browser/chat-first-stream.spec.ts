import { expect, test } from '@playwright/test'

test('create Chat redirects and survives the first multi-phase stream render', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    const observedAt = '2026-08-02T12:00:00.000Z'
    let created = false
    let streamCompleted = false

    const thread = {
      id: 'thread-p0-a',
      title: 'P0-A regression',
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
    const messages = [
      {
        id: 'user-1',
        threadId: thread.id,
        role: 'user',
        content: 'Run the regression',
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
        content: 'Browser stream complete',
        thinking: 'Inspecting context',
        toolCalls: [],
        usage: null,
        createdAt: observedAt,
        isCompaction: false,
        turnStatus: 'completed',
        turnError: null,
        stopReason: 'stop',
      },
    ]

    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => Promise.resolve(),
    })

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
        created = true
        return json(thread)
      }
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json({ threads: created ? [thread] : [] })
      }
      if (url.pathname === `/api/threads/${thread.id}` && method === 'GET') {
        return json({
          thread: {
            ...thread,
            messageCount: streamCompleted ? messages.length : 0,
          },
          messages: streamCompleted ? messages : [],
          context,
        })
      }
      if (url.pathname === `/api/threads/${thread.id}/messages` && method === 'POST') {
        const events = [
          {
            type: 'start',
            seq: 0,
            data: { messageId: 'assistant-1', model: model.name, step: 0 },
          },
          { type: 'thinking', seq: 1, data: { delta: 'Inspecting context' } },
          { type: 'token', seq: 2, data: { delta: 'Browser stream' } },
          { type: 'token', seq: 3, data: { delta: ' complete' } },
          {
            type: 'context',
            seq: 4,
            data: { ...context, usedTokens: 42, percent: 0.51 },
          },
          {
            type: 'done',
            seq: 5,
            data: {
              messageId: 'assistant-1',
              outcome: 'completed',
              stopReason: 'stop',
              steps: 1,
            },
          },
        ]
        const body = new ReadableStream({
          start(controller) {
            let index = 0
            const emit = () => {
              const event = events[index]
              if (!event) {
                streamCompleted = true
                controller.close()
                return
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              index += 1
              window.setTimeout(emit, 90)
            }
            emit()
          },
        })
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        })
      }

      return new Response(JSON.stringify({ code: 'internal_error', message: url.pathname }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })

  await page.goto('/chat')
  const createButton = page.getByRole('button', { name: 'Создать диалог' })
  await createButton.focus()
  await expect(createButton).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/chat\/thread-p0-a$/)

  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Run the regression')
  await composer.press('Enter')

  await expect(page.getByText('prefill', { exact: true })).toBeVisible()
  const liveMessage = page.locator('article.anim-fade-up')
  await expect(liveMessage).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )
  const animationDurationMs = await liveMessage.evaluate((element) => {
    const duration = getComputedStyle(element).animationDuration
    return duration.endsWith('ms') ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000
  })
  expect(animationDurationMs).toBeLessThanOrEqual(0.011)
  await expect(page.getByText('думает', { exact: true })).toBeVisible()
  await expect(page.getByText('генерация', { exact: true })).toBeVisible()
  await expect(page.getByText('Browser stream complete', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Не удалось показать чат' })).toHaveCount(0)

  expect(pageErrors.filter((message) => /is not a function|destroy/i.test(message))).toEqual([])
})
