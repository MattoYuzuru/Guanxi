/**
 * Visual pass 3 (Models): a card shows at most four key facts with the rest behind an anchored
 * details popover, its chat action is not a full-width primary, and cards that fit the row are a
 * plain row (no carousel controls or shrunken neighbours); many cards on a narrow screen still
 * scroll as a carousel.
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

test('cards that fit the row are a plain row: no carousel controls and no shrunken neighbours', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, three)
  const installed = page.getByRole('group', { name: 'Installed models' })
  await expect(installed).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^(Previous|Next) model$/u })).toHaveCount(0)
  await expect(page.getByRole('tablist')).toHaveCount(0)
  const transforms = await page.locator('article').evaluateAll(cards => cards.map(card => getComputedStyle(card.closest('.embla-tween') ?? card).transform))
  expect(transforms.every(transform => transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)')).toBe(true)
})

test('many cards on a narrow screen still scroll as a carousel with controls', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 })
  await open(page, three)
  await expect(page.getByRole('button', { name: 'Next model' }).first()).toBeVisible()
})
