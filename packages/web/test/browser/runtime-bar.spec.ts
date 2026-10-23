import { SESSION_ROUTES } from '@guanxi/contract'
import { expect, test, type Page } from '@playwright/test'
import {
  activeRuntimeBrowserSnapshot,
  browserSettings,
  degradedRuntimeBrowserSnapshot,
  linuxNvidiaRuntimeBrowserSnapshot,
} from './fixtures/runtime-snapshot.ts'
import { choosePaletteCommand, closeStatusOverflow, openNavigation, openStatusOverflow } from './fixtures/shell-navigation.ts'

/*
 * D-202/D-203: the runtime bar became the status strip's runtime item. Its popover holds the same
 * projection (region "Runtime и ресурсы"), the shared sample refreshes on its own (a page that
 * becomes visible reads at once), and there is no "Повторить runtime-проверку" button.
 */
// A CSS locator: on a phone the item lives in the status overflow, which stays mounted while closed.
const runtimeTrigger = (page: Page) => page.locator('[data-slot="status-item"] button[aria-label^="Среда выполнения"]')
async function openRuntime(page: Page) {
  const popover = page.getByTestId('shell-runtime-popover')
  if (!(await popover.isVisible().catch(() => false))) { await openStatusOverflow(page); await runtimeTrigger(page).click() }
  await expect(popover).toBeVisible()
  return popover.getByRole('region', { name: 'Runtime и ресурсы' })
}
/** The sample loop re-reads when the page becomes visible; no user Retry is involved. */
const nextSample = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

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
    if (url.pathname === SESSION_ROUTES.page()) {
      return route.fulfill(json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } }))
    }
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
    if (url.pathname === '/api/threads') return route.fulfill(json({ ownershipVersion: 1, scope: 'projectless', chats: [] }))
    if (url.pathname === '/api/settings') {
      return route.fulfill(
        json(browserSettings({
          ollamaHost: health.ollama.host,
          defaultModel: null,
          defaultNumCtx: 8_192,
          autoApproveTools: false,
          enableBash: false,
        })),
      )
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/chat')
  let runtime = await openRuntime(page)
  await expect(runtime).toContainText('browser-active:latest')
  await expect(runtime.getByRole('heading', { name: 'Активный lease' })).toBeVisible()
  await expect(runtime.getByText(/Позиция 1/)).toBeVisible()
  await expect(runtime.getByText(/Позиция 2/)).toBeVisible()
  await expect(runtime.getByText(/возможен внешний клиент, но это не доказано/)).toBeVisible()
  await expect(runtime.getByText(/не гарантирует fit при будущем admission/).first()).toBeVisible()
  await page.keyboard.press('Escape')
  // The strip item is mounted once by the shell and survives navigation (no re-mount).
  await runtimeTrigger(page).evaluate((element) => {
    element.setAttribute('data-navigation-sentinel', 'preserved')
  })

  await closeStatusOverflow(page)

  await openNavigation(page)

  await page.getByRole('link', { name: 'Настройки' }).click()
  await expect(page).toHaveURL(/\/settings$/u)
  await expect(runtimeTrigger(page)).toHaveAttribute('data-navigation-sentinel', 'preserved')
  runtime = await openRuntime(page)
  await expect(runtime.getByRole('heading', { name: 'Активный lease' })).toBeVisible()
  await page.keyboard.press('Escape')
  await choosePaletteCommand(page, 'Чат')
  await expect(page).toHaveURL(/\/chat$/u)
  await expect(runtimeTrigger(page)).toHaveAttribute('data-navigation-sentinel', 'preserved')
  expect(resourceActions).toEqual([])

  runtimeState = 'degraded'
  runtime = await openRuntime(page)
  await expect(page.getByRole('button', { name: /Повторить runtime-проверку/u })).toHaveCount(0)
  const before = runtimeCalls
  await nextSample(page)
  await expect.poll(() => runtimeCalls).toBeGreaterThan(before)
  // The open popover updates in place.
  // Facts are label and value pairs; the source state is the value's quiet meta (visual pass 5).
  await expect(runtime.getByText('Источник Ollama недоступен', { exact: true })).toBeVisible()
  await expect(runtime.getByText('Host telemetry доступна с неизвестными полями', { exact: true })).toBeVisible()
  await expect(runtime.getByText(/Активный lease не наблюдался/)).toBeVisible()

  runtimeState = 'recovered'
  const degradedCalls = runtimeCalls
  await nextSample(page)
  await expect.poll(() => runtimeCalls).toBeGreaterThan(degradedCalls)
  await expect(runtime.getByText('browser-unknown-owner:latest')).toBeVisible()

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const layout = await page.getByTestId('shell-runtime-popover').evaluate((element) => {
    const popup = element.closest('[data-slot="popover-content"]') as HTMLElement
    const rect = popup.getBoundingClientRect()
    const style = getComputedStyle(popup)
    return {
      rightGap: window.innerWidth - rect.right,
      leftGap: rect.left,
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  })
  // The popover stays inside a 390 px viewport (it replaces the bottom-docked phone bar).
  expect(layout.rightGap).toBeGreaterThanOrEqual(-1)
  expect(layout.leftGap).toBeGreaterThanOrEqual(-1)
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Number.parseFloat(layout.animationDuration)).toBeLessThanOrEqual(0.00001)
  expect(Number.parseFloat(layout.transitionDuration)).toBeLessThanOrEqual(0.00001)
  expect(resourceActions).toEqual([])
})

test('Runtime Bar truthfully groups Linux NVIDIA devices and preserves a stale sample', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  let state: 'available' | 'partial' | 'unavailable' | 'transport-failure' = 'available'
  const resourceActions: string[] = []
  const observedAt = '2026-08-02T12:00:00.000Z'
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true,
      state: 'reachable', source: 'ollama_api_version', observedAt,
      version: 'test', host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'linux', arch: 'x64', cpuModel: 'fixture', cpuCores: 16,
      totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 22 * 1024 ** 3,
      accelerator: 'cuda', acceleratorName: 'legacy', unifiedMemory: false,
      freeDiskBytes: 100_000_000_000,
    },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') resourceActions.push(`${request.method()} ${url.pathname}`)
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === SESSION_ROUTES.page()) {
      return route.fulfill(json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } }))
    }
    if (url.pathname === '/api/runtime') {
      if (state === 'transport-failure') {
        return route.fulfill(json({ code: 'internal_error', message: 'private-runtime-sentinel', details: null }, 503))
      }
      return route.fulfill(json(linuxNvidiaRuntimeBrowserSnapshot(state)))
    }
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    if (url.pathname === '/api/workspaces') return route.fulfill(json({ workspaces: [] }))
    if (url.pathname === '/api/threads') return route.fulfill(json({ ownershipVersion: 1, scope: 'projectless', chats: [] }))
    if (url.pathname === '/api/settings') {
      return route.fulfill(json(browserSettings({
        ollamaHost: health.ollama.host, defaultModel: null, defaultNumCtx: 8_192,
        autoApproveTools: false, enableBash: false,
      })))
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/chat')
  const runtime = await openRuntime(page)
  const devices = runtime.getByRole('region', { name: 'Устройства NVIDIA' })
  await expect(devices.getByText('NVIDIA RTX 4090')).toBeVisible()
  await expect(devices.getByText('NVIDIA Тестовая GPU')).toBeVisible()
  await expect(devices).toContainText('GPU-…12345678')
  await expect(devices).not.toContainText('GPU-browser-private-first')
  await expect(devices).toContainText(/Текущая свободная VRAM устройства0\s*Б/u)
  await expect(devices).toContainText('не безопасная ёмкость для допуска')
  await expect(runtime).toContainText('Точная identity модели, runtime, контекста и железа неполна')
  expect(resourceActions).toEqual([])

  await expect(page.getByRole('button', { name: /Повторить runtime-проверку/u })).toHaveCount(0)
  state = 'partial'
  await nextSample(page)
  await expect(runtime).toContainText('Телеметрия NVIDIA неполна')
  const partialText = await devices.textContent()

  // A failed read keeps the last sample unchanged, and the strip names it as the last sample.
  state = 'transport-failure'
  await nextSample(page)
  await expect(runtimeTrigger(page)).toHaveAccessibleName(/последний замер/u)
  await expect(devices).toHaveText(partialText ?? '')
  await expect(page.getByTestId('shell-runtime-popover')).not.toContainText('private-runtime-sentinel')

  await page.keyboard.press('Escape')
  await closeStatusOverflow(page)
  await openNavigation(page)
  await page.getByRole('link', { name: 'Настройки' }).click()
  await openRuntime(page)
  await expect(devices).toBeVisible()
  await expect(devices).toHaveText(partialText ?? '')
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await runtime.evaluate((element) => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    deviceOverflow: element.querySelector('[aria-labelledby="runtime-nvidia-devices-title"] ul')?.scrollHeight ?? 0,
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(layout.deviceOverflow).toBeGreaterThan(0)
  expect(resourceActions).toEqual([])
})
