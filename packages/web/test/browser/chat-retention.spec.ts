import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test.use({ timezoneId: 'Pacific/Honolulu' })

test('Chat retention survives reload and contains repeated save, error and narrow zoom states', async ({ page }) => {
  await page.clock.install({ time: new Date('1999-01-01T00:00:00.000Z') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-11T10:00:00.000Z'
  const expiresAt = '2026-08-18T10:00:00.000Z'
  const thread = {
    id: 'chat-retention-browser',
    title: 'R'.repeat(120),
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
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  let policy: 'ttl' | 'keep' = 'ttl'
  let retentionReads = 0
  let retentionPatches = 0
  const patchBodies: unknown[] = []
  const unexpectedMutations: string[] = []

  const retention = () => ({
    retentionVersion: 1,
    chatId: thread.id,
    projectId: null,
    policy: policy === 'ttl' ? { mode: 'ttl', expiresAfterDays: 7 } : { mode: 'keep' },
    policySource: policy === 'ttl' ? 'default' : 'user',
    policyUpdatedAt: observedAt,
    lastUserActivity: { at: observedAt, source: 'chat_created' },
    expiresAt: policy === 'ttl' ? expiresAt : null,
    expirySource: policy === 'ttl' ? 'server_calculated' : 'policy_without_time_expiry',
    enforcement: 'rolling_ttl_trash',
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/workspaces') return route.fulfill(json({ workspaces: [] }))
    if (url.pathname === '/api/threads' && method === 'GET') {
      return route.fulfill(json({
        ownershipVersion: 1,
        scope: 'projectless',
        chats: [{ ...thread, ownershipVersion: 1, projectId: null }],
      }))
    }
    if (url.pathname === `/api/threads/${thread.id}` && method === 'GET') {
      return route.fulfill(json({ thread, messages: [], context }))
    }
    if (url.pathname === `/api/threads/${thread.id}/retention` && method === 'GET') {
      retentionReads += 1
      return route.fulfill(json(retention()))
    }
    if (url.pathname === `/api/threads/${thread.id}/retention` && method === 'PATCH') {
      retentionPatches += 1
      patchBodies.push(request.postDataJSON())
      if (retentionPatches === 1) {
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe retention failure',
          details: null,
        }, 500))
      }
      policy = 'keep'
      return route.fulfill(json(retention()))
    }
    if (method !== 'GET') unexpectedMutations.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto(`/chat/${thread.id}`)
  await page.getByRole('button', { name: 'Информация о чате' }).click()
  const dialog = page.getByRole('dialog', { name: 'Хранение чата' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('7 дней', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('Восстанавливаемое истечение применяется')).toHaveCount(1)
  await expect(dialog.getByText(/Безвозвратное удаление не реализовано/u)).toHaveCount(1)
  await expect(dialog.locator(`time[datetime="${observedAt}"]`)).toHaveCount(1)
  await expect(dialog.locator(`time[datetime="${expiresAt}"]`)).toHaveCount(1)
  await expect(dialog.getByText(thread.title)).toHaveCount(1)
  await page.clock.setFixedTime(new Date('2040-12-31T23:59:59.000Z'))
  await expect(dialog.locator(`time[datetime="${observedAt}"]`)).toHaveCount(1)
  await expect(dialog.locator(`time[datetime="${expiresAt}"]`)).toHaveCount(1)

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const initialLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(initialLayout.documentWidth).toBeLessThanOrEqual(initialLayout.viewport)
  expect(initialLayout.bodyWidth).toBeLessThanOrEqual(initialLayout.viewport)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)

  await dialog.getByRole('radio', { name: 'Хранить' }).check()
  const save = dialog.getByRole('button', { name: 'Сохранить retention' })
  await save.evaluate((button) => {
    const form = button.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => retentionPatches).toBe(1)
  const error = dialog.getByText('safe retention failure')
  await expect(error).toBeVisible()
  await expect(error.locator('xpath=ancestor::*[@role="alert"][1]')).toBeFocused()

  await dialog.getByRole('button', { name: 'Повторить retention' }).press('Enter')
  await expect.poll(() => retentionPatches).toBe(2)
  expect(retentionReads).toBe(1)
  expect(patchBodies).toEqual([
    { retentionVersion: 1, policy: { mode: 'keep' } },
    { retentionVersion: 1, policy: { mode: 'keep' } },
  ])
  await expect(dialog.locator('dd').filter({ hasText: 'Нет временного истечения' })).toHaveCount(1)
  await expect(dialog.locator(`time[datetime="${expiresAt}"]`)).toHaveCount(0)

  await page.getByRole('button', { name: 'Закрыть настройки хранения чата' }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Информация о чате' }).click()
  await expect(page.getByRole('dialog').getByText('Хранить', { exact: true })).toHaveCount(2)
  await expect(page.getByRole('dialog').getByText('Восстанавливаемое истечение применяется')).toHaveCount(1)
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Honolulu')
  await expect(page.getByRole('dialog').locator(`time[datetime="${observedAt}"]`)).toHaveCount(1)
  await expect(page.getByRole('dialog').locator(`time[datetime="${expiresAt}"]`)).toHaveCount(0)
  expect(retentionReads).toBeGreaterThanOrEqual(2)
  expect(unexpectedMutations).toEqual([])
})
