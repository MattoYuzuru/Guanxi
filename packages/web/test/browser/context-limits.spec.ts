import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { closeStatusOverflow, openNavigation } from './fixtures/shell-navigation.ts'

const CUSTOM_CONTEXT = 1_048_577

test('custom context survives keyboard entry, exact requests, save, reload, and constrained layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const observedAt = '2026-08-03T00:00:00.000Z'
  let savedContext = 32_768
  let settingsReads = 0
  const modelContexts: number[] = []
  const catalogContexts: number[] = []
  const settingsBodies: Array<Record<string, unknown>> = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

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
      acceleratorName: 'Fixture Metal',
      unifiedMemory: true,
      freeDiskBytes: 100_000_000_000,
    },
    network: {
      ollamaComReachable: null,
      checkedAt: null,
      status: 'unknown',
      source: 'not_checked',
    },
  }
  const settings = () => browserSettings({
    ollamaHost: health.ollama.host,
    defaultModel: null,
    defaultNumCtx: savedContext,
    autoApproveTools: false,
    enableBash: false,
    prewarmEnabled: true,
  })
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') {
      return route.fulfill(json(runtimeBrowserSnapshot()))
    }
    if (url.pathname === '/api/models') {
      const requested = Number(url.searchParams.get('contextLength'))
      if (Number.isSafeInteger(requested)) modelContexts.push(requested)
      return route.fulfill(json({ models: [] }))
    }
    if (url.pathname === '/api/models/catalog') {
      const requested = Number(url.searchParams.get('contextLength'))
      if (Number.isSafeInteger(requested)) catalogContexts.push(requested)
      return route.fulfill(
        json({
          models: [],
          live: false,
          source: { state: 'unknown', source: 'none', observedAt, fetchedAt: null },
        }),
      )
    }
    if (url.pathname === '/api/settings' && request.method() === 'GET') {
      settingsReads += 1
      return route.fulfill(json(settings()))
    }
    if (url.pathname === '/api/settings' && request.method() === 'PUT') {
      const body = request.postDataJSON() as Record<string, unknown>
      settingsBodies.push(body)
      savedContext = Number(body.defaultNumCtx)
      return route.fulfill(json(settings()))
    }
    return route.fulfill(
      json({ code: 'internal_error', message: url.pathname, details: null }, 500),
    )
  })

  await page.goto('/')
  const launcherContext = page.getByRole('spinbutton', {
    name: 'Размер окна контекста для расчёта влезаемости',
  })
  await launcherContext.focus()
  await expect(launcherContext).toBeFocused()
  await launcherContext.fill(String(CUSTOM_CONTEXT))
  await launcherContext.press('Enter')
  await expect.poll(() => modelContexts.includes(CUSTOM_CONTEXT)).toBe(true)
  await expect.poll(() => catalogContexts.includes(CUSTOM_CONTEXT)).toBe(true)
  await expect(page.getByText(/Preset-значения — только подсказки/)).toBeVisible()

  await closeStatusOverflow(page)

  await openNavigation(page)

  await page.getByRole('link', { name: 'Настройки' }).click()
  const settingsContext = page.getByRole('spinbutton', {
    name: 'Контекст агента по умолчанию',
  })
  await expect(settingsContext).not.toHaveAttribute('max')
  await settingsContext.focus()
  await expect(settingsContext).toBeFocused()
  await settingsContext.fill(String(CUSTOM_CONTEXT))
  await settingsContext.press('Enter')
  await expect(page.getByText('Настройки сохранены')).toBeVisible()
  await expect.poll(() => settingsBodies.length).toBe(1)
  expect(settingsBodies[0]).toMatchObject({ defaultNumCtx: CUSTOM_CONTEXT })

  const readsBeforeReload = settingsReads
  await page.reload()
  await expect(page).toHaveURL(/\/settings$/u)
  await expect(page.getByRole('spinbutton', { name: 'Контекст агента по умолчанию' }))
    .toHaveValue(String(CUSTOM_CONTEXT))
  expect(settingsReads).toBeGreaterThan(readsBeforeReload)

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const layout = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#settings-default-context')
    const style = input ? getComputedStyle(input) : null
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: style?.animationDuration ?? '',
      transitionDuration: style?.transitionDuration ?? '',
    }
  })
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Number.parseFloat(layout.animationDuration)).toBeLessThanOrEqual(0.00001)
  expect(Number.parseFloat(layout.transitionDuration)).toBeLessThanOrEqual(0.00001)
  expect(pageErrors).toEqual([])
})
