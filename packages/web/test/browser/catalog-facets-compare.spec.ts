import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Marketplace filters and compares exact variants without resource side effects', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-04T00:00:00.000Z'
  const requests: Array<{ path: string; search: string; method: string }> = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const fit = (level: 'green' | 'red', bytes: number) => ({
    level, summary: level, contextLength: 8_192, modelBytes: bytes,
    kvCacheBytes: 0, requiredBytes: bytes, usableBytes: 12_000_000_000,
    utilization: bytes / 12_000_000_000, basis: 'vendor_hint', measured: null,
  })
  const variant = (tag: 'a' | 'b') => ({
    tag, normalizedName: `fixture:${tag}`,
    sizeBytes: tag === 'a' ? 1_000 : null,
    parameterSize: tag === 'a' ? '1B' : null,
    contextLength: tag === 'a' ? 32_768 : null,
    fit: tag === 'a'
      ? { state: 'calculated', source: 'catalog_claim', contextLength: 8_192, verdict: fit('red', 1_000) }
      : { state: 'unknown', source: 'catalog_claim', contextLength: null, verdict: null, reason: 'size_unknown' },
    installation: tag === 'a'
      ? { state: 'installed', digest: 'sha256:exact-a', source: 'ollama_api_tags', observedAt }
      : { state: 'unknown', digest: null, source: 'unavailable', observedAt: null, reason: 'provider_unavailable' },
    source: tag === 'a' ? 'local_cache' : 'bundled',
    freshness: tag === 'a' ? 'stale' : 'fallback',
    sourceObservedAt: observedAt,
    sourceFetchedAt: tag === 'a' ? '2026-08-01T00:00:00.000Z' : '2026-08-02T00:00:00.000Z',
  })
  const catalogModel = (variants: Array<ReturnType<typeof variant>>) => ({
    name: 'fixture', description: 'two exact catalog facts', variants,
    contextLength: 32_768, capabilities: [], vramBytes: null, isCloud: false,
    requiredPlan: null, installed: true,
    // Compatibility aggregate deliberately disagrees with exact installed A.
    fit: fit('green', 1),
    installedProjection: 'variant_aggregate_compatibility',
    fitProjection: 'largest_variant_compatibility', source: 'local_cache',
    freshness: 'stale', sourceObservedAt: observedAt,
    sourceFetchedAt: '2026-08-01T00:00:00.000Z',
  })
  const source = {
    state: 'stale_cache', source: 'ollama_recommendations_cache', observedAt,
    fetchedAt: '2026-08-01T00:00:00.000Z',
  }
  const health = {
    ok: true, appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true,
      state: 'reachable', source: 'ollama_api_version', observedAt,
      version: '0.12.6', host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'Fixture Metal', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push({ path: url.pathname, search: url.search, method: request.method() })
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    if (url.pathname === '/api/models/catalog') {
      const installation = url.searchParams.get('installation')
      const selectedFit = url.searchParams.get('fit')
      if (installation === 'installed' && selectedFit === 'green') {
        return route.fulfill(json({ models: [], live: false, source }))
      }
      const variants = url.searchParams.get('q') === 'only-a'
        ? [variant('a')]
        : [variant('a'), variant('b')]
      return route.fulfill(json({ models: [catalogModel(variants)], live: false, source }))
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/')
  await page.getByText('Фильтры фактов каталога').click()
  await page.getByRole('checkbox', { name: 'установлен', exact: true }).check()
  await expect.poll(() => requests.filter((entry) => entry.path === '/api/models/catalog').at(-1)?.search)
    .toContain('installation=installed')
  await page.getByLabel('зелёный расчётный fit').check()
  await expect(page.getByText('Нет подходящих точных вариантов')).toBeVisible()
  expect(requests.filter((entry) => entry.path === '/api/models/catalog').at(-1)?.search)
    .toContain('fit=green')
  await page.getByRole('button', { name: 'Сбросить поиск и фильтры' }).click()

  await expect(page.getByRole('button', { name: 'Добавить к сравнению fixture:a' })).toBeVisible()
  await page.getByRole('button', { name: 'Добавить к сравнению fixture:a' }).press('Enter')
  await page.getByRole('button', { name: 'Добавить к сравнению fixture:b' }).press('Enter')
  const compare = page.getByRole('button', { name: 'Сравнить точные варианты (2/2)' })
  await compare.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Сравнение точных вариантов' })
  await expect(dialog.getByRole('button', { name: 'Поменять колонки местами' })).toBeFocused()
  await expect(dialog.getByText('sha256:exact-a')).toBeVisible()
  await expect(dialog.getByText(/красный расчётный fit/u)).toBeVisible()
  await expect(dialog.getByText(/не создаёт winner/u)).toBeVisible()
  await dialog.getByRole('button', { name: 'Поменять колонки местами' }).press('Enter')
  await page.keyboard.press('Escape')
  await expect(compare).toBeFocused()
  await compare.press('Enter')
  await dialog.getByRole('button', { name: 'Убрать из сравнения fixture:b' }).press('Enter')
  const retained = page.getByRole('button', { name: 'Убрать из сравнения fixture:a' })
  await expect(retained).toBeFocused()
  await page.getByRole('button', { name: 'Добавить к сравнению fixture:b' }).press('Enter')

  const search = page.getByLabel('Поиск по каталогу моделей')
  await search.fill('only-a')
  await expect(page.getByText(/Сравнение очищено/u)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Сравнить точные варианты (0/2)' })).toBeDisabled()

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDurations: [...document.querySelectorAll<HTMLElement>('*')]
      .map((element) => Number.parseFloat(getComputedStyle(element).animationDuration || '0'))
      .filter(Number.isFinite),
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Math.max(0, ...layout.animationDurations)).toBeLessThanOrEqual(0.00001)
  expect(pageErrors).toEqual([])

  const sideEffects = requests.filter((entry) =>
    entry.method !== 'GET'
      || /pull|probe|prewarm|warm|load|imports/u.test(entry.path),
  )
  expect(sideEffects).toEqual([])
})
