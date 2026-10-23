/**
 * Finished-unseen indicator through the mounted shell. The state is derived from the node's
 * durable session page (run state and log head) against heads this browser last showed, so
 * every assertion is an exact count of marked rows, and clearing is proven by opening a session.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { SEEN_SESSIONS_KEY } from '../../src/features/shell/seen.ts'
import { completedProgress, createSessionFeaturesFixture, installSessionFeaturesApi, nativeSession, type SessionFeaturesFixture } from './fixtures/session-features-api.ts'

const AFTER_BASELINE = '2026-10-23T10:00:00.000Z'
async function open(page: Page, fixture: SessionFeaturesFixture, path = '/projects', seed = true) {
  if (seed) await page.addInitScript(([key]) => {
    if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ baselineAt: '2026-10-23T08:00:00.000Z', seen: {} }))
  }, [SEEN_SESSIONS_KEY])
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
  await expect(page.locator('[data-slot="app-shell-sidebar"]')).toBeVisible()
}
const marked = (page: Page) => page.locator('[data-unseen="true"]')
const rowLink = (page: Page, id: string) => page.getByRole('link', { name: `Title ${id}` })
const rowMarks = (page: Page, id: string) => page.locator('li').filter({ has: rowLink(page, id) }).locator('[data-unseen="true"]')
const world = (): Partial<SessionFeaturesFixture> => ({
  sessions: [nativeSession('s1', 'Title s1', 'completed', 5, AFTER_BASELINE), nativeSession('s2', 'Title s2', 'completed', 7, AFTER_BASELINE), nativeSession('s3', 'Title s3', 'working', 3, AFTER_BASELINE)],
  progress: { s1: completedProgress('s1'), s2: completedProgress('s2'), s3: completedProgress('s3') },
})

test('marks exactly the finished sessions not yet opened, clears one on open, and survives reload', async ({ page }) => {
  const fixture = createSessionFeaturesFixture(world())
  await open(page, fixture)
  await expect(marked(page)).toHaveCount(2)
  await expect(page.getByTestId('shell-unseen-count').locator('.sr-only')).toHaveText('Finished, not yet opened: 2')
  for (const id of ['s1', 's2']) await expect(rowMarks(page, id)).toHaveCount(1)
  await expect(rowMarks(page, 's3')).toHaveCount(0)

  await rowLink(page, 's1').click()
  await expect(page).toHaveURL(/\/agent\/s1$/u)
  await expect(page.getByText('Fixture response', { exact: true })).toHaveCount(1)
  await expect(marked(page)).toHaveCount(1)
  await expect(page.getByTestId('shell-unseen-count').locator('.sr-only')).toHaveText('Finished, not yet opened: 1')
  await expect(rowMarks(page, 's2')).toHaveCount(1)

  await page.reload()
  await expect(marked(page)).toHaveCount(1)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Projects' }).click()
  await expect(marked(page)).toHaveCount(1) // leaving a seen session does not flag it again
  expect(fixture.requests.sessionPages).toBeGreaterThanOrEqual(3)
})

test('a session that finishes while elsewhere is flagged by the next read; one watched to the end is not', async ({ page }) => {
  const fixture = createSessionFeaturesFixture(world())
  await open(page, fixture, '/agent/s3')
  await expect(marked(page)).toHaveCount(2) // s1 and s2; s3 is running and open
  // s3 finishes while the user is looking at it, s1 finishes again later while they are away.
  fixture.sessions = [nativeSession('s1', 'Title s1', 'completed', 5, AFTER_BASELINE), nativeSession('s2', 'Title s2', 'completed', 7, AFTER_BASELINE), nativeSession('s3', 'Title s3', 'completed', 9, AFTER_BASELINE)]
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Projects' }).click()
  await expect(page).toHaveURL(/\/projects$/u)
  await expect(page.getByRole('region', { name: 'Sessions' }).getByText('Finished', { exact: true })).toHaveCount(3)
  await expect(marked(page)).toHaveCount(2) // s3 was watched, so it is not flagged
  await expect(rowMarks(page, 's3')).toHaveCount(0)

  await rowLink(page, 's1').click()
  await expect(marked(page)).toHaveCount(1) // only s2 remains
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Projects' }).click()
  await expect(marked(page)).toHaveCount(1)
  // s1 finishes again later: its head moved beyond what the user last saw, so it is flagged again.
  fixture.sessions = [nativeSession('s1', 'Title s1', 'completed', 11, AFTER_BASELINE), ...fixture.sessions.slice(1)]
  // D-203: no Refresh button; the list re-reads by itself (here: the window regains focus).
  await expect(page.getByRole('button', { name: 'Refresh sessions' })).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(marked(page)).toHaveCount(2)
  await expect(page.getByTestId('shell-unseen-count').locator('.sr-only')).toHaveText('Finished, not yet opened: 2')
  await expect(rowMarks(page, 's1')).toHaveCount(1)
  await expect(rowMarks(page, 's2')).toHaveCount(1)
})

test('history older than this profile is not flagged and a fresh profile starts at zero', async ({ page }) => {
  const fixture = createSessionFeaturesFixture({
    sessions: [nativeSession('s1', 'Title s1', 'completed', 5, '2026-10-01T10:00:00.000Z'), nativeSession('s2', 'Title s2', 'completed', 7, '2026-10-02T10:00:00.000Z')],
  })
  await open(page, fixture, '/projects', false)
  await expect(page.getByRole('region', { name: 'Sessions' }).getByText('Finished', { exact: true })).toHaveCount(2)
  await expect(marked(page)).toHaveCount(0)
  await expect(page.getByTestId('shell-unseen-count')).toHaveCount(0)
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), SEEN_SESSIONS_KEY)
  expect(Object.keys(stored).sort()).toEqual(['baselineAt', 'seen'])
})

test('the count stays reachable in the rail and the indicator has no critical axe finding in both themes and phone width', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await open(page, createSessionFeaturesFixture({ ...world(), theme }))
    await expect(marked(page)).toHaveCount(2)
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter(item => item.impact === 'critical' || item.impact === 'serious').flatMap(item => item.nodes.map(node => `${item.id}: ${node.target.join(' ')}`)), theme).toEqual([])
  }
  await page.getByRole('button', { name: 'Navigation sidebar' }).click()
  await page.getByRole('menuitem', { name: 'Collapse sidebar to a rail' }).click()
  await expect(page.getByTestId('shell-unseen-rail')).toHaveCount(1)
  await expect(page.getByTestId('shell-unseen-rail')).toContainText('Finished, not yet opened: 2')
  await expect(marked(page).first()).toBeHidden() // rows are hidden in the rail; only the count remains
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Russian copy and no marks when the node reports no finished session', async ({ page }) => {
  const fixture = createSessionFeaturesFixture({ ...world(), locale: 'ru' })
  await open(page, fixture)
  await expect(page.getByTestId('shell-unseen-count').locator('.sr-only')).toHaveText('Завершено, ещё не открыто: 2')
  await expect(page.locator('[data-unseen="true"]', { hasText: 'Завершена, ещё не открыта' })).toHaveCount(2)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await installSessionFeaturesApi(page, createSessionFeaturesFixture({ locale: 'ru', sessions: [nativeSession('s3', 'Title s3', 'working', 3, AFTER_BASELINE)] }))
  await page.reload()
  await expect(page.getByText('Title s3')).toBeVisible()
  await expect(marked(page)).toHaveCount(0)
})
