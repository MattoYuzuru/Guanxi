import { expect, test, type Page } from '@playwright/test'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  SESSION_EVENT_VERSION_3,
  sessionEventSchema,
} from '@guanxi/contract'
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
        // The live tail re-sends the last stored event (a reconnect overlap), then delivers a
        // new one; from now on the new one is persisted as well.
        persisted.push(liveEvent)
        const overlap = persisted[persisted.length - 2]!
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: [overlap, liveEvent].map((event) => `id: ${event.seq}\nevent: guanxi\ndata: ${JSON.stringify(event)}\n\n`).join(''),
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
    await expect(page.getByText('secret secret://vault/demo').first()).toBeVisible()
    // The app root clips overflow, so measure the scrolling main area and every row instead.
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main')!
      const rows = [...document.querySelectorAll('[data-event-type]')]
      return [main.scrollWidth - main.clientWidth, ...rows.map((row) => row.scrollWidth - row.clientWidth)]
    })
    expect(Math.max(...overflow)).toBeLessThanOrEqual(0)

    const show = page.getByRole('button', { name: /Show reasoning/ })
    await show.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText(REASONING_TEXT)).toBeVisible()
  }
  expect(streamAfter[0]).toBe(String(sessionTrace().length))
})

test('renders v3 queue items once and bounded on a phone with reduced motion', async ({ page }) => {
  const inlineTail = 'PHONE-INLINE-TAIL'
  const fullTail = 'PHONE-FULL-ARTIFACT-TAIL'
  const queueEvent = sessionEventSchema.parse({
    sessionId: SESSION_ID,
    seq: sessionTrace().length + 1,
    id: '00000000-0000-4000-8000-0000000000aa',
    version: SESSION_EVENT_VERSION_3,
    type: 'agent.queue',
    class: 'standard',
    spanId: null,
    parentSpanId: null,
    jobId: null,
    writerEpoch: 1,
    redactions: 0,
    createdAt: '2026-10-20T10:06:00.000Z',
    data: {
      items: [
        { id: 'phone-inline', kind: 'inline', text: `${'i'.repeat(INPUT_EXCERPT_BYTES + 20)}${inlineTail}` },
        {
          id: 'phone-artifact',
          kind: 'artifact',
          artifact: {
            artifactId: '99999999-9999-4999-8999-999999999999',
            checksum: `sha256:${'d'.repeat(64)}`,
            byteSize: INPUT_INLINE_BYTES + fullTail.length,
            mediaType: 'text/plain; charset=utf-8',
            excerpt: 'PHONE-ARTIFACT-EXCERPT',
            excerptBytes: new TextEncoder().encode('PHONE-ARTIFACT-EXCERPT').byteLength,
          },
        },
      ],
    },
  })
  const events = [...sessionTrace(), queueEvent]
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings({ locale: 'en' })))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === `/api/sessions/${SESSION_ID}`) return route.fulfill(json(sessionSummary(events)))
    if (url.pathname === `/api/sessions/${SESSION_ID}/events`) {
      const after = Number(url.searchParams.get('after') ?? 0)
      const page = events.filter((event) => event.seq > after)
      return route.fulfill(json({
        sessionId: SESSION_ID,
        events: page,
        nextAfter: page.at(-1)?.seq ?? after,
        lastSeq: events.length,
        hasMore: false,
      }))
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/stream`) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/spans`) {
      return route.fulfill(json({ sessionId: SESSION_ID, spans: [] }))
    }
    if (url.pathname === '/api/sessions/search') {
      return route.fulfill(json({ query: url.searchParams.get('q') ?? '', hits: [] }))
    }
    if (url.pathname === '/api/sessions') {
      return route.fulfill(json({ sessions: [], withheld: 0, catchingUp: 0, catchUpFailed: 0 }))
    }
    return route.fulfill(json({ code: 'internal_error', message: `unexpected ${url.pathname}`, details: null }, 500))
  })

  await page.goto(`/inspector/${SESSION_ID}`)
  const queue = page.getByRole('list', { name: 'Queued items' })
  await expect(queue).toBeVisible()
  const items = queue.locator('[data-testid="inspector-queue-item"]')
  await expect(items).toHaveCount(2)
  const ids = await items.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-queue-item-id')))
  expect(ids).toEqual(['phone-inline', 'phone-artifact'])
  await expect(queue.getByText('Inline')).toHaveCount(1)
  await expect(queue.getByText('Bounded input')).toHaveCount(1)
  await expect(queue.getByText('PHONE-ARTIFACT-EXCERPT')).toHaveCount(1)
  await expect(page.locator('body')).not.toContainText(inlineTail)
  await expect(page.locator('body')).not.toContainText(fullTail)
  await expect(page.locator('body')).not.toContainText('99999999-9999-4999-8999-999999999999')
  expect(await items.first().evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main')!
    const rows = [...document.querySelectorAll('[data-testid="inspector-queue-item"]')]
    return [main.scrollWidth - main.clientWidth, ...rows.map((row) => row.scrollWidth - row.clientWidth)]
  })
  expect(Math.max(...overflow)).toBeLessThanOrEqual(0)
})
