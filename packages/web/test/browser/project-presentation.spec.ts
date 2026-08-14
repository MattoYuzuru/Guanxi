import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Project presentation picker is bounded, accessible and single-mutation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-10T10:00:00.000Z'
  const project = {
    id: 'project-presentation',
    name: `Long Project ${'identity-'.repeat(10)}`,
    createdAt: observedAt,
    updatedAt: observedAt,
    filesystemBindings: [],
    presentationVersion: 1,
    iconKey: 'folder',
    colorToken: 'slate',
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
  let presentationMutations = 0
  let presentationBody: unknown = null
  let releasePresentation!: () => void
  const presentationGate = new Promise<void>((resolve) => {
    releasePresentation = resolve
  })
  const unexpectedMutations: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/projects' && request.method() === 'GET') {
      expect(url.searchParams.toString()).toBe('presentationVersion=1')
      return route.fulfill(json({ presentationVersion: 1, projects: [project] }))
    }
    if (url.pathname === `/api/projects/${project.id}/chats` && request.method() === 'GET') {
      const { presentationVersion: _version, iconKey: _icon, colorToken: _color, ...legacy } = project
      return route.fulfill(json({ ownershipVersion: 1, project: legacy, chats: [] }))
    }
    if (
      url.pathname === `/api/projects/${project.id}/presentation` &&
      request.method() === 'PATCH'
    ) {
      presentationMutations += 1
      presentationBody = request.postDataJSON()
      await presentationGate
      Object.assign(project, {
        iconKey: (presentationBody as { iconKey: string }).iconKey,
        colorToken: (presentationBody as { colorToken: string }).colorToken,
        updatedAt: '2026-08-10T10:01:00.000Z',
      })
      return route.fulfill(json(project))
    }
    if (request.method() !== 'GET') unexpectedMutations.push(`${request.method()} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/projects')
  const appearance = page.getByRole('button', { name: 'Изменить оформление' })
  await expect(appearance).toBeVisible()
  await appearance.press('Enter')
  const dialogName = `Оформление проекта — ${project.name}`
  const dialog = page.getByRole('dialog', { name: dialogName })
  const iconSearch = page.getByRole('textbox', { name: 'Поиск иконок' })
  await expect(iconSearch).toBeFocused()
  const closeControls = page.getByRole('button', { name: 'Закрыть выбор оформления' })
  const saveControl = page.getByRole('button', { name: 'Сохранить оформление' })
  await expect(closeControls).toHaveCount(2)
  await saveControl.focus()
  await page.keyboard.press('Tab')
  await expect(closeControls.first()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(saveControl).toBeFocused()
  await closeControls.first().press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(appearance).toBeFocused()

  await appearance.press('Enter')
  await expect(iconSearch).toBeFocused()
  await closeControls.last().press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(appearance).toBeFocused()

  await appearance.press('Enter')
  await expect(iconSearch).toBeFocused()
  await expect(page.getByRole('gridcell')).toHaveCount(12)
  await expect(page.getByText('Страница иконок 1 из 4')).toBeVisible()

  await page.getByRole('button', { name: 'Исследования', exact: true }).press('Enter')
  await expect(page.getByRole('gridcell')).toHaveCount(8)
  await expect(page.getByText('Страница иконок 1 из 1')).toBeVisible()
  await page.getByRole('button', { name: 'Все', exact: true }).press('Space')
  const folder = page.getByRole('gridcell', { name: 'Папка' })
  await folder.focus()
  await folder.press('End')
  await expect(page.getByRole('gridcell', { name: 'Ветка Git' })).toBeFocused()
  await page.getByRole('gridcell', { name: 'Ветка Git' }).press('PageDown')
  await expect(page.getByText('Страница иконок 2 из 4')).toBeVisible()
  await expect(page.getByRole('gridcell')).toHaveCount(12)
  await page.getByRole('gridcell').first().press('PageUp')
  await expect(page.getByText('Страница иконок 1 из 4')).toBeVisible()

  await iconSearch.fill('микроскоп')
  await expect(page.getByRole('gridcell')).toHaveCount(1)
  await expect(page.getByRole('gridcell', { name: 'Микроскоп' })).toHaveAttribute('aria-selected', 'false')
  await iconSearch.fill('нет-такой-иконки')
  await expect(page.getByRole('gridcell')).toHaveCount(0)
  await expect(page.getByText('Для этого поиска и категории иконок не найдено.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(appearance).toBeFocused()

  await appearance.press('Space')
  await expect(iconSearch).toBeFocused()
  const rocket = page.getByRole('gridcell', { name: 'Ракета' })
  await rocket.press('Enter')
  await expect(rocket).toHaveAttribute('aria-selected', 'true')
  const slate = page.getByRole('radio', { name: 'Графитовый' })
  const blue = page.getByRole('radio', { name: 'Синий' })
  const violet = page.getByRole('radio', { name: 'Фиолетовый' })
  await slate.focus()
  await slate.press('ArrowLeft')
  await expect(violet).toBeFocused()
  await expect(violet).toHaveAttribute('aria-checked', 'true')
  await violet.press('ArrowRight')
  await expect(slate).toBeFocused()
  await slate.press('ArrowRight')
  await expect(blue).toBeFocused()
  await expect(blue).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(1)

  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
  expect(await blue.evaluate((element) => getComputedStyle(element).borderStyle)).not.toBe('none')

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  await expect(page.getByRole('heading', { name: dialogName })).toBeVisible()
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
  const dialogLayout = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(dialogLayout.scrollWidth).toBeLessThanOrEqual(dialogLayout.clientWidth)
  const motion = await dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration }
  })
  expect(['0s', '1e-05s']).toContain(motion.animationDuration)
  expect(['0s', '1e-05s']).toContain(motion.transitionDuration)

  const save = page.getByRole('button', { name: 'Сохранить оформление' })
  await save.evaluate((button) => {
    const form = button.closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => presentationMutations).toBe(1)
  expect(presentationBody).toEqual({ presentationVersion: 1, iconKey: 'rocket', colorToken: 'blue' })
  releasePresentation()
  await expect(dialog).toHaveCount(0)
  await expect(appearance).toBeFocused()
  expect(unexpectedMutations).toEqual([])
  expect(presentationMutations).toBe(1)
})
