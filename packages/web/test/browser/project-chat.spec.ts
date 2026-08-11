import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Project Chat grouping, create retry and sourced hard reload stay isolated', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-10T10:00:00.000Z'
  const first = {
    id: 'project-chat-first',
    name: `Long Project ${'context-'.repeat(11)}`,
    createdAt: observedAt,
    updatedAt: observedAt,
    filesystemBindings: [],
  }
  const second = {
    id: 'project-chat-second',
    name: 'Second isolated Project',
    createdAt: observedAt,
    updatedAt: observedAt,
    filesystemBindings: [],
  }
  const presentation = (project: typeof first) => ({
    ...project,
    presentationVersion: 1,
    iconKey: 'folder',
    colorToken: 'slate',
  })
  const ownedChat = (id: string, title: string, projectId = first.id) => ({
    id,
    title,
    mode: 'chat',
    model: 'fixture:latest',
    workspaceId: null,
    options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    createdAt: observedAt,
    updatedAt: observedAt,
    messageCount: 0,
    ownershipVersion: 1,
    projectId,
  })
  const older = ownedChat('project-chat-older', 'Older exact Chat')
  const newer = { ...ownedChat('project-chat-newer', 'Newer exact Chat'), updatedAt: '2026-08-10T11:00:00.000Z' }
  const created = ownedChat('project-chat-created', 'Новый диалог')
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
      level: 'green', summary: 'Fixture fit', contextLength: 8192,
      modelBytes: 1_000_000, kvCacheBytes: 100_000, requiredBytes: 1_100_000,
      usableBytes: 12_000_000_000, utilization: 0.01, basis: 'estimate', measured: null,
    },
  }
  const context = {
    usedTokens: 0, allocatedTokens: 8192, percent: 0, cacheHit: false,
    cachedTokens: 0, compactable: false, estimatedRepefillMs: 0,
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  let createCalls = 0
  let createBody: unknown = null
  let mismatch = false
  let workspaceReads = 0
  const unexpectedMutations: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [model] }))
    if (url.pathname === '/api/workspaces') {
      workspaceReads += 1
      return route.fulfill(json({ workspaces: [] }))
    }
    if (url.pathname === '/api/settings') {
      return route.fulfill(json({
        ollamaHost: health.ollama.host,
        defaultModel: model.name,
        defaultNumCtx: 8192,
        autoApproveTools: false,
        enableBash: false,
        prewarmEnabled: false,
        webSearch: { provider: 'none', baseUrl: null, hasApiKey: false },
        theme: 'system',
      }))
    }
    if (url.pathname === '/api/projects' && method === 'GET') {
      return route.fulfill(json({
        presentationVersion: 1,
        projects: [presentation(first), presentation(second)],
      }))
    }
    if (url.pathname === `/api/projects/${first.id}/chats` && method === 'GET') {
      return route.fulfill(json({
        ownershipVersion: 1,
        project: first,
        chats: createCalls >= 2 ? [created, newer, older] : [newer, older],
      }))
    }
    if (url.pathname === `/api/projects/${second.id}/chats` && method === 'GET') {
      return route.fulfill(json({ ownershipVersion: 1, project: second, chats: [] }))
    }
    if (url.pathname === `/api/projects/${first.id}/chats` && method === 'POST') {
      createCalls += 1
      createBody = request.postDataJSON()
      if (createCalls === 1) {
        return route.fulfill(json({ code: 'internal_error', message: 'safe create failure', details: null }, 500))
      }
      return route.fulfill(json(created, 201))
    }
    if (url.pathname === `/api/projects/${first.id}/chats/${created.id}` && method === 'GET') {
      if (mismatch) {
        return route.fulfill(json({
          code: 'project_chat_mismatch',
          message: 'Chat does not belong to this Project',
          details: null,
        }, 409))
      }
      return route.fulfill(json({
        ownershipVersion: 1,
        project: first,
        thread: created,
        messages: [],
        context,
      }))
    }
    if (method !== 'GET') unexpectedMutations.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/projects')
  const cards = page.locator('article')
  await expect(cards).toHaveCount(2)
  const firstCard = cards.filter({ hasText: first.name })
  const secondCard = cards.filter({ hasText: second.name })
  await expect(firstCard.getByRole('listitem')).toHaveCount(2)
  await expect(firstCard.getByRole('listitem').nth(0)).toContainText('Newer exact Chat')
  await expect(firstCard.getByRole('listitem').nth(1)).toContainText('Older exact Chat')
  await expect(secondCard.getByRole('listitem')).toHaveCount(0)
  await expect(secondCard.getByText('В этом проекте пока нет чатов.')).toHaveCount(1)

  const newChat = firstCard.getByRole('link', { name: 'Новый чат' })
  await newChat.focus()
  await newChat.press('Enter')
  await expect(page).toHaveURL(`/projects/${first.id}/chats`)
  const newHeading = page.getByRole('heading', { name: `Новый чат в проекте «${first.name}»` })
  await expect(newHeading).toBeFocused()

  const create = page.getByRole('button', { name: 'Создать диалог' })
  await create.evaluate((button) => {
    const form = button.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => createCalls).toBe(1)
  const createError = page.getByText('safe create failure')
  await expect(createError).toBeVisible()
  await expect(createError.locator('xpath=ancestor::*[@tabindex="-1"]')).toBeFocused()
  await create.press('Enter')
  await expect.poll(() => createCalls).toBe(2)
  expect(createBody).toEqual({
    model: model.name,
    options: { numCtx: 8192, temperature: 0.7, think: 'off' },
  })
  await expect(page).toHaveURL(`/projects/${first.id}/chats/${created.id}`)
  await expect(page.getByText(`Проект: ${first.name}`)).toHaveCount(1)
  await expect(page.getByText(second.name)).toHaveCount(0)

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
  await expect(page).toHaveURL(`/projects/${first.id}/chats/${created.id}`)
  await expect(page.getByText(`Проект: ${first.name}`)).toHaveCount(1)
  mismatch = true
  await page.reload()
  const safeState = page.getByRole('heading', { name: 'Не удалось безопасно открыть чат проекта' })
  await expect(safeState).toBeFocused()
  await expect(page.getByText('Chat does not belong to this Project')).toHaveCount(1)
  expect(createCalls).toBe(2)
  expect(workspaceReads).toBe(0)
  expect(unexpectedMutations).toEqual([])
})
