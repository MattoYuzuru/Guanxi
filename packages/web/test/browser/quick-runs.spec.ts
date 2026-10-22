import { expect, test } from '@playwright/test'
import { installFrameOrderSwitch, setFramesBeforePendingCommits } from './fixtures/frame-order.ts'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Quick Run metadata stays scoped, truthful, keyboard-safe and constrained-layout safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installFrameOrderSwitch(page)
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-13T10:00:00.000Z'
  const project = {
    id: 'project-browser',
    name: 'Exact Browser Project',
    createdAt: observedAt,
    updatedAt: observedAt,
    filesystemBindings: [],
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
    network: {
      ollamaComReachable: null,
      checkedAt: null,
      status: 'unknown',
      source: 'not_checked',
    },
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  const run = (
    id: string,
    projectId: string | null,
    operation: 'complete' | 'ocr',
    policy: 'ttl' | 'session' = 'ttl',
  ) => ({
    quickRunVersion: 1,
    id,
    operation,
    scope: projectId === null ? 'projectless' : 'project',
    projectId,
    createdAt: observedAt,
    updatedAt: observedAt,
    retention: {
      retentionVersion: 1,
      policy: policy === 'ttl' ? { mode: 'ttl', expiresAfterDays: 7 } : { mode: policy },
      policySource: policy === 'ttl' ? 'default' : 'user',
      policyUpdatedAt: observedAt,
      expiryCalculation: 'not_implemented',
      automaticCleanup: 'not_implemented',
      sessionEnforcement: 'not_implemented',
    },
    execution: { state: 'not_implemented', jobId: null, artifactCount: 0 },
  })

  const projectlessId = '11111111-1111-4111-8111-111111111111'
  const ownedId = '22222222-2222-4222-8222-222222222222'
  let projectless: ReturnType<typeof run>[] = []
  const owned = [run(ownedId, project.id, 'ocr')]
  // Every projectless list request fails until the test presses Retry.
  let failProjectlessList = true
  let createCalls = 0
  const createBodies: unknown[] = []
  let patchCalls = 0
  const patchBodies: unknown[] = []
  const listQueries: Array<Record<string, string>> = []
  const forbiddenEffects: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/projects' && method === 'GET') {
      return route.fulfill(json({ projects: [project] }))
    }
    if (url.pathname === '/api/quick-runs' && method === 'GET') {
      listQueries.push(Object.fromEntries(url.searchParams))
      if (failProjectlessList && url.searchParams.get('scope') === 'projectless') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe Quick Run browser failure',
          details: null,
        }, 500))
      }
      const projectId = url.searchParams.get('projectId')
      const scope = url.searchParams.get('scope')
      return route.fulfill(json({
        quickRunVersion: 1,
        scope,
        projectId: scope === 'project' ? projectId : null,
        quickRuns: scope === 'project' ? owned : projectless,
      }))
    }
    if (url.pathname === '/api/quick-runs' && method === 'POST') {
      createCalls += 1
      createBodies.push(request.postDataJSON())
      const body = request.postDataJSON() as { scope: string; projectId?: string; operation: 'complete' }
      const created = run(
        projectlessId,
        body.scope === 'project' ? body.projectId! : null,
        body.operation,
      )
      if (body.scope === 'projectless') projectless = [created]
      return route.fulfill(json(created, 201))
    }
    if (url.pathname === `/api/quick-runs/${projectlessId}/retention` && method === 'PATCH') {
      patchCalls += 1
      patchBodies.push(request.postDataJSON())
      if (patchCalls === 1) {
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe Quick Run retention failure',
          details: null,
        }, 500))
      }
      projectless = [run(projectlessId, null, 'complete', 'session')]
      return route.fulfill(json(projectless[0]))
    }
    if (
      method !== 'GET' ||
      /models|jobs|threads|workspaces|artifacts|tools|unload|providers/u.test(url.pathname)
    ) forbiddenEffects.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/quick-runs')
  await expect(page.getByRole('status', { name: 'Загружаем Quick Run' })).toBeVisible()
  const loadError = page.getByRole('heading', { name: 'Не удалось загрузить Quick Run' })
  await expect(loadError).toBeFocused()
  await expect(page.getByText('Не удалось сохранить запрос в локальное хранилище.')).toHaveCount(1)
  // The development entrypoint uses React StrictMode, so the first load effect is aborted
  // and replaced once; whether the aborted request reaches the route depends on timing.
  const projectlessQueries = () => listQueries.filter(({ scope }) => scope === 'projectless')
  const initialProjectlessQueries = projectlessQueries().length
  expect([1, 2]).toContain(initialProjectlessQueries)
  failProjectlessList = false
  const retry = page.getByRole('button', { name: 'Повторить', exact: true })
  await retry.focus()
  await retry.press('Enter')
  await expect(page.getByText('В этой области нет Quick Run')).toHaveCount(1)
  await expect(page.getByText('Quick Run: 0')).toHaveCount(1)
  await expect(page.getByText('Метаданные готовы, выполнение — нет')).toHaveCount(1)

  const create = page.getByRole('button', { name: 'Создать метаданные' })
  await create.focus()
  await create.evaluate((button) => {
    const form = button.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => createCalls).toBe(1)
  expect(createBodies).toEqual([{
    quickRunVersion: 1,
    operation: 'complete',
    scope: 'projectless',
  }])
  await expect(page.getByText('Quick Run: 1')).toHaveCount(1)
  await expect(page.getByText(projectlessId)).toHaveCount(1)
  await expect(page.getByText('Выполнение не реализовано')).toHaveCount(1)
  await expect(page.getByText('Не реализовано', { exact: true })).toHaveCount(3)
  await expect(page.getByRole('main').getByRole('button', { name: /сохранить|save|запустить|execute/iu })).toHaveCount(0)
  await expect(create).toBeFocused()

  const session = page.getByRole('button', { name: 'Сессия' })
  // The failure must take focus only after React commits it, even when a frame runs first.
  await setFramesBeforePendingCommits(page, true)
  await session.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => patchCalls).toBe(1)
  const retentionError = page.getByText('Не удалось сохранить запрос в локальное хранилище.').locator('..')
  await expect(retentionError).toBeFocused()
  await setFramesBeforePendingCommits(page, false)
  await page.getByRole('button', { name: 'Повторить изменение retention' }).press('Enter')
  await expect.poll(() => patchCalls).toBe(2)
  expect(patchBodies).toEqual([
    {
      quickRunVersion: 1,
      retentionVersion: 1,
      scope: 'projectless',
      policy: { mode: 'session' },
    },
    {
      quickRunVersion: 1,
      retentionVersion: 1,
      scope: 'projectless',
      policy: { mode: 'session' },
    },
  ])
  await expect(page.getByText('Выбор пользователя')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Сессия' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Не реализовано', { exact: true })).toHaveCount(3)

  await page.getByRole('combobox', { name: 'Область' }).selectOption(project.id)
  await expect(page.getByText('Quick Run: 1')).toHaveCount(1)
  await expect(page.getByText(ownedId)).toHaveCount(1)
  await expect(page.getByText(projectlessId)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: project.name })).toHaveCount(1)
  // Retry issued exactly one projectless request, and nothing after it re-read that scope.
  expect(projectlessQueries()).toEqual(Array.from(
    { length: initialProjectlessQueries + 1 },
    () => ({ quickRunVersion: '1', scope: 'projectless' }),
  ))
  const projectQueries = listQueries.filter(({ scope }) => scope === 'project')
  expect(projectQueries.length).toBeGreaterThan(0)
  expect(projectQueries.every((query) => JSON.stringify(query) === JSON.stringify({
    quickRunVersion: '1',
    scope: 'project',
    projectId: project.id,
  }))).toBe(true)

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const sessionButton = page.getByRole('button', { name: 'Сессия' })
  await sessionButton.focus()
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    transitionProperty: getComputedStyle(document.activeElement!).transitionProperty,
    transitionDuration: getComputedStyle(document.activeElement!).transitionDuration,
    relevantAnimationCount: document.activeElement!.getAnimations({ subtree: true }).length,
    outlineStyle: getComputedStyle(document.activeElement!).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement!).outlineWidth,
    cardBorderStyle: getComputedStyle(document.querySelector('.quick-run-card')!).borderStyle,
    cardBorderWidth: getComputedStyle(document.querySelector('.quick-run-card')!).borderWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.reducedMotion).toBe(true)
  expect(layout.forcedColors).toBe(true)
  expect(layout.transitionProperty).toBe('none')
  expect(layout.transitionDuration.split(',').every((value) => Number.parseFloat(value) === 0)).toBe(true)
  expect(layout.relevantAnimationCount).toBe(0)
  expect(layout.outlineStyle).toBe('solid')
  expect(layout.outlineWidth).toBe('3px')
  expect(layout.cardBorderStyle).toBe('solid')
  expect(layout.cardBorderWidth).not.toBe('0px')

  expect(forbiddenEffects).toEqual([])
})
