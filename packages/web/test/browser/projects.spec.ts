import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Projects exposes resilient keyboard flow without requiring a filesystem root', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-09T10:00:00.000Z'
  const project = {
    id: 'project-browser',
    name: 'Keyboard Project',
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
      platform: 'darwin',
      arch: 'arm64',
      cpuModel: 'fixture',
      cpuCores: 8,
      totalMemoryBytes: 16_000_000_000,
      usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal',
      acceleratorName: 'fixture',
      unifiedMemory: true,
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

  let releaseInitial!: () => void
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve
  })
  let projectMode: 'loading' | 'empty' = 'loading'
  let projectCreates = 0
  const sideEffects: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/projects' && request.method() === 'GET') {
      const mode = projectMode
      if (mode === 'loading') {
        await initialGate
        return route.fulfill(json({ code: 'internal_error', message: 'safe fixture failure', details: null }, 500))
      }
      return route.fulfill(json({ projects: projectCreates === 0 ? [] : [project] }))
    }
    if (url.pathname === '/api/projects' && request.method() === 'POST') {
      projectCreates += 1
      return route.fulfill(json(project, 201))
    }
    if (request.method() !== 'GET') sideEffects.push(`${request.method()} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/projects')
  await expect(page.getByRole('status', { name: 'Загружаем проекты' })).toBeVisible()
  projectMode = 'empty'
  releaseInitial()

  const errorHeading = page.getByRole('heading', { name: 'Не удалось загрузить проекты' })
  await expect(errorHeading).toBeFocused()
  await page.getByRole('button', { name: 'Повторить', exact: true }).press('Enter')
  await expect(page.getByText('Проектов пока нет')).toBeVisible()

  const name = page.getByRole('textbox', { name: 'Название проекта' })
  await name.fill('Keyboard Project')
  await name.evaluate((input) => {
    const form = input.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => projectCreates).toBe(1)
  await expect(page.getByRole('textbox', { name: 'Переименовать — Keyboard Project' })).toBeVisible()
  await expect(page.getByText('Нет привязки к файловой системе')).toBeVisible()
  await expect(page.getByLabel(/path|root|папк/iu)).toHaveCount(0)

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)

  const motion = await page.locator('article').evaluate((element) => {
    const style = getComputedStyle(element)
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration }
  })
  expect(['0s', '1e-05s']).toContain(motion.animationDuration)
  expect(['0s', '1e-05s']).toContain(motion.transitionDuration)
  expect(sideEffects).toEqual([])
})
