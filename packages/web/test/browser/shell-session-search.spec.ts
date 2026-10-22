import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { SessionPageItem } from '@guanxi/contract'

function session(index: number): SessionPageItem {
  return { sessionId: `search-${index}`, kind: 'agent', threadId: null,
    title: index === 236 ? 'Older needle session' : `Session ${index}`,
    createdAt: '2026-10-22T10:00:00.000Z', lastSeq: 1, lastEventAt: null, execution: null,
    navigation: { kind: 'inspector', sessionId: `search-${index}` } }
}
const sessions = Array.from({ length: 237 }, (_, index) => session(index))
function response(cursor: string | null) {
  const start = cursor ? Number(cursor.slice(1)) : 0, end = Math.min(start + 50, sessions.length)
  return { sessions: sessions.slice(Math.max(0, start - (start ? 1 : 0)), end),
    nextCursor: end < sessions.length ? `p${end}` : null, omitted: { withheld: false, catchingUp: false } }
}

test('explicit complete search finds a session beyond 200, preserves query/focus, and navigates exactly once', async ({ page }) => {
  const cursors: (string | null)[] = []
  let release!: () => void
  const hold = new Promise<void>(done => { release = done })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/sessions/list/page') {
      const cursor = url.searchParams.get('cursor'); cursors.push(cursor)
      if (cursor === 'p100') await hold
      return route.fulfill({ json: response(cursor) })
    }
    return route.fulfill({ json: { models: [] } })
  })
  await page.goto('/test/browser/fixtures/shell-palette.html?search=1')
  const trigger = page.getByRole('button', { name: 'Open commands' })
  await trigger.click()
  const input = page.getByRole('combobox', { name: 'Search commands' })
  await expect(input).toBeFocused()
  await input.fill('Older needle')
  await expect(page.getByText('Searching 50 loaded sessions. Older sessions are not loaded yet.')).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(0)
  await page.getByRole('button', { name: 'Search all available sessions' }).click()
  await expect(input).toBeFocused()
  await expect(page.getByText('Loading remaining sessions… 100 loaded so far.')).toBeVisible()
  expect(cursors).toEqual([null, 'p50', 'p100'])
  await expect(page.getByText(/Searching all \d+ sessions available/)).toHaveCount(0)
  release()
  await expect(page.getByText('Searching all 237 sessions available from the loaded pages.')).toBeVisible()
  expect(cursors).toEqual([null, 'p50', 'p100', 'p150', 'p200'])
  await expect(input).toHaveValue('Older needle')
  const result = page.getByRole('option', { name: 'Session: Older needle session', exact: true })
  await expect(result).toHaveCount(1)
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(input).toBeFocused()
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/inspector\/search-236$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Russian phone search exposes failure/retry and cancellation without claiming complete coverage', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  let failed = false, held = false, release!: () => void
  const hold = new Promise<void>(done => { release = done })
  const cursors: (string | null)[] = []
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions/list/page') return route.fulfill({ json: { models: [] } })
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor)
    if (cursor === 'p50' && !failed) { failed = true; return route.fulfill({ status: 503, json: { error: 'unavailable' } }) }
    if (cursor === 'p100' && !held) { held = true; await hold }
    return route.fulfill({ json: response(cursor) })
  })
  await page.goto('/test/browser/fixtures/shell-palette.html?search=1&locale=ru')
  await page.getByRole('button', { name: 'Open commands' }).click()
  const input = page.getByRole('combobox', { name: 'Поиск команд' })
  await input.fill('Older needle')
  await page.getByRole('button', { name: 'Искать во всех доступных сессиях' }).click()
  await expect(page.getByText('Не удалось загрузить все сессии. Поиск среди загруженных: 50.')).toBeVisible()
  await page.getByRole('button', { name: 'Повторить загрузку оставшихся сессий' }).click()
  await expect(page.getByText('Загрузка оставшихся сессий… Уже загружено: 100.')).toBeVisible()
  const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).searchParams.get('cursor') === 'p100')
  await page.getByRole('button', { name: 'Остановить загрузку сессий' }).click()
  await expect(input).toBeFocused()
  await aborted
  release()
  await expect(page.getByText('Поиск среди загруженных сессий: 100. Более старые сессии ещё не загружены.')).toBeVisible()
  await expect(page.getByText(/Поиск среди всех сессий/)).toHaveCount(0)
  await expect(input).toHaveValue('Older needle')
  await page.getByRole('button', { name: 'Искать во всех доступных сессиях' }).click()
  await expect(page.getByRole('option', { name: 'Сессия: Older needle session', exact: true })).toHaveCount(1)
  await expect(page.getByText('Поиск среди всех сессий, доступных на загруженных страницах: 237.')).toBeVisible()
  expect(cursors).toEqual([null, 'p50', 'p50', 'p100', 'p100', 'p150', 'p200'])
  const modal = page.getByRole('dialog', { name: 'Палитра команд' })
  for (const box of await modal.evaluate(node => [node, ...node.querySelectorAll('input,button')].map(element => {
    const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth }
  }))) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(box.width) }
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open commands' })).toBeFocused()
})

test('retry after a failed first-page refresh replaces stale rows before scanning only the new tail', async ({ page }) => {
  const cursors: (string | null)[] = []
  let firstPages = 0
  const item = (id: number, title: string) => ({ ...session(id), title })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions/list/page') return route.fulfill({ json: { models: [] } })
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor)
    if (!cursor && ++firstPages === 2) return route.fulfill({ status: 503, json: { error: 'unavailable' } })
    return route.fulfill({ json: { sessions: !cursor ? [firstPages === 1 ? item(1, 'Old head') : item(2, 'Fresh head')]
      : [cursor === 'old-tail' ? item(3, 'Old tail') : item(4, 'Fresh tail')],
      nextCursor: !cursor ? firstPages === 1 ? 'old-tail' : 'new-tail' : null,
      omitted: { withheld: false, catchingUp: false } } })
  })
  await page.goto('/test/browser/fixtures/shell-palette.html?search=1')
  const trigger = page.getByRole('button', { name: 'Open commands' })
  await trigger.click()
  const input = page.getByRole('combobox', { name: 'Search commands' })
  await expect(page.getByRole('option', { name: 'Session: Old head', exact: true })).toHaveCount(1)
  await input.fill('Refresh sessions')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await trigger.click()
  await expect(page.getByText('Could not refresh sessions. Searching 1 previously loaded sessions.')).toBeVisible()
  await expect(page.getByText(/Searching all \d+ sessions available/)).toHaveCount(0)
  await input.fill('Session: Fresh')
  await expect(page.getByRole('option')).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry refreshing sessions' }).click()
  await expect(page.getByText('Searching 1 loaded sessions. Older sessions are not loaded yet.')).toBeVisible()
  expect(cursors).toEqual([null, null, null])
  await expect(page.getByRole('option', { name: 'Session: Fresh head', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Search all available sessions' }).click()
  await expect(page.getByText('Searching all 2 sessions available from the loaded pages.')).toBeVisible()
  expect(cursors).toEqual([null, null, null, 'new-tail'])
  await input.fill('Session:')
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(page.getByRole('option', { name: 'Session: Fresh head', exact: true })).toHaveCount(1)
  await expect(page.getByRole('option', { name: 'Session: Fresh tail', exact: true })).toHaveCount(1)
  await expect(page.getByRole('option', { name: /Old (head|tail)/ })).toHaveCount(0)
})
