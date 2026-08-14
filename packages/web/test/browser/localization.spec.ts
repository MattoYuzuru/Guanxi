import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('locale preview, persistence and glossary stay exact across failure and reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-14T16:00:00.000Z'
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
  let persisted = browserSettings({ locale: 'en', localeSource: 'user_setting' })
  let settingsReads = 0
  let settingsWrites = 0
  const settingsBodies: Array<Record<string, unknown>> = []
  const forbiddenEffects: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models' && method === 'GET') {
      return route.fulfill(json({ models: [] }))
    }
    if (url.pathname === '/api/settings' && method === 'GET') {
      settingsReads += 1
      return route.fulfill(json(persisted))
    }
    if (url.pathname === '/api/settings' && method === 'PUT') {
      settingsWrites += 1
      const body = request.postDataJSON() as Record<string, unknown>
      settingsBodies.push(body)
      if (settingsWrites === 1) {
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe settings failure',
          details: null,
        }, 500))
      }
      persisted = browserSettings({
        locale: body.locale === 'ru' ? 'ru' : 'en',
        localeSource: 'user_setting',
      })
      return route.fulfill(json(persisted))
    }
    if (method !== 'GET' || /jobs|threads|tools|workspaces|unload|prewarm|pull|ollama/u.test(url.pathname)) {
      forbiddenEffects.push(`${method} ${url.pathname}`)
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Models', exact: true })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en')

  const glossarySearch = page.getByRole('textbox', { name: 'Search glossary' })
  await glossarySearch.fill('SPEED UP CONTINUATION')
  await expect(page.getByRole('heading', { name: 'KV cache', exact: true })).toHaveCount(1)
  await expect(page.locator('#settings-glossary-results article')).toHaveCount(1)

  const language = page.getByRole('combobox', { name: 'Language' })
  const languageControl = page.locator('#settings-locale')
  await language.focus()
  const readsBeforePreview = settingsReads
  await language.selectOption('ru')
  await expect(languageControl).toBeFocused()
  expect(settingsReads).toBe(readsBeforePreview)
  expect(settingsWrites).toBe(0)
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Модели', exact: true })).toHaveCount(1)
  await expect(page.getByRole('status').filter({ hasText: 'Предпросмотр языка' })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('ru')

  const localizedSearch = page.getByRole('textbox', { name: 'Поиск по глоссарию' })
  await localizedSearch.fill('Диктовка ПРОМПТА')
  await expect(page.getByRole('heading', { name: 'Сценарий', exact: true })).toHaveCount(1)
  await expect(page.locator('#settings-glossary-results article')).toHaveCount(1)
  await localizedSearch.fill('definitely absent')
  await expect(page.getByText('По этому запросу ничего не найдено.')).toHaveCount(1)
  await expect(page.locator('#settings-glossary-results article')).toHaveCount(0)

  const save = page.getByRole('button', { name: 'Сохранить', exact: true })
  await save.focus()
  await save.press('Enter')
  await expect.poll(() => settingsWrites).toBe(1)
  const saveError = page.getByRole('alert')
  await expect(saveError).toBeFocused()
  await expect(saveError).toContainText('safe settings failure')
  await save.focus()
  await save.press('Enter')
  await expect.poll(() => settingsWrites).toBe(2)
  await expect(page.getByText('Настройки сохранены', { exact: true })).toHaveCount(1)
  expect(settingsBodies.map((body) => body.locale)).toEqual(['ru', 'ru'])
  expect(settingsBodies.every((body) => !Object.hasOwn(body, 'apiKey'))).toBe(true)

  const readsBeforeReload = settingsReads
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('ru')
  expect(settingsReads).toBeGreaterThan(readsBeforeReload)
  expect(settingsWrites).toBe(2)
  await expect(page.getByRole('heading', { name: 'Глоссарий', exact: true })).toHaveCount(1)
  await expect(page.locator('#settings-glossary-results article')).toHaveCount(17)

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const persistedLanguage = page.getByRole('combobox', { name: 'Язык' })
  await persistedLanguage.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(persistedLanguage).toBeFocused()
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    transitionDuration: getComputedStyle(document.activeElement!).transitionDuration,
    outlineStyle: getComputedStyle(document.activeElement!).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement!).outlineWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.reducedMotion).toBe(true)
  expect(layout.forcedColors).toBe(true)
  expect(Number.parseFloat(layout.transitionDuration)).toBeCloseTo(0.00001, 8)
  expect(layout.outlineStyle).toBe('solid')
  expect(Number.parseFloat(layout.outlineWidth)).toBeGreaterThanOrEqual(2)
  expect(settingsWrites).toBe(2)
  expect(forbiddenEffects).toEqual([])
})
