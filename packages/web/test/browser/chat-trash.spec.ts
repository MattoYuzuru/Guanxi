import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('scoped Trash restores once with retry and survives hard reload at narrow forced-color zoom', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-11T12:00:00.000Z'
  const activityAt = '2026-08-03T12:00:00.000Z'
  const project = {
    id: 'trash-project', name: 'Trash Project', createdAt: observedAt, updatedAt: observedAt,
    filesystemBindings: [], presentationVersion: 1, iconKey: 'folder', colorToken: 'slate',
  }
  const legacyProject = {
    id: project.id, name: project.name, createdAt: project.createdAt,
    updatedAt: project.updatedAt, filesystemBindings: [],
  }
  const activeChat = {
    id: 'trash-owned-chat', title: 'T'.repeat(120), mode: 'chat', model: 'fixture:latest',
    workspaceId: null, options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    createdAt: activityAt, updatedAt: activityAt, messageCount: 3,
    ownershipVersion: 1, projectId: project.id,
  }
  const trashItem = {
    lifecycleVersion: 1, chatId: activeChat.id, title: activeChat.title,
    projectId: project.id, state: 'trash', reason: 'ttl_expired',
    tombstonedAt: observedAt,
    activityBasis: { at: activityAt, source: 'user_message' },
    source: 'server_maintenance', hardDeletion: 'not_implemented',
  }
  const projectlessItem = {
    ...trashItem, chatId: 'trash-projectless', title: 'Projectless isolated Trash', projectId: null,
  }
  const recoveryDeadline = '2026-08-12T12:00:00.000Z'
  const sessionAvailable = {
    ...projectlessItem,
    chatId: 'session-trash-available',
    title: 'Session recovery available',
    reason: 'session_left',
    activityBasis: { at: activityAt, source: 'session_leave' },
    recovery: {
      deadline: recoveryDeadline,
      state: 'available',
      source: 'server_calculated_24_hours',
    },
  }
  const sessionElapsed = {
    ...sessionAvailable,
    chatId: 'session-trash-elapsed',
    title: 'Session recovery elapsed',
    recovery: { ...sessionAvailable.recovery, state: 'grace_elapsed' },
  }
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true, state: 'reachable',
      source: 'ollama_api_version', observedAt, version: 'test',
      host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null,
    },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  let restored = false
  let restoreCalls = 0
  const restoreBodies: unknown[] = []
  const trashScopes: Array<{ scope: string | null; projectId: string | null; limit: string | null }> = []
  const unexpectedMutations: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/projects' && method === 'GET') {
      return route.fulfill(json({ presentationVersion: 1, projects: [project] }))
    }
    if (url.pathname === `/api/projects/${project.id}/chats` && method === 'GET') {
      return route.fulfill(json({
        ownershipVersion: 1,
        project: legacyProject,
        chats: restored ? [activeChat] : [],
      }))
    }
    if (url.pathname === '/api/threads/trash' && method === 'GET') {
      const scope = url.searchParams.get('scope')
      const projectId = url.searchParams.get('projectId')
      trashScopes.push({ scope, projectId, limit: url.searchParams.get('limit') })
      expect(url.searchParams.get('lifecycleVersion')).toBe('1')
      if (scope === 'projectless') {
        return route.fulfill(json({
          lifecycleVersion: 1, scope, projectId: null,
          chats: [projectlessItem, sessionAvailable, sessionElapsed], hasMore: false,
        }))
      }
      expect(projectId).toBe(project.id)
      return route.fulfill(json({
        lifecycleVersion: 1, scope, projectId,
        chats: restored ? [] : [trashItem], hasMore: false,
      }))
    }
    if (url.pathname === `/api/threads/${activeChat.id}/restore` && method === 'POST') {
      restoreCalls += 1
      restoreBodies.push(request.postDataJSON())
      if (restoreCalls === 1) {
        return route.fulfill(json({
          code: 'storage_error', message: 'safe Restore failure', details: null,
        }, 500))
      }
      restored = true
      return route.fulfill(json({
        lifecycleVersion: 1, chatId: activeChat.id, projectId: project.id,
        state: 'active', restored: true, restoredAt: observedAt,
        activityBasis: { at: observedAt, source: 'chat_restored' },
        source: 'user_restore', hardDeletion: 'not_implemented',
      }))
    }
    if (method !== 'GET') unexpectedMutations.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/projects')
  const projectCard = page.locator('article').filter({ hasText: project.name })
  const projectTrash = projectCard.getByRole('region', { name: 'Корзина' })
  const projectlessTrash = page
    .getByRole('region', { name: 'Корзина' })
    .filter({ hasText: projectlessItem.title })
  await expect(projectTrash.getByText(activeChat.title)).toHaveCount(1)
  await expect(projectTrash.getByText('истёк срок хранения 7 дней', { exact: false })).toHaveCount(1)
  await expect(projectTrash.locator(`time[datetime="${observedAt}"]`)).toHaveCount(1)
  await expect(projectTrash.locator(`time[datetime="${activityAt}"]`)).toHaveCount(1)
  await expect(projectlessTrash.getByText(projectlessItem.title)).toHaveCount(1)
  await expect(projectTrash.getByText(projectlessItem.title)).toHaveCount(0)
  await expect(projectlessTrash.getByText('Session recovery available')).toHaveCount(1)
  await expect(projectlessTrash.getByText('пользователь явно завершил сессию')).toHaveCount(2)
  await expect(projectlessTrash.locator(`time[datetime="${recoveryDeadline}"]`)).toHaveCount(2)
  await expect(projectlessTrash.getByText('восстановление доступно')).toHaveCount(1)
  await expect(projectlessTrash.getByText(/24 часа истекли/u)).toHaveCount(1)
  await expect(projectlessTrash.getByRole('button', { name: 'Восстановить чат' })).toHaveCount(3)
  await expect(projectlessTrash.getByRole('button', { name: 'Восстановить чат' }).last()).toBeDisabled()

  const restore = projectTrash.getByRole('button', { name: 'Восстановить чат' })
  await restore.press('Enter')
  await expect.poll(() => restoreCalls).toBe(1)
  const error = projectTrash.getByText('safe Restore failure')
  await expect(error).toBeVisible()
  await expect(error.locator('xpath=ancestor::*[@tabindex="-1"]')).toBeFocused()
  await projectTrash.getByRole('button', { name: 'Повторить восстановление' }).press('Enter')
  await expect.poll(() => restoreCalls).toBe(2)
  expect(restoreBodies).toEqual([{ lifecycleVersion: 1 }, { lifecycleVersion: 1 }])
  await expect(projectCard.getByRole('link', { name: /T{20}/u })).toHaveCount(1)
  await expect(projectTrash.getByText('В этой области Корзина пуста.')).toHaveCount(1)
  await expect(projectlessTrash.getByText(projectlessItem.title)).toHaveCount(1)

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

  await page.reload()
  await expect(page.locator('article').filter({ hasText: project.name }).getByRole('link', { name: /T{20}/u })).toHaveCount(1)
  await expect(page.locator('article').filter({ hasText: project.name }).getByText('В этой области Корзина пуста.')).toHaveCount(1)
  expect(trashScopes.filter(({ scope }) => scope === 'projectless').every(({ projectId, limit }) => projectId === null && limit === '20')).toBe(true)
  expect(trashScopes.filter(({ scope }) => scope === 'project').every(({ projectId, limit }) => projectId === project.id && limit === '20')).toBe(true)
  expect(unexpectedMutations).toEqual([])
})
