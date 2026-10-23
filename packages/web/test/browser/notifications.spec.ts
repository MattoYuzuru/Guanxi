/**
 * NC1 notification center (ADR-0033): the bell in the status strip, the center, keyboard and
 * focus, the live region, offline, and accessibility at phone width with large text, in both
 * themes and both locales. The node is an in-memory implementation of the MS2 REST contract.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { FakeNode, demoRows, installNotificationsApi } from './fixtures/notifications-api.ts'
import { allWireAvailable, notification, notificationId } from '../fixtures/notifications-server.ts'
import { choosePaletteCommand } from './fixtures/shell-navigation.ts'

async function open(page: Page, node: FakeNode, options: { locale?: 'en' | 'ru'; theme?: 'light' | 'dark'; path?: string } = {}) {
  const fixture = await installNotificationsApi(page, node, { locale: options.locale ?? 'en', theme: options.theme ?? 'light' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(options.path ?? '/agent')
  return fixture
}
const bell = (page: Page) => page.getByTestId('notification-bell')
const rows = (page: Page) => page.getByTestId('notification-row')
const rowOf = (page: Page, n: number) => page.locator(`[data-notification-id="${notificationId(n)}"]`)

/** Serious and critical violations only, as `rule: target` lines. */
async function seriousViolations(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'))
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`))
}

test('bell to center: the strip shows the unread count, a click opens the center on its heading, and the count equals the rows', async ({ page }) => {
  const node = new FakeNode(demoRows())
  await open(page, node)
  await expect(page.getByTestId('notification-bell-count')).toHaveText('3 unread')
  await expect(bell(page)).toHaveAttribute('data-unread', '3')
  // The bell lives in the status strip's Inbox item, between its name and nothing else.
  await expect(page.locator('dl').getByText('Inbox', { exact: true })).toHaveCount(1)
  await bell(page).click()
  await expect(page).toHaveURL(/\/notifications$/u)
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeFocused()
  await expect(bell(page)).toHaveAttribute('aria-current', 'page')
  await expect(rows(page)).toHaveCount(3)
  expect(node.count(/^GET \/api\/notifications$/u)).toBeGreaterThanOrEqual(1)
  // Exactly the severities of the unread rows, each as text.
  await expect(page.getByTestId('notification-severity')).toHaveText(['▲Critical', '●Info', '◆Warning'])
})

test('the palette reaches the center too', async ({ page }) => {
  await open(page, new FakeNode(demoRows()))
  await choosePaletteCommand(page, 'Notifications')
  await expect(page).toHaveURL(/\/notifications$/u)
  await expect(rows(page)).toHaveCount(3)
})

test('keyboard alone: tab to the bell, open the center, snooze a row from the keyboard, and focus lands on a live control', async ({ page }) => {
  const node = new FakeNode(demoRows())
  await open(page, node)
  await expect(page.getByTestId('notification-bell-count')).toHaveText('3 unread')
  await bell(page).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeFocused()
  await expect(rows(page)).toHaveCount(3)
  // Filters come first in the tab order (there is no Refresh button, D-203), then the first row's controls.
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
  for (const name of ['Unread', 'All', 'Read', 'Snoozed', 'Acted on']) {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name, exact: true })).toBeFocused()
  }
  const first = rows(page).first()
  await page.keyboard.press('Tab')
  await expect(first.getByRole('button', { name: 'Mark read' })).toBeFocused()
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!)
    return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'
  })
  expect(ring, 'visible focus ring').toBe(true)
  await page.keyboard.press('Tab')
  await expect(first.getByRole('button', { name: 'Open' })).toBeFocused()
  // Snooze with Enter, Escape returns, Enter again and a preset by keyboard.
  const snooze = first.getByRole('button', { name: 'Snooze…' })
  await snooze.focus()
  await page.keyboard.press('Enter')
  await expect(first.getByRole('button', { name: 'In 1 hour' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(first.getByTestId('snooze-form')).toHaveCount(0)
  await expect(snooze).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter') // activates the focused first preset
  await expect(page.getByTestId('notifications-status')).toContainText('Snoozed until')
  await expect(rows(page)).toHaveCount(2)
  await expect(page.getByTestId('notification-bell-count')).toHaveText('2 unread')
  // The row that held focus left the list; focus moved to a row, not to the page body.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('notification-row')
  expect(node.count(/^POST .*\/snooze$/u)).toBe(1)
})

test('Mark read from the keyboard changes the count in the strip, announces once, and keeps focus on a row', async ({ page }) => {
  const node = new FakeNode(demoRows())
  await open(page, node, { path: '/notifications' })
  await expect(rows(page)).toHaveCount(3)
  await rowOf(page, 3).getByRole('button', { name: 'Mark read' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('notifications-status')).toHaveText('Marked read.')
  await expect(page.getByTestId('notification-bell-count')).toHaveText('2 unread')
  await expect(rows(page)).toHaveCount(2)
  await expect(rows(page).first()).toBeFocused()
  expect(node.count(/^POST .*\/read$/u)).toBe(1)
})

test('new arrivals are announced politely in the strip, once, and a second identical read adds nothing', async ({ page }) => {
  const node = new FakeNode(demoRows())
  await open(page, node)
  await expect(page.getByTestId('notification-bell-count')).toHaveText('3 unread')
  const live = page.getByTestId('notification-live')
  await expect(live).toHaveAttribute('aria-live', 'polite')
  await expect(live).toHaveText('')
  node.rows.push(notification(6))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(live).toHaveText('1 new notification. 4 unread')
  await expect(page.getByTestId('notification-bell-count')).toHaveText('4 unread')
  const reads = node.count(/^GET \/api\/notifications$/u)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => node.count(/^GET \/api\/notifications$/u)).toBeGreaterThan(reads)
  await expect(live).toHaveText('1 new notification. 4 unread')
})

test('an action the node cannot run is shown disabled with its reason; the shipped node runs Open and Snooze only', async ({ page }) => {
  const node = new FakeNode(demoRows())
  await open(page, node, { path: '/notifications' })
  const row = rowOf(page, 1)
  await expect(row.getByRole('button', { name: 'Open' })).toBeEnabled()
  await expect(row.getByRole('button', { name: 'Wake leads' })).toBeDisabled()
  await expect(row.getByRole('button', { name: 'Wake leads' })).toHaveAccessibleDescription(/not_configured/u)
  await expect(row.getByTestId('notification-reasons')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Snooze…' })).toBeEnabled()
  // Nothing was sent for the disabled ones.
  expect(node.count(/^POST /u)).toBe(0)
})

test('an available action runs once with its key; a lost answer is repeated from its own button with the same key and the effect still happens once', async ({ page }) => {
  const node = new FakeNode(demoRows(), allWireAvailable())
  await open(page, node, { path: '/notifications' })
  const row = rowOf(page, 1)
  await expect(row.getByRole('button', { name: 'Pause runs' })).toBeEnabled()
  node.failNext(/^POST .*\/actions$/u, 'lose')
  await row.getByRole('button', { name: 'Pause runs' }).click()
  await expect(row.getByTestId('notification-failure')).toContainText('reuses the same request key')
  // The failed action keeps its own button (same key while the outcome is unknown); no Try again.
  await expect(row.getByTestId('notification-failure').getByRole('button', { name: /try again|retry/iu })).toHaveCount(0)
  await row.getByRole('button', { name: 'Pause runs' }).click()
  await expect(page.getByTestId('notifications-status')).toContainText('had already been done')
  const posts = node.requests.filter((record) => record.method === 'POST')
  expect(posts.map((record) => record.idempotencyKey)).toHaveLength(2)
  expect(posts[0]!.idempotencyKey).toBe(posts[1]!.idempotencyKey)
  expect(posts[0]!.idempotencyKey).toMatch(/^[0-9a-f]{32}$/u)
  expect(node.effects['pause_runs']).toBe(1)
  await expect(page.getByTestId('notification-bell-count')).toHaveText('2 unread')
})

test('Open goes to where the connection lives', async ({ page }) => {
  const node = new FakeNode(demoRows())
  await open(page, node, { path: '/notifications' })
  await rowOf(page, 1).getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/settings$/u)
  await expect(page.getByTestId('notification-bell-count')).toHaveText('2 unread')
})

test('offline: the strip and the center keep the last known data with its age, actions are disabled with the reason, and it recovers', async ({ page }) => {
  const node = new FakeNode(demoRows(), allWireAvailable())
  await open(page, node, { path: '/notifications' })
  await expect(rows(page)).toHaveCount(3)
  await expect(rowOf(page, 1).getByRole('button', { name: 'Pause runs' })).toBeEnabled()
  node.unreachable = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const banner = page.getByTestId('notifications-offline')
  await expect(banner).toContainText('Offline: the node is unreachable (node_unreachable).')
  await expect(banner).toContainText(/Showing the last known notifications as of .+, .+ ago|Showing the last known notifications as of .+, just now/u)
  await expect(rows(page)).toHaveCount(3)
  await expect(page.getByTestId('notification-bell-count')).toContainText('last known')
  await expect(page.getByTestId('notification-bell')).toHaveAttribute('aria-label', /last known/u)
  for (const button of await rowOf(page, 1).getByRole('button').all()) await expect(button).toBeDisabled()
  await expect(rowOf(page, 1).getByRole('button', { name: 'Pause runs' })).toHaveAccessibleDescription(/^Offline: actions need the node\./u)
  expect(node.count(/^POST /u)).toBe(0)
  node.unreachable = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(banner).toHaveCount(0)
  await expect(rowOf(page, 1).getByRole('button', { name: 'Pause runs' })).toBeEnabled()
})

test('the browser\'s offline event re-reads the node at once; the state follows the node\'s answer, not the flag', async ({ page, context }) => {
  const node = new FakeNode(demoRows())
  await open(page, node, { path: '/notifications' })
  await expect(rows(page)).toHaveCount(3)
  let reads = node.count(/^GET \/api\/notifications$/u)
  // A reachable loopback node keeps answering with the network off: no banner, actions stay on.
  await context.setOffline(true)
  await expect.poll(() => node.count(/^GET \/api\/notifications$/u)).toBeGreaterThan(reads)
  await expect(page.getByTestId('notifications-offline')).toHaveCount(0)
  await expect(rowOf(page, 1).getByRole('button', { name: 'Mark read' })).toBeEnabled()
  // When the node does not answer, the offline event surfaces it by itself.
  node.unreachable = true
  reads = node.count(/^GET \/api\/notifications$/u)
  await context.setOffline(false)
  await context.setOffline(true)
  await expect(page.getByTestId('notifications-offline')).toBeVisible()
  await expect(rowOf(page, 1).getByRole('button', { name: 'Mark read' })).toBeDisabled()
  await context.setOffline(false)
})

test('reduced motion: nothing animates in the center or the strip', async ({ page }) => {
  await open(page, new FakeNode(demoRows()), { path: '/notifications' })
  await expect(rows(page)).toHaveCount(3)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0)
})

/** Phone width and 200% text, in each theme and locale: no overflow, 24 px targets, axe clean. */
for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en', 'ru'] as const) {
    test(`phone 320 px at 200% text, ${theme} theme, ${locale}: contained, reachable, 0 serious or critical axe violations`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 })
      const node = new FakeNode([...demoRows(), notification(6, { subject: { type: 'connection', id: 'a-connection-with-a-very-long-identifier-that-has-no-break-points-at-all' }, facts: { source: 'a.very.long.source.identifier.that.keeps.going.and.going.without.spaces' } })], allWireAvailable())
      await open(page, node, { locale, theme, path: '/notifications' })
      await page.getByRole('button', { name: locale === 'en' ? 'All' : 'Все' }).click()
      await expect(rows(page)).toHaveCount(6)
      const check = async (label: string) => {
        const overflow = await page.evaluate(() => {
          const host = document.querySelector('[data-slot="shell-route-host"]')
          return { document: document.documentElement.scrollWidth - innerWidth, host: host ? host.scrollWidth - host.clientWidth : 0 }
        })
        expect(overflow.document, `${label}: document overflow`).toBeLessThanOrEqual(0)
        expect(overflow.host, `${label}: route host overflow`).toBeLessThanOrEqual(1)
        const small = await page.locator('main').locator('button, select, input, summary').evaluateAll((elements) => elements
          .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 24 || box.width < 24) })
          .map((element) => `${element.tagName} ${element.textContent?.trim().slice(0, 20)}`))
        expect(small, `${label}: targets under 24 px`).toEqual([])
        const outside = await page.locator('main').locator('button, select, input').evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().right > innerWidth + 1).length)
        expect(outside, `${label}: controls past the right edge`).toBe(0)
      }
      await check('320 px')
      expect(await seriousViolations(page), 'populated, 320 px').toEqual([])
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
      await check('320 px at 200% text')
      expect(await seriousViolations(page), 'populated, 200% text').toEqual([])
      // With a snooze form open.
      await rowOf(page, 1).getByRole('button', { name: locale === 'en' ? 'Snooze…' : 'Отложить…' }).click()
      await expect(rowOf(page, 1).getByTestId('snooze-form')).toBeVisible()
      await check('snooze form open')
      expect(await seriousViolations(page), 'snooze form, 200% text').toEqual([])
      // The status strip with the bell holds up at the same size.
      await expect(bell(page)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    })

    test(`states are accessible at phone width, ${theme} theme, ${locale}: loading, empty, error, offline`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 })
      await page.addInitScript(() => { document.documentElement.style.fontSize = '200%' })
      const node = new FakeNode([])
      await open(page, node, { locale, theme, path: '/notifications' })
      await expect(page.getByTestId('notifications-empty')).toBeVisible()
      expect(await seriousViolations(page), 'empty').toEqual([])
      // Error.
      node.failNext(/^GET \/api\/notifications$/u, { status: 503, body: { code: 'notifications_unavailable' } })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByTestId('notifications-stale')).toBeVisible()
      expect(await seriousViolations(page), 'stale error').toEqual([])
      // Offline.
      node.unreachable = true
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByTestId('notifications-offline')).toBeVisible()
      expect(await seriousViolations(page), 'offline').toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    })
  }
}

test('a first-load error is accessible too', async ({ page }) => {
  const node = new FakeNode(demoRows())
  const restore = node.failWhile(/^GET \/api\/notifications$/u, { status: 500, body: { code: 'internal_error' } })
  await page.setViewportSize({ width: 320, height: 800 })
  await open(page, node, { path: '/notifications' })
  await expect(page.getByTestId('notifications-error')).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])
  await expect(page.getByRole('button', { name: /^(Try again|Refresh)$/u })).toHaveCount(0)
  restore()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(rows(page)).toHaveCount(3)
})

test('desktop width is clean as well', async ({ page }) => {
  await open(page, new FakeNode(demoRows(), allWireAvailable()), { path: '/notifications' })
  await expect(rows(page)).toHaveCount(3)
  expect(await seriousViolations(page)).toEqual([])
})
