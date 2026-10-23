/**
 * W1 native session as a message timeline (D-207) and side chat as a toggled side panel. The
 * mock node serves progress plus the session log, so the page builds its turns from prompt and
 * assistant.message events exactly as against a real node.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { completedProgress, createSessionFeaturesFixture, installSessionFeaturesApi, sessionEvent } from './fixtures/session-features-api.ts'

const answer = 'Pinned `libvips` in the **CI image**.\n\n- Reproduced the failure\n- Re-ran the job'
const running = {
  ...completedProgress('s1', answer), status: 'running',
  plan: [{ text: 'Reproduce', status: 'verification_requested' }, { text: 'Pin libvips', status: 'active' }, { text: 'Open a PR', status: 'pending' }],
  queue: [{ id: 'q1', text: 'Also check macOS' }, { id: 'q2', text: 'Update the CHANGELOG' }],
}
const events = [
  sessionEvent('s1', 1, 'prompt', 'Why does the `nightly` build fail?'),
  sessionEvent('s1', 2, 'assistant.message', answer),
]

async function open(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme })
  const fixture = createSessionFeaturesFixture({ theme, progress: { s1: running }, events: { s1: events }, titles: { s1: 'Fix the nightly build' } })
  await installSessionFeaturesApi(page, fixture)
  await page.goto('/agent/s1')
  await expect(page.getByRole('heading', { level: 1, name: 'Fix the nightly build' })).toBeVisible()
  await expect(page.getByTestId('native-message')).toHaveCount(2)
  return fixture
}
async function serious(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical').flatMap(item => item.nodes.map(node => `${item.id}: ${node.target.join(' ')}`))
}

test('turns render markdown with exact counts; plan and queue are flat divider lists with no nested bordered box', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await open(page)
  const bodies = page.locator('.native-message-body')
  await expect(bodies).toHaveCount(2)
  for (const text of await bodies.allTextContents()) expect(text).not.toMatch(/[`*]/u)
  await expect(page.locator('.native-message[data-role="agent"] code')).toHaveCount(1)
  await expect(page.locator('.native-message[data-role="agent"] li')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Session progress' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Session location' }).getByRole('link', { name: 'Alpha', exact: true })).toHaveCount(1)
  // Rows: plan 3 + queue 2, each a list row; no box with a border on all four sides inside the status block.
  await expect(page.locator('.native-list > li')).toHaveCount(5)
  const boxes = await page.locator('.native-progress').evaluate(root => {
    const framed = (element: Element) => { const style = getComputedStyle(element); return ['Top', 'Right', 'Bottom', 'Left'].every(side => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none') }
    const all = [root, ...root.querySelectorAll('*')].filter(element => !element.closest('button, [role="alert"]'))
    const rows = [...root.querySelectorAll('.native-list > li')].map(row => { const style = getComputedStyle(row); return [style.borderLeftWidth, style.borderRightWidth, style.borderBottomWidth].every(width => parseFloat(width) === 0) })
    return { framed: all.filter(framed).map(element => element.className), rowsOnlyTopHairline: rows.every(Boolean) }
  })
  expect(boxes).toEqual({ framed: [], rowsOnlyTopHairline: true })
  // Stop is an icon button beside Send in the composer, with a filled square.
  const stop = page.getByRole('button', { name: 'Stop session', exact: true })
  await expect(stop).toHaveCount(1)
  expect(await stop.evaluate(node => ({ inComposer: node.closest('[data-slot="composer"]') !== null, filled: getComputedStyle(node.querySelector('svg')!).fill !== 'none' }))).toEqual({ inComposer: true, filled: true })
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test('side chat opens as a panel beside the session with a one-line description, by keyboard, and Escape returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page)
  const toggle = page.getByRole('button', { name: 'Side chat', exact: true })
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Ask about this session')).toBeFocused()
  const geometry = await page.evaluate(() => {
    const main = document.querySelector('.native-session-main')!.getBoundingClientRect()
    const aside = document.querySelector('.native-session-aside')!.getBoundingClientRect()
    const notice = document.querySelector('[data-testid="side-chat-notice"]') as HTMLElement
    const line = parseFloat(getComputedStyle(notice).lineHeight)
    return { besideMain: aside.left >= main.right - 1, asideWidth: Math.round(aside.width), noticeLines: Math.round(notice.getBoundingClientRect().height / line) }
  })
  expect(geometry).toEqual({ besideMain: true, asideWidth: 384, noticeLines: 1 })
  await expect(page.getByTestId('side-chat-panel').getByRole('radiogroup', { name: 'Context from the session' })).toHaveCount(1)
  await expect(page.getByTestId('side-chat-panel').locator('select')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('side-chat-panel')).toBeHidden()
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('phone: the panel covers the session without horizontal scroll, and nothing moves under reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Side chat', exact: true }).click()
  await expect(page.getByTestId('side-chat-panel')).toBeVisible()
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0)
  // A full-screen sheet: its header and its ask box are both in view without scrolling the page.
  const cover = await page.evaluate(() => {
    const aside = document.querySelector('.native-session-aside')!.getBoundingClientRect()
    const header = document.querySelector('.side-chat-header')!.getBoundingClientRect()
    const ask = document.querySelector('.side-chat-ask')!.getBoundingClientRect()
    return { left: Math.round(aside.left), width: Math.round(aside.width - innerWidth), height: Math.round(aside.height - innerHeight),
      headerInView: header.top >= 0, askInView: ask.bottom <= innerHeight + 1, scroll: document.documentElement.scrollWidth <= innerWidth }
  })
  expect(cover).toEqual({ left: 0, width: 0, height: 0, headerInView: true, askInView: true, scroll: true })
  await page.getByRole('button', { name: 'Close side chat', exact: true }).click()
  await expect(page.getByTestId('side-chat-panel')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Side chat', exact: true })).toBeFocused()
})

test('the session, its message details and the open panel have no serious axe finding in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page, theme)
    expect(await serious(page), `${theme} timeline`).toEqual([])
    await page.locator('.native-message[data-role="agent"]').getByRole('button', { name: 'Message details', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Message details' })).toHaveCount(1)
    expect(await serious(page), `${theme} details`).toEqual([])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Side chat', exact: true }).click()
    await expect(page.getByTestId('side-chat-panel')).toBeVisible()
    expect(await serious(page), `${theme} side chat`).toEqual([])
  }
})
