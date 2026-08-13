import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Recipe revisions stay scoped, conflict-safe, truthful and constrained-layout safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-13T12:00:00.000Z'
  const id = '11111111-1111-4111-8111-111111111111'
  const ownedId = '22222222-2222-4222-8222-222222222222'
  const jobId = '33333333-3333-4333-8333-333333333333'
  const project = { id: 'project-browser', name: 'Exact Recipe Project', createdAt: observedAt, updatedAt: observedAt, filesystemBindings: [] }
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: { installed: true, installSource: 'runtime_response', running: true, state: 'reachable', source: 'ollama_api_version', observedAt, version: 'test', host: 'http://127.0.0.1:11434', installHint: null },
    hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8, totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000, accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const configuration = (revision: number) => ({
    recipeRevisionVersion: 1,
    operation: revision === 1 ? 'complete' : 'ocr',
    model: { state: 'none', reason: 'not_selected' },
    instructions: revision === 1 ? 'Browser instructions' : 'Newer server instructions',
    defaultParameters: { temperature: 0.2 },
    retention: { mode: 'ttl', expiresAfterDays: 7 },
  })
  const recipe = (recipeId: string, projectId: string | null, revision: number, name = 'Browser Recipe') => ({
    recipeVersion: 1,
    id: recipeId,
    name,
    scope: projectId === null ? 'projectless' : 'project',
    projectId,
    createdAt: observedAt,
    updatedAt: observedAt,
    currentRevision: {
      recipeRevisionVersion: 1,
      recipeId,
      revision,
      configuration: configuration(revision),
      canonical: { format: 'canonical_json_v1', byteSize: 180 + revision, sha256: (revision === 1 ? 'a' : 'b').repeat(64) },
      createdAt: observedAt,
    },
    advancedRouting: 'not_implemented',
    execution: 'not_implemented',
    jobSnapshot: 'queued_snapshot_only',
  })
  const snapshotProjection = (idempotencyKey: string) => ({
    created: true,
    job: {
      id: jobId,
      kind: 'inference',
      operation: 'complete',
      status: 'queued',
      phase: null,
      idempotencyScope: 'recipe_job_snapshot:v1',
      idempotencyKey,
      createdAt: observedAt,
      startedAt: null,
      finishedAt: null,
      error: null,
      outcome: null,
      stopReason: null,
      lastEventSequence: 1,
    },
    snapshot: {
      recipeJobSnapshotVersion: 1,
      jobId,
      jobKind: 'inference',
      recipeId: id,
      recipeRevision: 1,
      scope: 'projectless',
      projectId: null,
      operation: 'complete',
      model: { state: 'none', reason: 'not_selected' },
      configuration: configuration(1),
      canonical: { format: 'canonical_json_v1', byteSize: 181, sha256: 'a'.repeat(64) },
      createdAt: observedAt,
      execution: 'not_implemented',
    },
    eventsUrl: `/api/jobs/${jobId}/events`,
  })

  let projectless: ReturnType<typeof recipe>[] = []
  const owned = [recipe(ownedId, project.id, 1, 'Owned Browser Recipe')]
  let listFailures = 2
  let currentRevision = 1
  let createCalls = 0
  let reviseCalls = 0
  let snapshotFailures = 1
  let snapshotCalls = 0
  let snapshotReads = 0
  const createBodies: unknown[] = []
  const reviseBodies: unknown[] = []
  const snapshotBodies: unknown[] = []
  const listQueries: Array<Record<string, string>> = []
  const forbiddenEffects: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/projects' && method === 'GET') return route.fulfill(json({ projects: [project] }))
    if (url.pathname === '/api/recipes' && method === 'GET') {
      listQueries.push(Object.fromEntries(url.searchParams))
      if (listFailures > 0 && url.searchParams.get('scope') === 'projectless') {
        listFailures -= 1
        await new Promise((resolve) => setTimeout(resolve, 120))
        return route.fulfill(json({ code: 'storage_error', message: 'safe Recipe browser failure', details: null }, 500))
      }
      if (currentRevision === 2 && url.searchParams.get('scope') === 'projectless') projectless = [recipe(id, null, 2)]
      const projectScope = url.searchParams.get('scope') === 'project'
      return route.fulfill(json({
        recipeVersion: 1,
        scope: projectScope ? 'project' : 'projectless',
        projectId: projectScope ? url.searchParams.get('projectId') : null,
        recipes: projectScope ? owned : projectless,
      }))
    }
    if (url.pathname === '/api/recipes' && method === 'POST') {
      createCalls += 1
      createBodies.push(request.postDataJSON())
      projectless = [recipe(id, null, 1)]
      return route.fulfill(json(projectless[0], 201))
    }
    if (url.pathname === `/api/recipes/${id}/revisions` && method === 'POST') {
      reviseCalls += 1
      reviseBodies.push(request.postDataJSON())
      currentRevision = 2
      return route.fulfill(json({
        code: 'recipe_revision_conflict',
        message: 'Recipe changed since this revision was opened',
        details: { expectedRevision: 1, currentRevision: 2 },
      }, 409))
    }
    if (url.pathname === `/api/recipes/${id}/revisions/1/jobs` && method === 'POST') {
      snapshotCalls += 1
      const body = request.postDataJSON() as { idempotencyKey: string }
      snapshotBodies.push(body)
      if (snapshotFailures > 0) {
        snapshotFailures -= 1
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe Recipe snapshot browser failure',
          details: null,
        }, 500))
      }
      return route.fulfill(json(snapshotProjection(body.idempotencyKey), 202))
    }
    if (url.pathname === `/api/recipes/${id}/revisions/1/jobs/${jobId}` && method === 'GET') {
      snapshotReads += 1
      const key = (snapshotBodies[0] as { idempotencyKey: string }).idempotencyKey
      const { created: _created, ...projection } = snapshotProjection(key)
      return route.fulfill(json(projection))
    }
    if (
      method !== 'GET' ||
      /models|jobs|threads|quick-runs|workspaces|artifacts|tools|unload|providers/u.test(url.pathname)
    ) forbiddenEffects.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/recipes')
  await expect(page.getByRole('status', { name: 'Загружаем сценарии' })).toBeVisible()
  const loadError = page.getByRole('heading', { name: 'Не удалось загрузить сценарии' })
  await expect(loadError).toBeFocused()
  await expect(page.getByText('safe Recipe browser failure')).toHaveCount(1)
  await page.getByRole('button', { name: 'Повторить', exact: true }).press('Enter')
  await expect(page.getByText('В этой области нет сценариев')).toHaveCount(1)
  await expect(page.getByText('Основа снимка в очереди; выполнение не подключено')).toHaveCount(1)

  await page.getByRole('textbox', { name: 'Название сценария' }).fill('Browser Recipe')
  await page.getByRole('textbox', { name: 'Инструкции' }).fill('Browser instructions')
  const create = page.getByRole('button', { name: 'Создать сценарий' })
  await create.focus()
  await create.evaluate((button) => {
    const form = button.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => createCalls).toBe(1)
  expect(createBodies).toEqual([{
    recipeVersion: 1,
    name: 'Browser Recipe',
    scope: 'projectless',
    configuration: {
      recipeRevisionVersion: 1,
      operation: 'complete',
      model: { state: 'none', reason: 'not_selected' },
      instructions: 'Browser instructions',
      defaultParameters: {},
      retention: { mode: 'ttl', expiresAfterDays: 7 },
    },
  }])
  await expect(page.getByText(id)).toHaveCount(1)
  await expect(page.getByText('Ревизия 1')).toHaveCount(1)
  await expect(page.getByText(/sha256:aaaa/u)).toHaveCount(1)
  await expect(page.getByText('Расширенная маршрутизация и выполнение адаптера не реализованы. Созданная Job остаётся в очереди.')).toHaveCount(1)
  await expect(page.getByRole('main').getByRole('button', { name: /запустить|run|execute/iu })).toHaveCount(0)
  await expect(create).toBeFocused()

  await page.getByRole('button', { name: 'Подготовить снимок Job в очереди' }).press('Enter')
  const confirmSnapshot = page.getByRole('button', { name: 'Создать снимок Job в очереди' })
  await confirmSnapshot.evaluate((button) => {
    button.click()
    button.click()
  })
  await expect.poll(() => snapshotCalls).toBe(1)
  const snapshotError = page.getByRole('alert').filter({ hasText: 'safe Recipe snapshot browser failure' })
  await expect(snapshotError).toBeFocused()
  await page.getByRole('button', { name: 'Повторить тот же запрос Job' }).press('Enter')
  await expect.poll(() => snapshotCalls).toBe(2)
  expect(snapshotBodies[0]).toEqual(snapshotBodies[1])
  expect(snapshotBodies[0]).toMatchObject({
    recipeJobSnapshotVersion: 1,
    scope: 'projectless',
  })
  const snapshotResult = page.getByRole('heading', { name: 'Снимок Job сохранён в очереди' })
  await expect(snapshotResult).toBeFocused()
  await expect(page.getByText(jobId)).toHaveCount(1)
  await expect(page.getByText('Не реализовано; адаптер и модель не запускались')).toHaveCount(1)
  expect(new URL(page.url()).searchParams.get('snapshotJob')).toBe(jobId)

  await page.reload()
  await expect(page.getByText(jobId)).toHaveCount(1)
  await expect.poll(() => snapshotReads).toBeGreaterThan(0)
  await expect(page.getByText('Ревизия 1')).toHaveCount(1)

  await page.getByRole('button', { name: 'Изменить конфигурацию' }).press('Enter')
  await page.getByRole('button', { name: 'Создать следующую ревизию' }).evaluate((button) => {
    const form = button.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => reviseCalls).toBe(1)
  expect((reviseBodies[0] as { expectedRevision: number }).expectedRevision).toBe(1)
  const conflict = page.getByRole('alert').filter({ hasText: 'Частичная ревизия не сохранена' })
  await expect(conflict).toBeFocused()
  await expect(page.getByText('Ревизия 1')).toHaveCount(1)
  await page.getByRole('button', { name: 'Загрузить текущую ревизию' }).press('Enter')
  await expect(page.getByText('Ревизия 2')).toHaveCount(1)
  await expect(page.getByText('Ревизия 1')).toHaveCount(0)

  await page.getByRole('combobox', { name: 'Область' }).selectOption(project.id)
  await expect(page.getByText(ownedId)).toHaveCount(1)
  await expect(page.getByText(id)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: project.name })).toHaveCount(1)
  expect(listQueries.filter(({ scope }) => scope === 'project').every((value) => JSON.stringify(value) === JSON.stringify({
    recipeVersion: '1', scope: 'project', projectId: project.id,
  }))).toBe(true)

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const revise = page.getByRole('button', { name: 'Изменить конфигурацию' })
  await revise.focus()
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    transitionDuration: getComputedStyle(document.activeElement!).transitionDuration,
    outlineStyle: getComputedStyle(document.activeElement!).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement!).outlineWidth,
    cardBorderStyle: getComputedStyle(document.querySelector('.recipe-card')!).borderStyle,
    cardBorderWidth: getComputedStyle(document.querySelector('.recipe-card')!).borderWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.reducedMotion).toBe(true)
  expect(layout.forcedColors).toBe(true)
  expect(Number.parseFloat(layout.transitionDuration)).toBeCloseTo(0.00001, 8)
  expect(layout.outlineStyle).toBe('solid')
  expect(layout.outlineWidth).toBe('3px')
  expect(layout.cardBorderStyle).toBe('solid')
  expect(layout.cardBorderWidth).not.toBe('0px')
  expect(forbiddenEffects).toEqual([])
})
