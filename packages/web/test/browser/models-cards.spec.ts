/**
 * Visual pass 3 and round 4 (Models): a card shows at most four key facts, values emphasised, with
 * the rest behind an anchored details popover; its chat action is not a full-width primary; cards
 * are a grid of equal, opaque, unscaled cards at every width — no carousel, arrows or dots.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

const observedAt = '2026-10-23T09:00:00.000Z'
const basis = {
  reference: { state: 'canonical', provider: 'ollama', original: 'qwen3:14b', normalized: 'qwen3:14b' },
  artifact: { state: 'exact_digest', digest: 'sha256:fixture' },
  runtime: { state: 'sourced', runtime: 'ollama', version: '0.12.6', source: 'ollama_api_version', observedAt, confidence: 'observed' },
}
const descriptor = (name: string) => ({
  reference: { ...basis.reference, original: name, normalized: name }, artifact: basis.artifact,
  installation: { state: 'installed', source: 'ollama_api_tags', observedAt, confidence: 'observed' },
  capabilities: { state: 'declared', reason: null, observedAt, declarations: [{ capabilities: ['completion', 'tools', 'thinking'], source: 'ollama_api_show', observedAt, confidence: 'declared', basis }] },
  freshness: { state: 'fresh', source: 'provider', observedAt, validatedAt: observedAt, expiresAt: '2026-10-23T09:15:00.000Z', offline: false },
})
const fit = (level: string, required: number) => ({ level, summary: 'fixture', contextLength: 32_768, modelBytes: required - 1_000_000_000, kvCacheBytes: 1_000_000_000, requiredBytes: required, usableBytes: 24_000_000_000, utilization: required / 24_000_000_000, basis: 'estimate', measured: null })
const model = (name: string, size: string, bytes: number, level: string) => ({
  name, digest: 'sha256:fixture', sizeBytes: bytes, modifiedAt: observedAt, family: name.split(':')[0], parameterSize: size, quantization: 'Q4_K_M', contextLength: 40_960,
  contextLimit: { state: 'declared', value: 40_960, source: 'ollama_api_tags', observedAt, confidence: 'declared' },
  capabilities: ['completion', 'tools'], descriptor: descriptor(name), isCloud: false, fit: fit(level, bytes + 1_000_000_000),
})
const three = [model('qwen3:14b', '14.8B', 9_300_000_000, 'green'), model('gemma3:27b', '27.4B', 17_000_000_000, 'yellow'), model('llama3.3:70b', '70.6B', 42_000_000_000, 'red')]
const health = {
  ok: true, appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt },
  ollama: { installed: true, installSource: 'runtime_response', running: true, state: 'reachable', source: 'ollama_api_version', observedAt, version: '0.12.6', host: 'http://127.0.0.1:11434', installHint: null },
  hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M2 Max', cpuCores: 12, totalMemoryBytes: 32_000_000_000, usableMemoryBytes: 24_000_000_000, accelerator: 'metal', acceleratorName: 'Apple M2 Max', unifiedMemory: true, freeDiskBytes: 400_000_000_000 },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

async function open(page: Page, models: unknown[]) {
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings({ locale: 'en', localeSource: 'user_setting' })))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models }))
    if (url.pathname === '/api/models/catalog') return route.fulfill(json({ models: [], live: false, source: { state: 'unknown', source: 'none', observedAt, fetchedAt: null } }))
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('article', { name: 'qwen3:14b' })).toBeVisible()
}

test('a card shows at most four facts, the rest in an anchored details popover, and a compact chat action', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, three)
  const card = page.getByRole('article', { name: 'qwen3:14b' })
  const visibleFacts = card.locator('dt:visible')
  expect(await visibleFacts.count()).toBeLessThanOrEqual(4)
  await expect(card.getByText('Capability evidence')).toHaveCount(0)
  await expect(card.getByText('Family')).toHaveCount(0)
  const chat = card.getByRole('link', { name: 'Start chat' })
  const [cardBox, chatBox] = [await card.boundingBox(), await chat.boundingBox()]
  expect(chatBox!.width).toBeLessThan(cardBox!.width * 0.6)
  await card.getByRole('button', { name: 'Model details' }).click()
  const details = page.getByRole('dialog', { name: 'Model details' })
  await expect(details).toBeVisible()
  await expect(details.getByText('Family')).toHaveCount(1)
  await expect(details.getByText('Capability evidence')).toHaveCount(1)
  const detailsBox = await details.boundingBox()
  const trigger = await card.getByRole('button', { name: 'Model details' }).boundingBox()
  expect(Math.abs(detailsBox!.y - (trigger!.y + trigger!.height))).toBeLessThanOrEqual(24)
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.map(violation => violation.id)).toEqual([])
})

/** Every card and each of its ancestors up to the grid renders unscaled and fully opaque. */
async function unscaledOpaque(page: Page) {
  return page.locator('article').evaluateAll(cards => cards.map(card => {
    let node: Element | null = card, scaled = false, faded = false
    while (node && !node.matches('[data-testid="model-grid"]')) {
      const style = getComputedStyle(node)
      if (style.transform !== 'none' && style.transform !== 'matrix(1, 0, 0, 1, 0, 0)') scaled = true
      if (Number(style.opacity) < 1) faded = true
      node = node.parentElement
    }
    return { scaled, faded }
  }))
}

const many = [...three, ...Array.from({ length: 5 }, (_, index) => model(`fixture-${index}:7b`, '7.6B', 4_700_000_000 + index * 100_000_000, 'green'))]

for (const width of [1440, 600, 390]) test(`cards are a grid of equal, opaque, unscaled cards with no carousel at ${width} px (round 4)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await open(page, many)
  const installed = page.getByRole('group', { name: 'Installed models' })
  await expect(installed).toHaveCount(1)
  await expect(installed.locator('article')).toHaveCount(8)
  await expect(page.getByRole('button', { name: /^(Previous|Next) model$/u })).toHaveCount(0)
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.locator('[aria-roledescription]')).toHaveCount(0)
  for (const card of await unscaledOpaque(page)) expect(card).toEqual({ scaled: false, faded: false })
  // Equal widths, every card inside the viewport (nothing parked off screen behind arrows).
  const boxes = await installed.locator('article').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON() as DOMRect))
  for (const box of boxes) {
    expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThanOrEqual(1)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
  }
  // Values carry the weight: a fact's value is heavier than its label.
  const weights = await installed.locator('article').first().locator('.model-fact').first().evaluate(row => [
    Number(getComputedStyle(row.querySelector('dt')!).fontWeight), Number(getComputedStyle(row.querySelector('dd')!).fontWeight)])
  expect(weights[1]).toBeGreaterThan(weights[0]!)
  // The fit verdict keeps its colour: green, yellow and red cards read in three different colours.
  const verdictColours = await installed.locator('article .model-card-fit p').evaluateAll(nodes => nodes.slice(0, 3).map(node => getComputedStyle(node).color))
  expect(new Set(verdictColours).size).toBe(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
