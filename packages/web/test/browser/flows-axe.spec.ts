/**
 * G14 on the app flows COMPONENTS_AND_CATALOG §5 names: no serious or critical axe violation on
 * the Settings screen (with the Developer section and its catalog link on) and in the
 * new-session flow (the empty chat screen, then the new dialog with its composer). Each flow
 * also has a seeded violation, an unnamed icon-only button injected into it, which the scan
 * must report, so a scan that silently checks nothing fails.
 *
 * The DS1-b residual for the inactive Context panel cache rows (text dimmed with `opacity-45`)
 * was repaired in the U1 shell-mount review round. The new-session flow now has to be clean,
 * and a direct computed-style check fails against the old opacity before the axe scan does.
 */
import AxeBuilder from '@axe-core/playwright'
import { SESSION_ROUTES } from '@guanxi/contract'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installChatApiFixture } from './fixtures/chat-api.ts'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

const observedAt = '2026-10-20T12:00:00.000Z'
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

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

async function mockSettingsApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings({ locale: 'en', theme: 'light' })))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === SESSION_ROUTES.page()) {
      return route.fulfill(json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } }))
    }
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })
}

/** Serious and critical violations only, as `rule: target` lines. */
async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`))
}

function seeded(violations: string[]): boolean {
  return violations.some((line) => line.startsWith('button-name: ') && line.includes('data-g14-seed'))
}

/** The seed: an icon-only button with no accessible name, placed inside the given region. */
async function injectUnnamedIconButton(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((region) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-g14-seed', '')
    button.innerHTML = '<svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>'
    region.append(button)
  })
}

async function openSettings(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => localStorage.setItem('guanxi.developerMode', 'on'))
  await mockSettingsApi(page)
  await page.goto('/settings')
  await expect(page.getByRole('switch', { name: 'Developer mode' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('link', { name: 'Open the component catalog' })).toBeVisible()
}

async function openNewSession(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installChatApiFixture(page, 'completed')
  await page.goto('/chat')
  await expect(page.getByRole('button', { name: 'Создать диалог' })).toBeVisible()
}

test('G14 Settings with the Developer section has no serious or critical axe violation', async ({ page }) => {
  await openSettings(page)
  expect(await seriousViolations(page)).toEqual([])
})

test('G14 seeded: an unnamed icon button in the Developer section is reported', async ({ page }) => {
  await openSettings(page)
  const section = page.getByRole('link', { name: 'Open the component catalog' }).locator('xpath=ancestor::section[1]')
  await expect(section).toHaveCount(1)
  await section.evaluate((region) => region.setAttribute('data-g14-region', ''))
  await injectUnnamedIconButton(page, '[data-g14-region]')
  expect(seeded(await seriousViolations(page)), 'seeded unnamed button reported').toBe(true)
})

test('G14 new-session flow has no serious or critical axe violation', async ({ page }) => {
  await openNewSession(page)
  expect(await seriousViolations(page), 'empty chat screen').toEqual([])
  await page.getByRole('button', { name: 'Создать диалог' }).click()
  await expect(page).toHaveURL(/\/chat\/thread-p0-e-full$/)
  await expect(page.getByRole('textbox', { name: 'Сообщение' })).toBeVisible()

  // Both responsive ContextPanels are in the DOM; only one is visible at a given viewport.
  // The fixture reports a cache miss, so the hit row is the inactive one. It used to dim its
  // label and duration with `opacity-45`; the semantic secondary text token replaced that, so
  // this fails against the old contrast implementation even before axe runs.
  const inactive = page.getByText('Попадание', { exact: true }).locator('xpath=..').filter({ visible: true })
  const active = page.getByText('Промах', { exact: true }).locator('xpath=..').filter({ visible: true })
  await expect(inactive, 'one visible inactive cache row').toHaveCount(1)
  await expect(active, 'one visible active cache row').toHaveCount(1)
  await expect(inactive).toBeVisible()
  await expect(active).toBeVisible()
  await expect(inactive).toHaveCSS('opacity', '1')
  expect(await inactive.evaluate((row) => getComputedStyle(row).color))
    .not.toBe(await active.evaluate((row) => getComputedStyle(row).color))

  expect(await seriousViolations(page), 'new dialog with composer').toEqual([])
})

test('G14 seeded: an unnamed icon button in the new-session flow is reported', async ({ page }) => {
  await openNewSession(page)
  await injectUnnamedIconButton(page, 'main')
  expect(seeded(await seriousViolations(page)), 'seeded unnamed button reported').toBe(true)
})
