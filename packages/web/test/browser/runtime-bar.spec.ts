import { expect, test } from '@playwright/test'
import {
  activeRuntimeBrowserSnapshot,
  degradedRuntimeBrowserSnapshot,
} from './fixtures/runtime-snapshot.ts'

test('Runtime Bar projects resources, survives navigation, and recovers independent source failure', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-02T12:00:00.000Z'
  let runtimeState: 'active' | 'degraded' | 'recovered' = 'active'
  let runtimeCalls = 0
  const resourceActions: string[] = []

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
      freeDiskBytes: 100_000_000_000,
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

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET' && /(?:cancel|stop|unload)/u.test(url.pathname)) {
      resourceActions.push(`${request.method()} ${url.pathname}`)
    }
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') {
      runtimeCalls += 1
      const snapshot =
        runtimeState === 'degraded'
          ? degradedRuntimeBrowserSnapshot()
          : activeRuntimeBrowserSnapshot()
      return route.fulfill(json(snapshot))
    }
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    if (url.pathname === '/api/workspaces') return route.fulfill(json({ workspaces: [] }))
    if (url.pathname === '/api/threads') return route.fulfill(json({ threads: [] }))
    if (url.pathname === '/api/settings') {
      return route.fulfill(
        json({
          ollamaHost: health.ollama.host,
          defaultModel: null,
          defaultNumCtx: 8_192,
          autoApproveTools: false,
          enableBash: false,
          webSearch: { provider: 'none', baseUrl: null, hasApiKey: false },
          theme: 'system',
        }),
      )
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/chat')
  const runtime = page.getByRole('region', { name: 'Runtime и ресурсы' })
  await expect(runtime).toContainText('browser-active:latest')
  await runtime.getByText('Показать сведения о runtime').click()
  await expect(runtime.getByRole('heading', { name: 'Активный lease' })).toBeVisible()
  await expect(runtime.getByText(/Позиция 1/)).toBeVisible()
  await expect(runtime.getByText(/Позиция 2/)).toBeVisible()
  await expect(runtime.getByText(/возможен внешний клиент, но это не доказано/)).toBeVisible()
  await expect(runtime.getByText(/не гарантирует fit при будущем admission/).first()).toBeVisible()
  await runtime.evaluate((element) => {
    element.setAttribute('data-navigation-sentinel', 'preserved')
  })

  await page.getByRole('link', { name: 'Настройки' }).click()
  await expect(page).toHaveURL(/\/settings$/u)
  await expect(runtime).toHaveAttribute('data-navigation-sentinel', 'preserved')
  await expect(runtime.getByRole('heading', { name: 'Активный lease' })).toBeVisible()
  await page.getByRole('link', { name: 'Чат' }).click()
  await expect(page).toHaveURL(/\/chat$/u)
  await expect(runtime).toHaveAttribute('data-navigation-sentinel', 'preserved')
  expect(resourceActions).toEqual([])

  runtimeState = 'degraded'
  await runtime.getByRole('button', { name: 'Повторить runtime-проверку' }).click()
  await expect.poll(() => runtimeCalls).toBeGreaterThanOrEqual(2)
  await expect(runtime.getByText(/Источник Ollama недоступен · Наблюдение/)).toBeVisible()
  await expect(runtime.getByText('Host telemetry доступна с неизвестными полями', { exact: true })).toBeVisible()
  await expect(runtime.getByText(/Активный lease не наблюдался/)).toBeVisible()

  runtimeState = 'recovered'
  await runtime.getByRole('button', { name: 'Повторить runtime-проверку' }).click()
  await expect.poll(() => runtimeCalls).toBeGreaterThanOrEqual(3)
  await expect(runtime.getByText('browser-unknown-owner:latest')).toBeVisible()

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const layout = await runtime.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      bottomGap: window.innerHeight - rect.bottom,
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  })
  expect(layout.bottomGap).toBeLessThanOrEqual(1)
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Number.parseFloat(layout.animationDuration)).toBeLessThanOrEqual(0.00001)
  expect(Number.parseFloat(layout.transitionDuration)).toBeLessThanOrEqual(0.00001)
  expect(resourceActions).toEqual([])
})
