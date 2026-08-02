import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 360, height: 720 } })

test('failed partial response and stop reason remain truthful after reload', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await page.addInitScript(() => {
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
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json({ threads: [thread] })
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
  })

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
