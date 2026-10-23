import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('scoped Trash restores once, repeats from Restore, recovers by itself and survives hard reload at narrow forced-color zoom', async ({ page }) => {
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
    hardDeletion: {
      state: 'scheduled_after_recovery',
      eligibleAt: recoveryDeadline,
      source: 'server_maintenance',
      blobGc: 'not_applicable',
    },
  }
  const sessionElapsed = {
    ...sessionAvailable,
    chatId: 'session-trash-elapsed',
    title: 'Session recovery elapsed',
    recovery: { ...sessionAvailable.recovery, state: 'grace_elapsed' },
    hardDeletion: { ...sessionAvailable.hardDeletion, state: 'pending_maintenance' },
  }
  const committedDeletion = {
    deletionVersion: 1,
    chatId: sessionElapsed.chatId,
    scope: 'projectless',
    projectId: null,
    state: 'deleted',
    reason: 'session_recovery_elapsed',
    tombstonedAt: sessionElapsed.tombstonedAt,
    recoveryDeadline,
    deletedAt: '2026-08-12T12:00:00.001Z',
    source: 'server_maintenance',
    boundary: 'thread_owned_sqlite_metadata',
    blobGc: 'not_applicable',
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
  let deletionRefreshArmed = false
  let deletionRefreshFailures = 0
  let deletionCommitted = false
  let restoreCalls = 0
  const restoreBodies: unknown[] = []
  const trashScopes: Array<{ scope: string | null; projectId: string | null; limit: string | null }> = []
  const unexpectedMutations: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
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
      expect(url.searchParams.get('deletionVersion')).toBe('1')
      if (scope === 'projectless') {
        // A background failure surfaces after three consecutive quiet reads (P2, useAsync).
        if (deletionRefreshArmed && deletionRefreshFailures < 3) {
          deletionRefreshFailures += 1
          return route.fulfill(json({
            code: 'storage_error', message: 'safe deletion refresh failure', details: null,
          }, 500))
        }
        if (deletionRefreshFailures >= 3) deletionCommitted = true
        return route.fulfill(json({
          lifecycleVersion: 1, deletionVersion: 1, scope, projectId: null,
          chats: deletionCommitted
            ? [projectlessItem, sessionAvailable]
            : [projectlessItem, sessionAvailable, sessionElapsed],
          hasMore: false,
          deletions: deletionCommitted ? [committedDeletion] : [],
          deletionsHaveMore: false,
        }))
      }
      expect(projectId).toBe(project.id)
      return route.fulfill(json({
        lifecycleVersion: 1, deletionVersion: 1, scope, projectId,
        chats: restored ? [] : [trashItem], hasMore: false,
        deletions: [], deletionsHaveMore: false,
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
  await expect(projectlessTrash.getByText(/24 часа восстановления истекли/u)).toHaveCount(1)
  await expect(projectlessTrash.getByText(/удаление metadata ожидает server maintenance/u)).toHaveCount(1)
  await expect(projectlessTrash.getByText(/generic blob cleanup неприменим/u)).toHaveCount(2)
  await expect(projectlessTrash.getByRole('button', { name: 'Восстановить чат' })).toHaveCount(3)
  await expect(projectlessTrash.getByRole('button', { name: 'Восстановить чат' }).last()).toBeDisabled()

  // D-203: no Refresh deletion status button; a pending deletion is watched quietly.
  await expect(projectlessTrash.getByRole('button', { name: /^(Обновить|Повторить)/u })).toHaveCount(0)
  await expect(projectlessTrash.getByText(/результат появится здесь сам/u)).toHaveCount(1)
  const sampleControl = projectlessTrash.getByRole('button', { name: 'Восстановить чат' }).first()
  await sampleControl.focus()
  const adaptiveStyles = await sampleControl.evaluate((button) => {
    const buttonStyle = getComputedStyle(button)
    return {
      transitionProperty: buttonStyle.transitionProperty,
      transitionDuration: buttonStyle.transitionDuration,
      relevantAnimationCount: button.getAnimations({ subtree: true }).length,
      outlineWidth: buttonStyle.outlineWidth,
      outlineStyle: buttonStyle.outlineStyle,
    }
  })
  const itemStyles = await projectlessTrash.locator('.chat-trash-item')
    .filter({ hasText: sessionElapsed.title })
    .evaluate((item) => ({
      borderStyle: getComputedStyle(item).borderStyle,
      borderWidth: getComputedStyle(item).borderWidth,
    }))
  expect(adaptiveStyles.transitionProperty).toBe('none')
  expect(adaptiveStyles.transitionDuration.split(',').every((value) => Number.parseFloat(value) === 0)).toBe(true)
  expect(adaptiveStyles.relevantAnimationCount).toBe(0)
  expect(adaptiveStyles.outlineWidth).toBe('3px')
  expect(adaptiveStyles.outlineStyle).toBe('solid')
  expect(itemStyles.borderStyle).toBe('solid')
  expect(itemStyles.borderWidth).not.toBe('0px')

  deletionRefreshArmed = true
  // Regaining focus re-reads the Trash quietly; these reads fail (armed above). One failed read
  // shows nothing; the third consecutive one is announced.
  for (let read = 1; read <= 3; read++) {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => deletionRefreshFailures).toBe(read)
    if (read === 1) await expect(projectlessTrash.getByText('Не удалось сохранить запрос в локальное хранилище.')).toHaveCount(0)
  }
  const deletionFailure = projectlessTrash.getByText('Не удалось сохранить запрос в локальное хранилище.')
  await expect(deletionFailure).toBeVisible()
  await expect(deletionFailure.locator('xpath=ancestor::*[@tabindex="-1"]')).toBeFocused()
  await expect(projectlessTrash.getByText(sessionElapsed.title)).toHaveCount(1)
  await expect(projectlessTrash.getByText(/Server maintenance удалил metadata чат-сессии/u)).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(projectlessTrash.getByText(sessionElapsed.title)).toHaveCount(0)
  await expect(projectlessTrash.getByText(/Server maintenance удалил metadata чат-сессии/u)).toHaveCount(1)
  await expect(projectlessTrash.getByRole('heading', { name: 'Корзина' })).toBeFocused()

  const restore = projectTrash.getByRole('button', { name: 'Восстановить чат' })
  await restore.press('Enter')
  await expect.poll(() => restoreCalls).toBe(1)
  const error = projectTrash.getByText('Не удалось сохранить запрос в локальное хранилище.')
  await expect(error).toBeVisible()
  await expect(error.locator('xpath=ancestor::*[@tabindex="-1"]')).toBeFocused()
  // The failed restore keeps its own Restore button; no separate Retry.
  await expect(projectTrash.getByRole('button', { name: /^Повторить/u })).toHaveCount(0)
  await restore.press('Enter')
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
