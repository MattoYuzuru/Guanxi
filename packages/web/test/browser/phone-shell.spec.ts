/**
 * Visual pass, item 4: on a phone the navigation is a drawer over an inert page, the status strip
 * collapses into one overflow control, and a touch screen shows no ⌘K keycaps.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { completedProgress, createSessionFeaturesFixture, installSessionFeaturesApi, nativeSession, sessionEvent } from './fixtures/session-features-api.ts'

test.use({ viewport: { width: 400, height: 860 }, hasTouch: true, isMobile: true })

async function open(page: Page, theme: 'light' | 'dark' = 'light') {
  const fixture = createSessionFeaturesFixture({ theme, sessions: [nativeSession('s1', 'Fix the nightly build', 'working', 4)], progress: { s1: completedProgress('s1') } })
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto('/agent/s1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

test('D-207 on a phone: the composer stays docked and the status bar stays in view through a long timeline (P2)', async ({ page }) => {
  const events = Array.from({ length: 40 }, (_, index) => sessionEvent('s1', index + 1, index % 2 === 0 ? 'prompt' : 'assistant.message',
    `${index % 2 === 0 ? 'Question' : 'Answer'} ${index + 1}: ${'a line of text that wraps on a phone '.repeat(3)}`))
  const running = { ...completedProgress('s1'), status: 'running' as const }
  const fixture = createSessionFeaturesFixture({ sessions: [nativeSession('s1', 'Fix the nightly build', 'working', 40)], progress: { s1: running }, events: { s1: events }, titles: { s1: 'Fix the nightly build' } })
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/agent/s1')
  await expect(page.getByText(/^Answer 40:/u)).toBeAttached()
  const inView = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    return box!.y >= 0 && box!.y + box!.height <= 860 + 0.5
  }
  const composer = page.getByRole('textbox', { name: /Queue prompt|Ask the agent|What should/u })
  for (const where of ['top', 'bottom'] as const) {
    // Scroll the timeline the way a finger would: whatever scrolls, the page or the timeline.
    await page.mouse.move(200, 400)
    await page.mouse.wheel(0, where === 'bottom' ? 20_000 : -20_000)
    await page.evaluate((to) => { for (const node of document.querySelectorAll('*')) { const element = node as HTMLElement; if (element.scrollHeight > element.clientHeight + 1) element.scrollTop = to === 'bottom' ? element.scrollHeight : 0 } window.scrollTo(0, to === 'bottom' ? document.body.scrollHeight : 0) }, where)
    await expect(composer).toBeVisible()
    expect(await inView('[data-slot="app-shell-status"]'), `status bar after scrolling to the ${where}`).toBe(true)
    const box = await composer.boundingBox()
    expect(box!.y + box!.height, `composer after scrolling to the ${where}`).toBeLessThanOrEqual(860)
    expect(box!.y).toBeGreaterThan(430)
  }
  // The document itself does not scroll: the timeline scrolls inside the pane.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true)
})

test('the phone strip is one row: navigation toggle, breadcrumb, one overflow and the search icon', async ({ page }) => {
  await open(page)
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Status and settings' })).toHaveCount(1)
  for (const name of [/^This device/u, /^Memory/u, /^Runtime/u, /^Customise$/u]) await expect(page.getByRole('button', { name })).toHaveCount(0)
  const palette = page.getByRole('button', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await expect(palette.locator('kbd:visible')).toHaveCount(0)
  const strip = await page.locator('[data-slot="app-shell-status"]').boundingBox()
  expect(strip!.height).toBeLessThanOrEqual(56)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.getByRole('button', { name: 'Status and settings' }).click()
  const overflow = page.locator('[data-slot="app-shell-overflow"]')
  await expect(overflow).toBeVisible()
  for (const name of [/^This device/u, /^Memory/u, /^Runtime/u, /^Customise$/u]) await expect(overflow.getByRole('button', { name })).toHaveCount(1)
  // No hover on a touch screen: each item shows its label as text, and no tooltip appears (P3).
  for (const label of ['This device', 'Memory', 'Runtime', 'Customise']) await expect(overflow.getByText(label, { exact: true })).toBeVisible()
  await overflow.getByRole('button', { name: /^Memory/u }).hover()
  await page.waitForTimeout(700)
  await expect(page.locator('[data-slot="tooltip-content"]:visible')).toHaveCount(0)
  const box = await overflow.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(400)
})

test('the navigation drawer opens over an inert page, traps nothing behind it and closes on Escape or a followed link', async ({ page }) => {
  await open(page)
  const toggle = page.getByRole('button', { name: 'Open navigation' })
  await toggle.click()
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(navigation).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-slot="app-shell-scrim"]')).toHaveCount(1)
  expect(await page.locator('[data-slot="app-shell-main"]').evaluate(node => (node as HTMLElement).inert)).toBe(true)
  const drawer = await page.locator('[data-slot="app-shell-sidebar"]').boundingBox()
  expect(drawer!.x).toBe(0)
  expect(drawer!.width).toBeLessThanOrEqual(400)
  expect(drawer!.height).toBeGreaterThanOrEqual(800)
  expect(await page.evaluate(() => document.activeElement?.closest('[data-slot="app-shell-sidebar"]') !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(navigation).toHaveCount(0)
  await expect(toggle).toBeFocused()
  expect(await page.locator('[data-slot="app-shell-main"]').evaluate(node => (node as HTMLElement).inert)).toBe(false)

  await toggle.click()
  await page.locator('[data-slot="app-shell-scrim"]').click({ position: { x: 380, y: 400 } })
  await expect(navigation).toHaveCount(0)

  await toggle.click()
  await navigation.getByRole('link', { name: 'Projects', exact: true }).click()
  await expect(page).toHaveURL(/\/projects$/u)
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0)
})

for (const theme of ['light', 'dark'] as const) {
  test(`the phone shell, its drawer and its overflow have no axe violations (${theme})`, async ({ page }) => {
    await open(page, theme)
    expect((await new AxeBuilder({ page }).analyze()).violations.map(violation => violation.id)).toEqual([])
    await page.getByRole('button', { name: 'Open navigation' }).click()
    expect((await new AxeBuilder({ page }).analyze()).violations.map(violation => violation.id)).toEqual([])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Status and settings' }).click()
    await expect(page.locator('[data-slot="app-shell-overflow"]')).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations.map(violation => violation.id)).toEqual([])
  })
}

test.describe('status popovers over the page', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false })
  for (const theme of ['light', 'dark'] as const) {
    test(`the memory popover and its source footnote pass axe colour contrast (${theme})`, async ({ page }) => {
      await open(page, theme)
      await page.getByRole('button', { name: /^Memory/u }).click()
      const footnote = page.locator('.gx-popover-footnote:visible')
      await expect(footnote).toHaveCount(1)
      const results = await new AxeBuilder({ page }).include('.gx-popover').withRules(['color-contrast']).analyze()
      expect(results.violations.flatMap(violation => violation.nodes.map(node => node.target.join(' ')))).toEqual([])
    })
  }
})
