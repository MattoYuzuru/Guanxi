/**
 * U1 new-session screen (LAYOUT_AND_SCREENS E1): keyboard flow, screen-reader structure, every
 * state (loading, empty, error, offline, degraded, start failure), both themes and locales,
 * phone width and large text. Counts are exact: one request per action, one alert per failure.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  FIXTURE_CONNECTION, FIXTURE_LOCAL_CONNECTION, completedProgress, createSessionFeaturesFixture, fixtureConnection,
  fixtureProject, fixtureWorkspace, installSessionFeaturesApi, type SessionFeaturesFixture,
} from './fixtures/session-features-api.ts'

async function open(page: Page, fixture: SessionFeaturesFixture, path = '/agent') {
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
}
const form = (page: Page, name = 'New session') => page.getByRole('region', { name, exact: true })
const start = (page: Page) => page.getByRole('button', { name: 'Start session' })
const prompt = (page: Page) => page.getByRole('textbox', { name: 'What should the agent do?' })
const retryButtons = (page: Page) => page.getByRole('button', { name: /Retry|Refresh|Try again/u })
/** Opens the model popover at the composer's lower right and types a model ID. */
async function chooseModel(page: Page, model: string) {
  await page.getByRole('button', { name: /^(Choose a model|Model: )/u }).click()
  await page.getByLabel('Model ID').fill(model)
}
async function chooseProject(page: Page, name: string) {
  await page.getByRole('button', { name: /^(Choose a project|Project: )/u }).click()
  await page.getByRole('menuitem', { name: new RegExp(name, 'u') }).click()
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toHaveCount(1)
}

/** Serious and critical violations only, as `rule: target` lines. */
async function seriousViolations(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap(violation => violation.nodes.map(node => `${violation.id}: ${node.target.join(' ')}`))
}

test('keyboard alone completes the flow: exact tab order, visible focus, one request, then the session', async ({ page }) => {
  const fixture = createSessionFeaturesFixture({ progress: { 'session-1': completedProgress('session-1') } })
  await open(page, fixture)
  await expect(form(page)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'What should the agent do?' })).toHaveCount(1)
  // D-207: an empty session is the composer; it takes focus.
  await expect(prompt(page)).toBeFocused()

  const focused = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    if (!element) return null
    const label = element.getAttribute('aria-label') ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? element.textContent
    // The composer shows focus on the whole card (accent border and halo), not on its text area.
    const target = element.tagName === 'TEXTAREA' ? element.closest('[data-slot="composer"]') as HTMLElement ?? element : element
    const style = getComputedStyle(target)
    // A resting shadow is not focus: the card counts as focused only with the accent border.
    const probe = document.createElement('span'); probe.style.color = 'var(--color-border-accent)'; document.body.append(probe)
    const accent = getComputedStyle(probe).color; probe.remove()
    const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      || (target !== element && style.borderTopColor === accent)
    return { label: (label ?? '').trim(), ring }
  })
  const tabTo = async (label: string, key = 'Tab') => {
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press(key)
      if ((await focused())?.label === label) return
    }
    throw new Error(`keyboard never reached ${label}`)
  }

  // Shift+Tab reaches the project picker above the composer; Enter opens it, Enter picks the first project.
  await page.keyboard.press('Shift+Tab')
  expect(await focused()).toEqual({ label: 'Choose a project', ring: true })
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Project: Alpha' })).toBeFocused()

  const order: string[] = []
  for (const expected of ['What should the agent do?', 'Access: Read-only', 'Run options', 'Choose a model']) {
    await page.keyboard.press('Tab')
    const state = await focused()
    expect(state?.ring, `focus ring on ${state?.label}`).toBe(true)
    order.push(state?.label ?? '')
    if (expected === 'What should the agent do?') await page.keyboard.type('Inspect the repository')
  }
  expect(order).toEqual(['What should the agent do?', 'Access: Read-only', 'Run options', 'Choose a model'])
  // The model popover opens from the keyboard; the only connection is already chosen.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Fixture model' })).toHaveAttribute('aria-pressed', 'true')
  await tabTo('Model ID')
  await page.keyboard.type('fixture')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Model: fixture' })).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await focused()).toEqual({ label: 'Start session', ring: true })
  await expect(start(page)).not.toHaveAttribute('aria-disabled', 'true')

  await prompt(page).focus()
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Second line')
  await expect(prompt(page)).toHaveValue('Inspect the repository\nSecond line')
  expect(fixture.requests.create).toHaveLength(0)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/agent\/session-1$/u)
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused() // the route change moves focus to the new page's heading
  await expect(page.getByText('Fixture response', { exact: true })).toHaveCount(1)
  expect(fixture.requests.create).toEqual([{
    projectId: 'p', connectionId: FIXTURE_CONNECTION, model: 'fixture', mode: 'read-only', prompt: 'Inspect the repository\nSecond line',
    retention: 'ttl', domains: [], attachmentIds: [], protectedPaths: [],
  }])
})

test('screen-reader structure: names, the one-line need description and one live hint', async ({ page }) => {
  await open(page, createSessionFeaturesFixture())
  await expect(form(page)).toBeVisible()
  const region = form(page)
  await expect(region.getByRole('button', { name: 'Choose a project' })).toHaveCount(1)
  await expect(region.getByRole('textbox', { name: 'What should the agent do?' })).toHaveCount(1)
  await expect(region.getByRole('button', { name: 'Access: Read-only' })).toHaveCount(1)
  await expect(region.getByRole('button', { name: 'Run options' })).toHaveCount(1)
  await expect(region.getByRole('button', { name: 'Choose a model' })).toHaveCount(1)
  await expect(start(page)).toHaveAttribute('aria-disabled', 'true')
  // The hint names only the first missing need, and Send is described by it.
  await expect(page.locator('#new-session-needs')).toHaveText('Choose a project.')
  await expect(start(page)).toHaveAccessibleDescription('Choose a project.')
  await expect(region.getByRole('status')).toHaveCount(1)
  await expect(retryButtons(page)).toHaveCount(0)
  // Every control has a programmatic name, including the ones inside the popovers.
  await page.getByRole('button', { name: 'Run options' }).click()
  await expect(page.getByLabel('Network allowlist (comma-separated hosts)')).toHaveAccessibleDescription(/Loopback hosts require a port/u)
  const unnamed = await page.locator('main input, main select, main textarea, main button, [data-slot="popover-content"] input, [data-slot="popover-content"] textarea, [data-slot="popover-content"] button').evaluateAll(
    elements => elements.filter(element => {
      const control = element as HTMLInputElement
      return !(control.getAttribute('aria-label') || control.labels?.length || control.textContent?.trim())
    }).length)
  expect(unnamed).toBe(0)
  await page.keyboard.press('Escape')
  await chooseModel(page, 'fixture')
  await expect(page.getByLabel('Model ID')).toHaveAccessibleDescription(/exact model ID/u)
})

test('every state has no critical or serious axe finding, in both themes and both locales', async ({ page }) => {
  for (const { locale, theme } of [{ locale: 'en', theme: 'light' }, { locale: 'en', theme: 'dark' }, { locale: 'ru', theme: 'light' }, { locale: 'ru', theme: 'dark' }] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    const fixture = createSessionFeaturesFixture({ locale, theme })
    await open(page, fixture)
    const name = locale === 'en' ? 'New session' : 'Новая сессия'
    await expect(form(page, name)).toBeVisible()
    expect(await seriousViolations(page), `${locale}/${theme} ready`).toEqual([])
    await page.getByRole('button', { name: locale === 'en' ? 'Access: Read-only' : 'Доступ: Только чтение' }).click()
    await page.getByRole('menuitem', { name: locale === 'en' ? 'Full access' : 'Полный доступ' }).click()
    await page.getByRole('button', { name: locale === 'en' ? 'Run options' : 'Параметры запуска' }).click()
    await page.getByLabel(locale === 'en' ? 'Network allowlist (comma-separated hosts)' : 'Разрешённые сетевые адреса (через запятую)').fill('localhost')
    await expect(page.getByRole('list', { name: locale === 'en' ? 'Changed options' : 'Изменённые параметры' })).toBeVisible()
    expect(await seriousViolations(page), `${locale}/${theme} run options, chips and invalid host`).toEqual([])
  }
})

test('loading, empty, error, offline and start-failure states are single, accessible and recover by themselves', async ({ page }) => {
  // Loading: a skeleton and one status, no composer, until the held request is released.
  let release!: () => void
  const fixture = createSessionFeaturesFixture({ holdProjects: new Promise<void>(resolve => { release = resolve }) })
  await open(page, fixture)
  await expect(page.getByTestId('new-session-skeleton')).toHaveCount(1)
  await expect(page.getByText('Loading session choices…', { exact: true })).toHaveCount(1)
  await expect(form(page)).toHaveCount(0)
  expect(await seriousViolations(page), 'loading').toEqual([])
  release()
  await expect(form(page)).toBeVisible()
  await expect(page.getByTestId('new-session-skeleton')).toHaveCount(0)

  // Start failure: one alert, focus moves to it, nothing typed is lost, no navigation.
  fixture.create = () => ({ status: 409, body: { code: 'root_busy' } })
  await chooseProject(page, 'Alpha')
  await prompt(page).fill('Inspect')
  await chooseModel(page, 'fixture')
  await page.keyboard.press('Escape')
  await start(page).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('The session could not be started')
  await expect(page.getByRole('alert')).toContainText('Another full-access session already uses one of these folders')
  expect(await page.evaluate(() => document.activeElement?.contains(document.querySelector('[role="alert"]')))).toBe(true)
  await expect(prompt(page)).toHaveValue('Inspect')
  await expect(page.getByRole('button', { name: 'Model: fixture' })).toHaveCount(1)
  expect(page.url()).toMatch(/\/agent$/u)
  expect(fixture.requests.create).toHaveLength(1)
  await expect(retryButtons(page)).toHaveCount(0)
  expect(await seriousViolations(page), 'start failure').toEqual([])

  // Offline: the node drops; one status line, no alert, no Retry, Start blocked; it recovers by itself.
  fixture.agentNetwork = 'down'
  await page.reload()
  await expect(page.locator('[data-state="node_unreachable"]')).toHaveCount(1)
  await expect(page.locator('[data-state="node_unreachable"]')).toHaveAttribute('role', 'status')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(retryButtons(page)).toHaveCount(0)
  await expect(start(page)).toHaveAttribute('aria-disabled', 'true')
  expect(await seriousViolations(page), 'offline').toEqual([])
  fixture.agentNetwork = 'up'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('[data-state="node_unreachable"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Choose a project' })).toHaveCount(1)

  // Error: the node answers with a failure; the source and code are named and copyable.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  const broken = createSessionFeaturesFixture({ extra: async (route, url) => {
    if (url.pathname !== '/api/agent/projects') return false
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'egress_unavailable' }) })
    return true
  } })
  await installSessionFeaturesApi(page, broken)
  await page.reload()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByText('GET /api/agent/projects', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('egress_unavailable')
  await expect(page.getByRole('alert')).toContainText('Session choices could not be loaded. The node is still preparing secret protection')
  await expect(retryButtons(page)).toHaveCount(0)
  expect(await seriousViolations(page), 'error').toEqual([])

  // Empty: one sentence and one primary action each.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await installSessionFeaturesApi(page, createSessionFeaturesFixture({ projects: [] }))
  await page.reload()
  await expect(page.getByText('No projects yet. Create a project to start a session.', { exact: true })).toHaveCount(1)
  await expect(page.locator('[data-slot="empty-state"] a')).toHaveCount(1)
  expect(await seriousViolations(page), 'empty projects').toEqual([])
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await installSessionFeaturesApi(page, createSessionFeaturesFixture({ connections: [] }))
  await page.reload()
  await expect(page.getByText('No model connection yet. Add one in Settings to start a session.', { exact: true })).toHaveCount(1)
  await expect(page.locator('[data-slot="empty-state"] a')).toHaveCount(1)
  expect(await seriousViolations(page), 'empty connections').toEqual([])
})

test('seeded violation: an unnamed icon button in the new-session screen is reported', async ({ page }) => {
  await open(page, createSessionFeaturesFixture())
  await expect(form(page)).toBeVisible()
  await form(page).evaluate(region => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-g14-seed', '')
    button.innerHTML = '<svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>'
    region.append(button)
  })
  expect((await seriousViolations(page)).some(line => line.startsWith('button-name: ') && line.includes('data-g14-seed'))).toBe(true)
})

test('local runtimes require a context size in the model picker and starting waits until it is valid', async ({ page }) => {
  const fixture = createSessionFeaturesFixture({ connections: [fixtureConnection(FIXTURE_LOCAL_CONNECTION, 'Local Ollama', 'local_runtime')] })
  await open(page, fixture)
  await chooseProject(page, 'Beta')
  await prompt(page).fill('Inspect')
  await chooseModel(page, 'llama')
  await expect(page.getByRole('button', { name: 'Local Ollama' })).toHaveAttribute('aria-pressed', 'true') // the only connection is preselected
  await expect(start(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(page.locator('#new-session-needs')).toHaveText('Set the context window in the model picker.')
  await page.getByLabel('Context window, tokens').fill('0')
  await expect(page.getByLabel('Context window, tokens')).toHaveAttribute('aria-invalid', 'true')
  await expect(start(page)).toHaveAttribute('aria-disabled', 'true')
  await page.getByLabel('Context window, tokens').fill('8192')
  await expect(start(page)).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await start(page).click()
  await expect(page).toHaveURL(/\/agent\/session-1$/u)
  expect(fixture.requests.create).toHaveLength(1)
  expect(fixture.requests.create[0]).toMatchObject({ connectionId: FIXTURE_LOCAL_CONNECTION, contextTokens: 8192 })
})

test('a new session opens in the most recent project, which persists per browser and is never duplicated', async ({ page }) => {
  // The started session belongs to Beta, as the node would report; opening it keeps Beta current (P2).
  const fixture = createSessionFeaturesFixture({ progress: { 'session-1': { ...completedProgress('session-1'), projectId: 'q' } } })
  await open(page, fixture)
  await expect(page.getByRole('button', { name: 'Choose a project' })).toHaveCount(1)
  await chooseProject(page, 'Beta')
  await prompt(page).fill('Inspect')
  await chooseModel(page, 'fixture')
  await page.keyboard.press('Escape')
  await start(page).click()
  await expect(page).toHaveURL(/\/agent\/session-1$/u)
  await page.goto('/agent')
  await expect(page.getByRole('button', { name: 'Project: Beta' })).toHaveCount(1)
  await expect(page.getByText('Project folders: 1', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Project: Beta' }).click()
  const items = page.getByRole('menuitem')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('Beta')
  await page.keyboard.press('Escape')
  // A deleted project drops out instead of showing a dead entry; the only remaining project is current.
  fixture.projects = [fixtureProject('p', 'Alpha')]
  await page.reload()
  await expect(page.getByRole('button', { name: 'Project: Alpha' })).toHaveCount(1)
  await expect(page.getByText('Beta')).toHaveCount(0)
})

test('phone width (320 px) and large text keep the screen inside the viewport with 24 px targets, even with long names', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  const longProject = 'A very long project name that keeps going and going without any break at all'
  const fixture = createSessionFeaturesFixture({
    projects: [fixtureProject('p', 'Alpha'), fixtureProject('long', longProject, ['w1'])],
    workspaces: [fixtureWorkspace('w1', 'workspace-name-without-any-spaces-that-is-really-quite-long-indeed'), fixtureWorkspace('w2', 'Docs')],
  })
  await page.addInitScript(() => localStorage.setItem('guanxi.newSession.recentProjects.v1', JSON.stringify(['long', 'p'])))
  await open(page, fixture)
  await expect(form(page)).toBeVisible()
  await expect(page.getByRole('button', { name: `Project: ${longProject}` })).toHaveCount(1)
  const check = async (label: string) => {
    const overflow = await page.evaluate(() => {
      const host = document.querySelector('[data-slot="shell-route-host"]')
      return { document: document.documentElement.scrollWidth - innerWidth, host: host ? host.scrollWidth - host.clientWidth : 0 }
    })
    expect(overflow.document, `${label} document overflow`).toBeLessThanOrEqual(0)
    expect(overflow.host, `${label} route host overflow`).toBeLessThanOrEqual(1)
    const small = await page.locator('main, [data-slot="popover-content"]').locator('button, select, input:not([type="checkbox"]), textarea').evaluateAll(
      elements => elements.filter(element => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && (box.height < 24 || box.width < 24)
      }).map(element => `${element.tagName} ${element.textContent?.trim().slice(0, 20)} ${Math.round(element.getBoundingClientRect().height)}`))
    expect(small, `${label} targets under 24 px`).toEqual([])
    const outside = await page.locator('main, [data-slot="popover-content"]').locator('button, select, textarea, input').evaluateAll(
      elements => elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1).length)
    expect(outside, `${label} controls past the right edge`).toBe(0)
  }
  await check('phone 320')
  await page.getByRole('button', { name: 'Run options' }).click()
  await check('phone 320 with run options open')
  await page.keyboard.press('Escape')
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await check('phone 320 at 200% text')
  expect(await seriousViolations(page), 'phone at 200% text').toEqual([])
})
test('reduced motion: nothing animates on the screen, and the skeleton is static', async ({ page }) => {
  let release!: () => void
  const fixture = createSessionFeaturesFixture({ holdProjects: new Promise<void>(resolve => { release = resolve }) })
  await open(page, fixture)
  await expect(page.getByTestId('new-session-skeleton')).toHaveCount(1)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0)
  release()
  await expect(form(page)).toBeVisible()
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0)
})
