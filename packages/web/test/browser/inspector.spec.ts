import { expect, test, type Page } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { REASONING_TEXT, SESSION_ID, sessionSummary, sessionTrace } from '../fixtures/session-events.ts'

/**
 * K2 exit gate in the browser: a reload rebuilds the same inspector state the
 * live view showed (per-type row counts), reasoning stays hidden until asked,
 * redaction markers never show raw, and the page fits a phone width.
 */
const observedAt = '2026-10-20T10:00:00.000Z'
const health = {
  ok: true,
  appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt },
  ollama: { installed: true, installSource: 'runtime_response', running: true, state: 'reachable', source: 'ollama_api_version', observedAt, version: 'test', host: 'http://127.0.0.1:11434', installHint: null },
  hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8, totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000, accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function rowCounts(page: Page): Promise<Record<string, number>> {
  return page.locator('[data-event-type]').evaluateAll((rows) => {
    const counts: Record<string, number> = {}
    for (const row of rows) {
      const type = row.getAttribute('data-event-type') ?? 'missing'
      counts[type] = (counts[type] ?? 0) + 1
    }
    return counts
  })
}

test('reload replays the live inspector state exactly, on desktop and phone', async ({ page }) => {
  const persisted = sessionTrace()
  const liveEvent = { ...persisted[2]!, seq: persisted.length + 1, id: '00000000-0000-4000-8000-0000000000ff', createdAt: '2026-10-20T10:05:00.000Z' }
  let streamCalls = 0
  const streamAfter: string[] = []

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings({ locale: 'en' })))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === `/api/sessions/${SESSION_ID}`) return route.fulfill(json(sessionSummary(persisted)))
    if (url.pathname === `/api/sessions/${SESSION_ID}/events`) {
      const after = Number(url.searchParams.get('after') ?? 0)
      const page = persisted.filter((event) => event.seq > after).slice(0, 5)
      return route.fulfill(json({
        sessionId: SESSION_ID,
        events: page,
        nextAfter: page.at(-1)?.seq ?? after,
        lastSeq: persisted.length,
        hasMore: (page.at(-1)?.seq ?? after) < persisted.length,
      }))
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/stream`) {
      streamCalls += 1
      streamAfter.push(url.searchParams.get('after') ?? '')
      if (streamCalls === 1) {
        // The live tail delivers one event; from now on it is persisted as well.
        persisted.push(liveEvent)
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `id: ${liveEvent.seq}\nevent: guanxi\ndata: ${JSON.stringify(liveEvent)}\n\n`,
        })
      }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    }
    return route.fulfill(json({ code: 'internal_error', message: `unexpected ${url.pathname}`, details: null }, 500))
  })

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    streamCalls = 0
    persisted.splice(sessionTrace().length)
    await page.goto(`/inspector/${SESSION_ID}`)
    const timeline = page.getByRole('list', { name: 'Session events in order' })
    await expect(timeline).toBeVisible()
    const total = sessionTrace().length + 1
    await expect(page.locator('[data-event-type]')).toHaveCount(total)
    const live = await rowCounts(page)
    expect(live.prompt).toBe(2)
    await expect(page.getByTestId('inspector-event-count')).toHaveText(String(total))

    await page.reload()
    await expect(page.locator('[data-event-type]')).toHaveCount(total)
    const replayed = await rowCounts(page)
    expect(replayed).toEqual(live)
    const expected: Record<string, number> = {}
    for (const event of persisted) expected[event.type] = (expected[event.type] ?? 0) + 1
    expect(replayed).toEqual(expected)
    const seqs = await page.locator('[data-event-type]').evaluateAll((rows) => rows.map((row) => row.id))
    expect(new Set(seqs).size).toBe(seqs.length)

    await expect(page.getByText(REASONING_TEXT)).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('⟦')
    await expect(page.getByText('hidden secret://vault/demo').first()).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    const show = page.getByRole('button', { name: /Show reasoning/ })
    await show.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText(REASONING_TEXT)).toBeVisible()
  }
  expect(streamAfter[0]).toBe(String(sessionTrace().length))
})
