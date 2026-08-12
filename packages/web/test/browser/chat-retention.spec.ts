import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test.use({ timezoneId: 'Pacific/Honolulu' })

test('Chat retention survives reload and contains repeated save, error and narrow zoom states', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
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
  let reasoningLists = 0
  let reasoningReads = 0
  let reasoningExpired = false
  const reasoningContent = 'reasoning only'
  const artifactId = '22222222-2222-4222-8222-222222222222'
  const jobId = '11111111-1111-4111-8111-111111111111'
  const artifact = {
    artifactVersion: 1,
    id: artifactId,
    type: 'reasoning',
    mediaType: 'text/markdown; charset=utf-8',
    storageKind: 'sqlite_text',
    byteSize: 14,
    checksum: `sha256:${'a'.repeat(64)}`,
    createdAt: observedAt,
    source: { chatId: thread.id, messageId: 'message-1', jobId },
    ownership: { scope: 'projectless', projectId: null },
    retention: {
      basis: 'diagnostic_7_days',
      expiresAfterDays: 7,
      artifactExpiresAt: expiresAt,
      parentMode: 'ttl',
      parentExpiresAt: expiresAt,
      effectiveExpiresAt: expiresAt,
      relationship: 'shorter_parent_retention_wins',
      automaticDeletion: 'server_maintenance_active',
    },
  }

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
    if (url.pathname === `/api/threads/${thread.id}/reasoning-artifacts` && method === 'GET') {
      reasoningLists += 1
      expect(Object.fromEntries(url.searchParams)).toEqual({
        artifactVersion: '1',
        enforcementVersion: '1',
        scope: 'projectless',
      })
      return route.fulfill(json({
        artifactVersion: 1,
        enforcementVersion: 1,
        enforcement: {
          state: 'active',
          owner: 'server_maintenance',
          boundary: 'reasoning_artifacts_only',
          inclusiveDueBoundary: true,
        },
        chatId: thread.id,
        scope: 'projectless',
        projectId: null,
        generatedAnswers: [{ messageId: 'message-1', jobId, createdAt: observedAt, byteSize: 12 }],
        artifacts: reasoningExpired ? [] : [artifact],
      }))
    }
    if (url.pathname === `/api/threads/${thread.id}/reasoning-artifacts/${artifactId}` && method === 'GET') {
      reasoningReads += 1
      return route.fulfill(json({ ...artifact, content: reasoningContent }))
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
  await expect(dialog.getByText(/Metadata сессии удаляется после 24-часового срока восстановления/u)).toHaveCount(1)
  await expect(dialog.getByText('Сгенерированные ответы', { exact: true })).toHaveCount(1)
  await expect(dialog.getByText('Результаты с рассуждениями', { exact: true })).toHaveCount(1)
  await expect(dialog.getByText(/Автоматическое удаление применяется/u)).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Копировать рассуждение' })).toHaveCount(1)
  await expect(dialog.locator(`time[datetime="${expiresAt}"]`)).toHaveCount(2)
  await expect(dialog.locator(`time[datetime="${observedAt}"]`)).toHaveCount(2)
  await expect(dialog.getByText(thread.title)).toHaveCount(1)
  await page.clock.setFixedTime(new Date('2040-12-31T23:59:59.000Z'))
  await expect(dialog.locator(`time[datetime="${observedAt}"]`)).toHaveCount(2)
  await expect(dialog.locator(`time[datetime="${expiresAt}"]`)).toHaveCount(2)

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

  await dialog.getByRole('button', { name: 'Копировать рассуждение' }).press('Enter')
  await expect.poll(() => reasoningReads).toBe(1)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(reasoningContent)

  reasoningExpired = true
  await dialog.getByRole('button', { name: 'Обновить рассуждения' }).press('Enter')
  await expect(dialog.getByText('В этом Chat нет сохранённых рассуждений.')).toHaveCount(1)
  await expect(dialog.getByText('Сгенерированные ответы', { exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Копировать рассуждение' })).toHaveCount(0)

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
  await expect(page.getByRole('dialog').locator(`time[datetime="${observedAt}"]`)).toHaveCount(2)
  await expect(page.getByRole('dialog').locator(`time[datetime="${expiresAt}"]`)).toHaveCount(0)
  await expect(page.getByRole('dialog').getByText('В этом Chat нет сохранённых рассуждений.')).toHaveCount(1)
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Копировать рассуждение' })).toHaveCount(0)
  expect(reasoningLists).toBeGreaterThanOrEqual(2)
  expect(reasoningReads).toBe(1)
  expect(retentionReads).toBeGreaterThanOrEqual(2)
  expect(unexpectedMutations).toEqual([])
})

test('explicit Session leave confirms, retries exact scope and records pending Maintenance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-12T10:00:00.000Z'
  const thread = {
    id: 'chat-session-leave-browser',
    title: 'Explicit Session leave',
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
  let leaveCalls = 0
  const leaveBodies: unknown[] = []
  const unexpectedMutations: string[] = []

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
      return route.fulfill(json({
        retentionVersion: 1,
        chatId: thread.id,
        projectId: null,
        policy: { mode: 'session' },
        policySource: 'user',
        policyUpdatedAt: observedAt,
        lastUserActivity: { at: observedAt, source: 'chat_created' },
        expiresAt: null,
        expirySource: 'policy_without_time_expiry',
        enforcement: 'rolling_ttl_trash',
        sessionLeave: null,
      }))
    }
    if (url.pathname === `/api/threads/${thread.id}/reasoning-artifacts` && method === 'GET') {
      return route.fulfill(json({
        artifactVersion: 1,
        enforcementVersion: 1,
        enforcement: {
          state: 'active',
          owner: 'server_maintenance',
          boundary: 'reasoning_artifacts_only',
          inclusiveDueBoundary: true,
        },
        chatId: thread.id,
        scope: 'projectless',
        projectId: null,
        generatedAnswers: [],
        artifacts: [],
      }))
    }
    if (url.pathname === `/api/threads/${thread.id}/session-leave` && method === 'POST') {
      leaveCalls += 1
      leaveBodies.push(request.postDataJSON())
      if (leaveCalls === 1) {
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe Session leave failure',
          details: null,
        }, 500))
      }
      return route.fulfill(json({
        leaveVersion: 1,
        chatId: thread.id,
        projectId: null,
        state: 'pending_maintenance',
        leaveBasis: { at: observedAt, source: 'explicit_user_action' },
        activeJobCount: 0,
        recoveryDeadline: null,
        hardDeletion: 'session_metadata_after_recovery',
      }))
    }
    if (method !== 'GET') unexpectedMutations.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto(`/chat/${thread.id}`)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Информация о чате' })).toBeVisible()
  await page.evaluate(async (chatId) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    const controller = new AbortController()
    const pending = fetch(`/api/threads/${chatId}/retention`, { signal: controller.signal })
      .catch(() => undefined)
    controller.abort()
    await pending
  }, thread.id)
  await page.goto('/projects')
  await page.goto(`/chat/${thread.id}`)
  expect(leaveCalls).toBe(0)
  await page.getByRole('button', { name: 'Информация о чате' }).press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Хранение чата' })
  const leave = dialog.getByRole('button', { name: 'Завершить сессию' })
  await expect(leave).toHaveCount(1)
  await leave.press('Enter')
  const confirm = dialog.getByRole('button', { name: 'Подтвердить выход' })
  await expect(confirm).toBeFocused()
  await expect(dialog.getByText(/Перезагрузка, переподключение и закрытие вкладки этого не делают/u)).toHaveCount(1)
  await confirm.press('Escape')
  await expect(dialog.getByRole('button', { name: 'Завершить сессию' })).toBeFocused()
  expect(leaveCalls).toBe(0)

  await dialog.getByRole('button', { name: 'Завершить сессию' }).press('Enter')
  await dialog.getByRole('button', { name: 'Подтвердить выход' }).press('Enter')
  await expect.poll(() => leaveCalls).toBe(1)
  const error = dialog.getByText('safe Session leave failure')
  await expect(error).toBeVisible()
  await expect(error.locator('xpath=ancestor::*[@role="alert"][1]')).toBeFocused()
  await dialog.getByRole('button', { name: 'Повторить retention' }).press('Enter')
  await expect.poll(() => leaveCalls).toBe(2)
  expect(leaveBodies).toEqual([
    { leaveVersion: 1, chatId: thread.id, scope: 'projectless' },
    { leaveVersion: 1, chatId: thread.id, scope: 'projectless' },
  ])
  await expect(dialog.getByText('Выход зафиксирован; ожидается Maintenance')).toHaveCount(1)
  await expect(dialog.getByRole('status')).toBeFocused()
  await expect(dialog.getByText(
    'Удаление metadata сессии запланировано после 24-часового срока восстановления.',
    { exact: true },
  )).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Завершить сессию' })).toHaveCount(0)

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
  expect(unexpectedMutations).toEqual([])
})
