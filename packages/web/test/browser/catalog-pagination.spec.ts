import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Marketplace pages hundreds of logical rows with bounded DOM and cross-page compare', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-04T00:00:00.000Z'
  const totalItems = 1_000
  const requests: Array<{ path: string; method: string; page: string | null }> = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const fit = (bytes: number) => ({
    level: 'green', summary: 'fixture', contextLength: 8_192, modelBytes: bytes,
    kvCacheBytes: 0, requiredBytes: bytes, usableBytes: 12_000_000_000,
    utilization: bytes / 12_000_000_000, basis: 'vendor_hint', measured: null,
  })
  const catalogModel = (index: number) => {
    const name = `synthetic-${String(index).padStart(4, '0')}`
    const target = `${name}:q4`
    const bytes = 1_000_000_000 + index
    return {
      name, description: `Synthetic logical row ${index}`,
      variants: [{
        tag: 'q4', normalizedName: target, sizeBytes: bytes, parameterSize: '4B',
        contextLength: 32_768,
        fit: { state: 'calculated', source: 'catalog_claim', contextLength: 8_192, verdict: fit(bytes) },
        installation: {
          state: 'not_installed', digest: null, source: 'ollama_api_tags', observedAt,
        },
        source: 'bundled', freshness: 'fallback', sourceObservedAt: observedAt,
        sourceFetchedAt: '2026-08-02T00:00:00.000Z',
      }],
      contextLength: 32_768, capabilities: ['completion'], vramBytes: null,
      isCloud: false, requiredPlan: null, installed: false, fit: fit(bytes),
      installedProjection: 'variant_aggregate_compatibility',
      fitProjection: 'largest_variant_compatibility', source: 'bundled',
      freshness: 'fallback', sourceObservedAt: observedAt,
      sourceFetchedAt: '2026-08-02T00:00:00.000Z',
    }
  }
  const source = {
    state: 'bundled_fallback', source: 'bundled_snapshot', observedAt,
    fetchedAt: '2026-08-02T00:00:00.000Z',
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
    requests.push({ path: url.pathname, method: request.method(), page: url.searchParams.get('page') })
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    if (url.pathname === '/api/models/catalog') {
      const requestedPage = Number(url.searchParams.get('page'))
      const pageSize = Number(url.searchParams.get('pageSize'))
      if (!Number.isSafeInteger(requestedPage) || pageSize !== 12) {
        return route.fulfill(json({ code: 'validation_failed', message: 'page', details: null }, 400))
      }
      const totalPages = Math.ceil(totalItems / pageSize)
      const start = (requestedPage - 1) * pageSize
      const models = Array.from(
        { length: Math.max(0, Math.min(pageSize, totalItems - start)) },
        (_, offset) => catalogModel(start + offset),
      )
      return route.fulfill(json({
        models, live: false, source,
        pagination: {
          mode: 'paged', page: requestedPage, pageSize, totalItems, totalPages,
          previousPage: requestedPage > 1 ? requestedPage - 1 : null,
          nextPage: requestedPage < totalPages ? requestedPage + 1 : null,
        },
      }))
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/')
  const pager = page.getByRole('navigation', { name: 'Страницы каталога' })
  await expect(pager.getByText('Страница 1 из 84 · на странице 12 · всего найдено 1000')).toBeVisible()
  await expect(page.locator('[aria-label="Каталог моделей"] .embla-slide')).toHaveCount(12)
  await expect(page.locator('[role="tab"][aria-label^="Модель "]')).toHaveCount(12)
  await expect(pager.getByRole('button')).toHaveCount(2)
  await expect(pager.getByRole('button', { name: 'Предыдущая страница' })).toBeDisabled()

  await page.getByRole('button', { name: 'Добавить к сравнению synthetic-0000:q4' }).press('Enter')
  const next = pager.getByRole('button', { name: 'Следующая страница' })
  await next.press('Enter')
  await expect(pager.getByText('Страница 2 из 84 · на странице 12 · всего найдено 1000')).toBeVisible()
  await expect(next).toBeFocused()
  await page.getByRole('button', { name: 'Добавить к сравнению synthetic-0012:q4' }).press('Enter')
  const compare = page.getByRole('button', { name: 'Сравнить точные варианты (2/2)' })
  await compare.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Сравнение точных вариантов' })
  await expect(dialog.getByText('synthetic-0000:q4')).toBeVisible()
  await expect(dialog.getByText('synthetic-0012:q4')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(compare).toBeFocused()

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDurations: [...document.querySelectorAll<HTMLElement>('*')]
      .map((element) => Number.parseFloat(getComputedStyle(element).animationDuration || '0'))
      .filter(Number.isFinite),
    catalogSlides: document.querySelectorAll('[aria-label="Каталог моделей"] .embla-slide').length,
    catalogDots: document.querySelectorAll('[role="tab"][aria-label^="Модель "]').length,
    pagerButtons: document.querySelectorAll('[aria-label="Страницы каталога"] button').length,
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Math.max(0, ...layout.animationDurations)).toBeLessThanOrEqual(0.00001)
  expect(layout.catalogSlides).toBe(12)
  expect(layout.catalogDots).toBe(12)
  expect(layout.pagerButtons).toBe(2)
  expect(pageErrors).toEqual([])

  const catalogRequests = requests.filter((entry) => entry.path === '/api/models/catalog')
  // The development entrypoint uses React StrictMode, so its initial effect may
  // be aborted and replaced once. Navigation still owns exactly one page-2
  // request and must not prefetch any other page.
  expect(catalogRequests.filter((entry) => entry.page === '1').length).toBeLessThanOrEqual(2)
  expect(catalogRequests.filter((entry) => entry.page === '2')).toHaveLength(1)
  expect(new Set(catalogRequests.map((entry) => entry.page))).toEqual(new Set(['1', '2']))
  expect(requests.filter((entry) =>
    entry.method !== 'GET'
      || /pull|probe|prewarm|warm|load|imports/u.test(entry.path),
  )).toEqual([])
})
