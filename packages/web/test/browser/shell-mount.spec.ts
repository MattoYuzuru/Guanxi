import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { PROJECT_PRESENTATION_VERSION, SESSION_ROUTES } from '@guanxi/contract'
import { SHELL_PREFERENCES_KEY } from '../../src/features/shell/preferences.ts'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { choosePaletteCommand } from './fixtures/shell-navigation.ts'

const observedAt = '2026-10-22T12:00:00.000Z'
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
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

type Fixture = {
  locale: 'en' | 'ru'
  health: 'ok' | 'fail' | 'hold'
  healthGate: Promise<void>
  releaseHealth(): void
}

function createFixture(locale: 'en' | 'ru' = 'en'): Fixture {
  let release!: () => void
  const healthGate = new Promise<void>((resolve) => { release = resolve })
  return { locale, health: 'ok', healthGate, releaseHealth: () => release() }
}

async function installShellApi(page: Page, fixture: Fixture): Promise<void> {
  const finish = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') {
      if (fixture.health === 'hold') await fixture.healthGate
      if (fixture.health === 'fail') {
        return finish(route, { code: 'internal_error', message: 'offline', details: null }, 503)
      }
      return finish(route, health)
    }
    if (url.pathname === '/api/settings') {
      if (method === 'PUT') return finish(route, browserSettings({ locale: fixture.locale }))
      return finish(route, browserSettings({ locale: fixture.locale, localeSource: 'user_setting' }))
    }
    if (url.pathname === '/api/runtime') return finish(route, runtimeBrowserSnapshot())
    if (url.pathname === SESSION_ROUTES.page()) {
      return finish(route, { sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
    }
    if (url.pathname === '/api/models') return finish(route, { models: [] })
    if (url.pathname === '/api/workspaces') return finish(route, { workspaces: [] })
    if (url.pathname === '/api/threads' && method === 'GET') {
      return finish(route, { ownershipVersion: 1, scope: 'projectless', chats: [] })
    }
    if (url.pathname === '/api/projects') {
      return finish(route, { presentationVersion: PROJECT_PRESENTATION_VERSION, projects: [] })
    }
    if (url.pathname === '/api/layouts/context') {
      return finish(route, { account: 'local', replication: false })
    }
    if (url.pathname === '/api/layouts') {
      if (method === 'PUT') {
        const body = request.postDataJSON() as { document: unknown }
        return finish(route, { document: body.document, recovered: [] })
      }
      return finish(route, { documents: [], active: [] })
    }
    if (url.pathname === '/api/layouts/geometry') {
      if (method === 'PUT') return finish(route, { geometry: request.postDataJSON() })
      return finish(route, { geometry: {} })
    }
    return finish(
      route,
      { code: 'internal_error', message: `Unhandled fixture route ${method} ${url.pathname}`, details: null },
      500,
    )
  })
}

async function addPushStateCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const native = window.history.pushState.bind(window.history)
    const calls: string[] = []
    Object.assign(window, { __shellPushStateCalls: calls })
    window.history.pushState = (...args: Parameters<History['pushState']>) => {
      calls.push(String(args[2]))
      return native(...args)
    }
  })
}

async function chooseShell(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Navigation sidebar' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: label }).click()
  await expect(menu).toHaveCount(0)
}

const shellSidebar = '[data-slot="app-shell-sidebar"]'
const sidebarSlot = '[data-slot="sidebar-slot"]'

const sessionRegionName = { en: 'Sessions', ru: 'Сессии' } as const
const sessionEmptyText = {
  en: 'No sessions yet. Start a new session.',
  ru: 'Сессий пока нет. Начните новую сессию.',
} as const

/**
 * The mounted shell always reads the session page. A fixture that answers the wrong route
 * renders the sidebar error instead, so every mounted case names the intended empty state and
 * rejects a session error explicitly rather than passing on unrelated route assertions.
 */
async function expectEmptySessionList(page: Page, locale: 'en' | 'ru' = 'en'): Promise<void> {
  const region = page.getByRole('region', { name: sessionRegionName[locale] })
  await expect(region.getByText(sessionEmptyText[locale], { exact: true })).toBeVisible()
  expect(await region.getByRole('alert').count()).toBe(0)
}

test('mounts one shell and one slot around actual chat, workspace and non-chat routes', async ({ page }) => {
  const fixture = createFixture()
  await installShellApi(page, fixture)
  await page.goto('/chat')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)

  expect(await page.locator('main').count()).toBe(1)
  expect(await page.locator(shellSidebar).count()).toBe(1)
  expect(await page.locator(sidebarSlot).count()).toBe(1)
  await expect(page.locator('[data-plugin-entry]')).toHaveCount(1)
  expect(await page.getByRole('banner').count()).toBe(0)
  expect(await page.getByRole('link', { name: 'Chat', exact: true }).count()).toBe(0)
  expect(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').evaluateAll(
    links => links.map(link => link.getAttribute('href')),
  )).toEqual(['/agent', '/projects', '/', '/settings'])
  await expect(page.getByText('No current data', { exact: true })).toHaveCount(4)
  await expect(page.getByText(/Local hardware observation · .* · observed/u)).toBeVisible()

  await choosePaletteCommand(page, 'Session workspace')
  await expect(page).toHaveURL(/\/workspace$/u)
  await expect(page.locator('.workspace')).toBeVisible()
  expect(await page.locator('main').count()).toBe(1)
  expect(await page.locator(shellSidebar).count()).toBe(1)
  expect(await page.locator(sidebarSlot).count()).toBe(1)
  await expect(page.locator('[data-plugin-entry]')).toHaveCount(1)

  await choosePaletteCommand(page, 'Projects')
  await expect(page).toHaveURL(/\/projects$/u)
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
  expect(await page.locator('main').count()).toBe(1)
  expect(await page.locator(sidebarSlot).count()).toBe(1)
})

test('each fixed navigation link changes location exactly once', async ({ page }) => {
  const fixture = createFixture()
  await installShellApi(page, fixture)
  await addPushStateCounter(page)
  await page.goto('/chat')
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(navigation).toBeVisible()
  await expectEmptySessionList(page)

  const destinations = [
    ['Projects', '/projects'],
    ['Models', '/'],
    ['New', '/agent'],
    ['Settings', '/settings'],
  ] as const
  for (const [name, path] of destinations) {
    const before = await page.evaluate(() => (window as unknown as { __shellPushStateCalls: string[] }).__shellPushStateCalls.length)
    await navigation.getByRole('link', { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}$`, 'u'))
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shellPushStateCalls: string[] }).__shellPushStateCalls.length)).toBe(before + 1)
    expect(await page.locator('main').count()).toBe(1)
    expect(await page.locator(sidebarSlot).count()).toBe(1)
  }
})

test('move, rail, hide and show preserve route content, focus and stored geometry', async ({ page }) => {
  const fixture = createFixture()
  await installShellApi(page, fixture)
  await page.goto('/chat')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)
  const heading = page.getByRole('heading', { name: 'New conversation', exact: true })
  await expect(heading).toBeVisible()
  await heading.evaluate((element) => { element.dataset['shellRouteIdentity'] = 'original' })

  await chooseShell(page, 'Move sidebar to the right')
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-side', 'right')
  await expect(heading).toHaveAttribute('data-shell-route-identity', 'original')

  await chooseShell(page, 'Collapse sidebar to a rail')
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-visibility', 'rail')
  await expect(heading).toHaveAttribute('data-shell-route-identity', 'original')
  expect(await page.locator(sidebarSlot).count()).toBe(1)

  await chooseShell(page, 'Hide sidebar')
  await expect(page.locator(shellSidebar)).toHaveAttribute('hidden', '')
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()
  await expect(heading).toHaveAttribute('data-shell-route-identity', 'original')

  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Navigation sidebar' })).toBeFocused()
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-visibility', 'expanded')
  await expect(heading).toHaveAttribute('data-shell-route-identity', 'original')
  expect(await page.locator('main').count()).toBe(1)
  expect(await page.locator(sidebarSlot).count()).toBe(1)

  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])

  await chooseShell(page, 'Collapse sidebar to a rail')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SHELL_PREFERENCES_KEY))
    .toContain('"side":"right"')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SHELL_PREFERENCES_KEY))
    .toContain('"visibility":"rail"')
  await page.reload()
  await expect(page).toHaveURL(/\/chat$/u)
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-side', 'right')
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-visibility', 'rail')
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible()
  expect(await page.locator('main').count()).toBe(1)
  expect(await page.locator(sidebarSlot).count()).toBe(1)
})

test('Ctrl/Meta+K has one handler, one action and reveals secondary routes while navigation is hidden', async ({ page }) => {
  const fixture = createFixture()
  await installShellApi(page, fixture)
  await addPushStateCounter(page)
  await page.goto('/projects')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)
  await chooseShell(page, 'Hide sidebar')
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()

  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog).toBeVisible()
  expect(await page.getByRole('dialog').count()).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused()

  await page.keyboard.press('Meta+k')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Meta+k')
  await expect(dialog).toHaveCount(0)

  await page.keyboard.press('Control+k')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').fill('Chat')
  await dialog.getByRole('option', { name: 'Chat', exact: true }).click()
  await expect(page).toHaveURL(/\/chat$/u)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shellPushStateCalls: string[] }).__shellPushStateCalls.length)).toBe(1)
  expect(await page.locator(shellSidebar).getAttribute('data-visibility')).toBe('hidden')
  expect(await page.locator(sidebarSlot).count()).toBe(1)
})

test('health loading, failure and Retry stay usable before the shell mounts', async ({ page }) => {
  const fixture = createFixture()
  fixture.health = 'hold'
  await installShellApi(page, fixture)
  await page.goto('/chat')
  await expect(page.getByText('Checking Ollama…', { exact: true })).toBeVisible()
  expect(await page.getByRole('navigation', { name: 'Main navigation' }).count()).toBe(0)

  fixture.health = 'fail'
  fixture.releaseHealth()
  await expect(page.getByRole('heading', { name: 'The Guanxi server is not responding' })).toBeVisible()
  expect(await page.getByRole('navigation', { name: 'Main navigation' }).count()).toBe(0)

  fixture.health = 'ok'
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)
  expect(await page.locator('main').count()).toBe(1)
})

test('corrupt shell preferences cannot prevent startup', async ({ page }) => {
  const fixture = createFixture()
  await installShellApi(page, fixture)
  await page.addInitScript((key) => localStorage.setItem(key, '{not-json'), SHELL_PREFERENCES_KEY)
  await page.goto('/chat')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-side', 'left')
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-visibility', 'expanded')
  expect(await page.locator(sidebarSlot).count()).toBe(1)
})

test('denied shell storage cannot prevent startup and a failed write keeps the shell usable', async ({ page }) => {
  const fixture = createFixture()
  await installShellApi(page, fixture)
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key: string) {
      if (String(key).includes('shell.preferences')) throw new DOMException('denied', 'SecurityError')
      return getItem.call(this, key)
    }
    Storage.prototype.setItem = function (key: string, value: string) {
      if (String(key).includes('shell.preferences')) throw new DOMException('denied', 'SecurityError')
      return setItem.call(this, key, value)
    }
  })
  await page.goto('/chat')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)
  await chooseShell(page, 'Hide sidebar')
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-visibility', 'hidden')
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expectEmptySessionList(page)
  await expect(page.locator(shellSidebar)).toHaveAttribute('data-visibility', 'expanded')
})

for (const locale of ['en', 'ru'] as const) {
  test(`${locale.toUpperCase()} shell fits 320px with reduced motion and no page overflow`, async ({ page }) => {
    const fixture = createFixture(locale)
    await installShellApi(page, fixture)
    await page.setViewportSize({ width: 320, height: 720 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/chat')
    const navigation = page.getByRole('navigation', {
      name: locale === 'en' ? 'Main navigation' : 'Главная навигация',
    })
    await expect(navigation).toBeVisible()
    await expectEmptySessionList(page, locale)
    expect(await navigation.getByRole('link').count()).toBe(4)
    const names = locale === 'en'
      ? ['New', 'Projects', 'Models', 'Settings']
      : ['Новая сессия', 'Проекты', 'Модели', 'Настройки']
    for (const name of names) await expect(navigation.getByRole('link', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: locale === 'en' ? 'Command palette' : 'Палитра команд' })).toBeVisible()

    const layout = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar"]')!
      const main = document.querySelector<HTMLElement>('main')!
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        sidebar: sidebar.getBoundingClientRect().toJSON(),
        main: main.getBoundingClientRect().toJSON(),
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }
    })
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
    expect(await page.evaluate(() => { const host = document.querySelector('[data-slot="shell-route-host"]'); return host === null || host.scrollWidth <= host.clientWidth + 1 })).toBe(true)
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
    expect(layout.sidebar.left).toBeGreaterThanOrEqual(0)
    expect(layout.sidebar.right).toBeLessThanOrEqual(layout.viewport)
    expect(layout.main.left).toBeGreaterThanOrEqual(0)
    expect(layout.main.right).toBeLessThanOrEqual(layout.viewport)
    expect(layout.reducedMotion).toBe(true)
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  })
}
