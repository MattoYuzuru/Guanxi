/**
 * U1 new-session screen (LAYOUT_AND_SCREENS E1): keyboard flow, screen-reader structure, every
 * state (loading, empty, error, offline, degraded, start failure), both themes and locales,
 * phone width and large text. Counts are exact: one request per action, one alert per failure.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  FIXTURE_CONNECTION, FIXTURE_LOCAL_CONNECTION, completedProgress, createSessionFeaturesFixture, fixtureConnection,
  fixtureProject, installSessionFeaturesApi, type SessionFeaturesFixture,
} from './fixtures/session-features-api.ts'

async function open(page: Page, fixture: SessionFeaturesFixture, path = '/agent') {
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
}
const form = (page: Page, name = 'New session') => page.getByRole('form', { name, exact: true })

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
  await expect(page.getByRole('heading', { level: 1, name: 'New session' })).toHaveCount(1)

  const focused = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    if (!element) return null
    const label = element.getAttribute('aria-label') ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? element.textContent
    const style = getComputedStyle(element)
    const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none'
    return { label: (label ?? '').trim(), ring }
  })
  await page.getByLabel('Project', { exact: true }).focus()
  expect(await focused()).toEqual({ label: 'Project', ring: true })
  await page.keyboard.type('A') // type-ahead picks "Alpha"; arrow keys open the popup on macOS
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('p')

  const order: string[] = []
  const expected = ['What should the agent do?', 'Connection', 'Model ID', 'Access mode', 'Run options']
  for (let step = 0; step < expected.length; step++) {
    await page.keyboard.press('Tab')
    const state = await focused()
    expect(state?.ring, `focus ring on ${state?.label}`).toBe(true)
    order.push(state?.label ?? '')
    if (state?.label === 'What should the agent do?') await page.keyboard.type('Inspect the repository')
    if (state?.label === 'Connection') await page.keyboard.type('F')
    if (state?.label === 'Model ID') await page.keyboard.type('fixture')
  }
  expect(order).toEqual(expected)
  // Enter opens the disclosure from the keyboard; Tab then reaches the Start button last.
  await expect(form(page).locator('details')).not.toHaveAttribute('open', '')
  await page.keyboard.press('Enter')
  await expect(form(page).locator('details')).toHaveAttribute('open', '')
  await page.keyboard.press('Enter')
  await expect(form(page).locator('details')).not.toHaveAttribute('open', '')
  await page.keyboard.press('Tab')
  expect(await focused()).toEqual({ label: 'Start session', ring: true })
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled()

  await page.getByLabel('What should the agent do?').focus()
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Second line')
  await expect(page.getByLabel('What should the agent do?')).toHaveValue('Inspect the repository\nSecond line')
  expect(fixture.requests.create).toHaveLength(0)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/agent\/session-1$/u)
  await expect(page.getByText('Fixture response', { exact: true })).toHaveCount(1)
  expect(fixture.requests.create).toEqual([{
    projectId: 'p', connectionId: FIXTURE_CONNECTION, model: 'fixture', mode: 'read-only', prompt: 'Inspect the repository\nSecond line',
    retention: 'ttl', domains: [], attachmentIds: [], protectedPaths: [],
  }])
})

test('screen-reader structure: landmarks, names, descriptions and one live status', async ({ page }) => {
  await open(page, createSessionFeaturesFixture())
  await expect(form(page)).toBeVisible()
  await expect(form(page)).toMatchAriaSnapshot(`
    - form "New session":
      - combobox "Project"
      - paragraph: /A project can have no folder/
      - textbox "What should the agent do?"
      - paragraph: /Enter starts the session/
      - combobox "Connection"
      - textbox "Model ID"
      - combobox "Access mode"
      - group: Run options
      - paragraph: "Still needed to start:"
      - list:
        - listitem: Choose a project.
        - listitem: Choose a model connection.
        - listitem: Enter a model ID.
        - listitem: Describe the task.
      - button "Start session" [disabled]
      - status
  `)
  // Every control has a programmatic name and a description that contains its hint.
  const unnamed = await form(page).locator('input, select, textarea, button, summary').evaluateAll(
    elements => elements.filter(element => {
      const control = element as HTMLInputElement
      return !(control.getAttribute('aria-label') || control.labels?.length || control.textContent?.trim())
    }).length)
  expect(unnamed).toBe(0)
  await expect(page.getByLabel('Project', { exact: true })).toHaveAccessibleDescription(/A project can have no folder/u)
  await expect(page.getByLabel('Model ID')).toHaveAccessibleDescription(/exact model ID/u)
  await expect(page.getByRole('button', { name: 'Start session' })).toHaveAccessibleDescription(/Still needed to start/u)
  await expect(form(page).getByRole('status')).toHaveCount(1) // the form's own start status, empty until a start is in flight
})

test('every state has no critical or serious axe finding, in both themes and both locales', async ({ page }) => {
  for (const { locale, theme } of [{ locale: 'en', theme: 'light' }, { locale: 'en', theme: 'dark' }, { locale: 'ru', theme: 'light' }, { locale: 'ru', theme: 'dark' }] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    const fixture = createSessionFeaturesFixture({ locale, theme })
    await open(page, fixture)
    const name = locale === 'en' ? 'New session' : 'Новая сессия'
    await expect(form(page, name)).toBeVisible()
    expect(await seriousViolations(page), `${locale}/${theme} ready`).toEqual([])
    await form(page, name).locator('details > summary').click()
    await page.getByLabel(locale === 'en' ? 'Access mode' : 'Режим доступа').selectOption('full-access')
    await page.getByLabel(locale === 'en' ? 'Network allowlist (comma-separated hosts)' : 'Разрешённые сетевые адреса (через запятую)').fill('localhost')
    await expect(page.getByRole('list', { name: locale === 'en' ? 'Changed options' : 'Изменённые параметры' })).toBeVisible()
    expect(await seriousViolations(page), `${locale}/${theme} run options, chips and invalid host`).toEqual([])
  }
})

test('loading, empty, error, offline and start-failure states are single, accessible and recoverable', async ({ page }) => {
  // Loading: a skeleton and one status, no form, until the held request is released.
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
  await page.getByLabel('Project', { exact: true }).selectOption('p')
  await page.getByLabel('What should the agent do?').fill('Inspect')
  await page.getByLabel('Connection').selectOption(FIXTURE_CONNECTION)
  await page.getByLabel('Model ID').fill('fixture')
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('The session could not be started')
  await expect(page.getByRole('alert')).toContainText('Another full-access session already uses one of these folders')
  expect(await page.evaluate(() => document.activeElement?.contains(document.querySelector('[role="alert"]')))).toBe(true)
  await expect(page.getByLabel('What should the agent do?')).toHaveValue('Inspect')
  expect(page.url()).toMatch(/\/agent$/u)
  expect(fixture.requests.create).toHaveLength(1)
  expect(await seriousViolations(page), 'start failure').toEqual([])

  // Offline: the node drops; Retry reaches it again. Exactly one alert, Start disabled.
  fixture.agentNetwork = 'down'
  await page.reload()
  await expect(page.locator('[data-state="node_unreachable"]')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByText('No choices were loaded before the connection dropped.', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled()
  expect(await seriousViolations(page), 'offline').toEqual([])
  fixture.agentNetwork = 'up'
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(form(page)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)

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

test('local runtimes require a context size and the form blocks starting until it is valid', async ({ page }) => {
  const fixture = createSessionFeaturesFixture({ connections: [fixtureConnection(FIXTURE_LOCAL_CONNECTION, 'Local Ollama', 'local_runtime')] })
  await open(page, fixture)
  await page.getByLabel('Project', { exact: true }).selectOption('q')
  await page.getByLabel('What should the agent do?').fill('Inspect')
  await page.getByLabel('Connection').selectOption(FIXTURE_LOCAL_CONNECTION)
  await page.getByLabel('Model ID').fill('llama')
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled()
  await expect(page.getByText('Set the local runtime context.', { exact: true })).toHaveCount(1)
  await form(page).locator('details > summary').click()
  await page.getByLabel('Local runtime context (tokens)').fill('0')
  await expect(page.getByLabel('Local runtime context (tokens)')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled()
  await page.getByLabel('Local runtime context (tokens)').fill('8192')
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page).toHaveURL(/\/agent\/session-1$/u)
  expect(fixture.requests.create).toHaveLength(1)
  expect(fixture.requests.create[0]).toMatchObject({ connectionId: FIXTURE_LOCAL_CONNECTION, contextTokens: 8192 })
})

test('recent projects persist per browser, are selectable and are never duplicated', async ({ page }) => {
  const fixture = createSessionFeaturesFixture({ progress: { 'session-1': completedProgress('session-1') } })
  await open(page, fixture)
  await expect(page.getByRole('region', { name: 'Recent projects' })).toHaveCount(0)
  await page.getByLabel('Project', { exact: true }).selectOption('q')
  await page.getByLabel('What should the agent do?').fill('Inspect')
  await page.getByLabel('Connection').selectOption(FIXTURE_CONNECTION)
  await page.getByLabel('Model ID').fill('fixture')
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page).toHaveURL(/\/agent\/session-1$/u)
  await page.goto('/agent')
  const recent = page.getByRole('region', { name: 'Recent projects' })
  await expect(recent.getByRole('button')).toHaveCount(1)
  await expect(recent.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'false')
  await recent.getByRole('button', { name: 'Beta' }).click()
  await expect(recent.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('q')
  await expect(page.getByText('Project folders: 1', { exact: true })).toHaveCount(1)
  // A deleted project drops out of the list instead of showing a dead entry.
  fixture.projects = [fixtureProject('p', 'Alpha')]
  await page.reload()
  await expect(page.getByRole('region', { name: 'Recent projects' })).toHaveCount(0)
})

test('phone width and large text keep the screen inside the viewport with 24 px targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const fixture = createSessionFeaturesFixture()
  await open(page, fixture)
  await expect(form(page)).toBeVisible()
  await form(page).locator('details > summary').click()
  const check = async (label: string) => {
    const overflow = await page.evaluate(() => {
      const host = document.querySelector('[data-slot="shell-route-host"]')
      return { document: document.documentElement.scrollWidth - innerWidth, host: host ? host.scrollWidth - host.clientWidth : 0 }
    })
    expect(overflow.document, `${label} document overflow`).toBeLessThanOrEqual(0)
    expect(overflow.host, `${label} route host overflow`).toBeLessThanOrEqual(1)
    const small = await form(page).locator('button, select, summary, input:not([type="checkbox"]), textarea').evaluateAll(
      elements => elements.filter(element => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && (box.height < 24 || box.width < 24)
      }).map(element => `${element.tagName} ${element.textContent?.trim().slice(0, 20)} ${Math.round(element.getBoundingClientRect().height)}`))
    expect(small, `${label} targets under 24 px`).toEqual([])
    const outside = await form(page).locator('select, textarea, input').evaluateAll(
      elements => elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1).length)
    expect(outside, `${label} controls past the right edge`).toBe(0)
  }
  await check('phone')
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await check('phone at 200% text')
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
