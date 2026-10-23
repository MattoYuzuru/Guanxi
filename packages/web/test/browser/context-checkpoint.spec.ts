import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test.use({ viewport: { width: 390, height: 844 } })

test('context checkpoint reconciles a lost POST response exactly and survives hard reload once', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await page.addInitScript(({ runtimeSnapshot, settings }) => {
    const observedAt = '2026-08-14T10:00:00.000Z'
    const threadId = 'thread-p3-m'
    const thread = {
      id: threadId,
      title: 'P3-M preserved history',
      mode: 'chat',
      model: 'fixture:latest',
      workspaceId: null,
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
      createdAt: observedAt,
      updatedAt: observedAt,
      messageCount: 6,
    }
    const messages = Array.from({ length: 6 }, (_, index) => ({
      id: `source-${index}`,
      threadId,
      jobId: null,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Original source ${index}`,
      thinking: null,
      toolCalls: [],
      usage: null,
      createdAt: observedAt,
      isCompaction: false,
      turnStatus: index % 2 === 0 ? null : 'completed',
      turnError: null,
      stopReason: index % 2 === 0 ? null : 'stop',
    }))
    const checkpoint = (checkpointId: string) => ({
      contextCheckpointVersion: 1,
      id: checkpointId,
      threadId,
      previousCheckpointId: null,
      source: { state: 'source_preserved', upToSeq: 1, messageCount: 2 },
      summary: {
        format: 'text_utf8_v1',
        content: 'Visible checkpoint summary',
        byteSize: 26,
        sha256: 'a'.repeat(64),
      },
      createdAt: observedAt,
    })
    const beforeContext = {
      usedTokens: 7_000,
      allocatedTokens: 8_192,
      percent: 85.45,
      cacheHit: false,
      cachedTokens: 0,
      compactable: true,
      estimatedRepefillMs: 41_800,
    }
    const afterContext = {
      ...beforeContext,
      usedTokens: 120,
      percent: 1.47,
      compactable: false,
      estimatedRepefillMs: 720,
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
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
    if (sessionStorage.getItem('p3m:created') === null) {
      sessionStorage.setItem('p3m:created', 'false')
      sessionStorage.setItem('p3m:attempts', '0')
      sessionStorage.removeItem('p3m:checkpoint-id')
    }

    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    })
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(rawUrl, window.location.origin)
      const method = (init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET')
        .toUpperCase()
      const created = sessionStorage.getItem('p3m:created') === 'true'
      const checkpointId = sessionStorage.getItem('p3m:checkpoint-id')

      if (url.pathname === '/api/health') return json(health)
      if (url.pathname === '/api/settings') return json(settings)
      if (url.pathname === '/api/runtime') return json(runtimeSnapshot)
      if (url.pathname === '/api/workspaces') return json({ workspaces: [] })
      if (url.pathname === '/api/threads' && method === 'GET') {
        return json({
          ownershipVersion: 1,
          scope: 'projectless',
          chats: [{ ...thread, ownershipVersion: 1, projectId: null }],
        })
      }
      if (url.pathname === `/api/threads/${threadId}` && method === 'GET') {
        return json({
          thread,
          messages,
          contextCheckpoints: created && checkpointId ? [checkpoint(checkpointId)] : [],
          context: created ? afterContext : beforeContext,
        })
      }
      if (url.pathname === `/api/threads/${threadId}/compact` && method === 'POST') {
        const attempts = Number(sessionStorage.getItem('p3m:attempts') ?? '0') + 1
        sessionStorage.setItem('p3m:attempts', String(attempts))
        const body = JSON.parse(String(init?.body)) as { idempotencyKey: string }
        sessionStorage.setItem('p3m:checkpoint-id', body.idempotencyKey)
        sessionStorage.setItem('p3m:created', 'true')
        throw new TypeError('Failed to fetch after committed checkpoint')
      }
      return json({ code: 'internal_error', message: url.pathname, details: null }, 500)
    }
  }, { runtimeSnapshot: runtimeBrowserSnapshot(), settings: browserSettings() })

  await page.goto('/chat/thread-p3-m')
  await expect(page.getByText('Original source 0', { exact: true })).toHaveCount(1)
  await page.getByText('Контекст и скорость').click()
  await page.getByRole('button', { name: 'Свернуть контекст' }).click()
  await page.getByRole('button', { name: 'Создать checkpoint' }).click()

  const checkpointId = await page.evaluate(() => sessionStorage.getItem('p3m:checkpoint-id'))
  expect(checkpointId).toMatch(/^[0-9a-f-]{36}$/u)
  const marker = page.locator(`[data-context-checkpoint="${checkpointId}"]`)
  await expect(marker).toBeVisible()
  await expect(marker).toBeFocused()
  expect(await page.evaluate(() => sessionStorage.getItem('p3m:attempts'))).toBe('1')
  await expect(marker).toContainText('История сохранена: 2 исходных сообщений')
  await expect(page.getByText('Visible checkpoint summary', { exact: true })).toHaveCount(1)
  for (let index = 0; index < 6; index += 1) {
    await expect(page.getByText(`Original source ${index}`, { exact: true })).toHaveCount(1)
  }

  await page.reload()
  await expect(page.locator(`[data-context-checkpoint="${checkpointId}"]`)).toHaveCount(1)
  await expect(page.getByText('Visible checkpoint summary', { exact: true })).toHaveCount(1)
  for (let index = 0; index < 6; index += 1) {
    await expect(page.getByText(`Original source ${index}`, { exact: true })).toHaveCount(1)
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
  expect(pageErrors).toEqual([])
})
