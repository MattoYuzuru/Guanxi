import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Marketplace selects, confirms and verifies one exact variant without implicit side effects', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-04T00:00:00.000Z'
  const pulls: Array<Record<string, unknown>> = []
  let installed = false
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  let releasePull!: () => void
  const pullReleased = new Promise<void>((resolve) => { releasePull = resolve })

  const fit = (modelBytes: number, level: 'green' | 'red') => ({
    level, summary: level, contextLength: 8_192, modelBytes, kvCacheBytes: 0,
    requiredBytes: modelBytes, usableBytes: 12_000_000_000,
    utilization: modelBytes / 12_000_000_000, basis: 'vendor_hint', measured: null,
  })
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
  const localModel = {
    name: 'fixture:small', digest: 'sha256:exact-small', sizeBytes: 1_000,
    modifiedAt: observedAt, family: 'fixture', parameterSize: '1B', quantization: 'Q4',
    contextLength: 8_192, capabilities: [], isCloud: false, fit: fit(1_000, 'green'),
    descriptor: {
      reference: {
        state: 'canonical', provider: 'ollama', original: 'fixture:small',
        normalized: 'fixture:small',
      },
      artifact: { state: 'exact_digest', digest: 'sha256:exact-small' },
      installation: {
        state: 'installed', source: 'ollama_api_tags', observedAt, confidence: 'observed',
      },
      capabilities: {
        state: 'unknown', reason: 'field_not_reported', observedAt, declarations: [],
      },
      freshness: {
        state: 'unknown', source: 'provider', observedAt,
        reason: 'identity_unavailable', offline: false,
      },
    },
  }
  const variant = (tag: 'small' | 'large', bytes: number) => ({
    tag, sizeBytes: bytes, parameterSize: tag === 'small' ? '1B' : '20B',
    normalizedName: `fixture:${tag}`, contextLength: 8_192,
    fit: {
      state: 'calculated', source: 'catalog_claim', contextLength: 8_192,
      verdict: fit(bytes, tag === 'small' ? 'green' : 'red'),
    },
    installation: installed && tag === 'small'
      ? { state: 'installed', digest: 'sha256:exact-small', source: 'ollama_api_tags', observedAt }
      : { state: 'not_installed', digest: null, source: 'ollama_api_tags', observedAt },
    source: 'bundled', freshness: 'fallback', sourceObservedAt: observedAt,
    sourceFetchedAt: '2026-08-02T00:00:00.000Z',
  })
  const catalog = () => ({
    models: [{
      name: 'fixture', description: 'two exact variants',
      variants: [variant('small', 1_000), variant('large', 20_000_000_000)],
      contextLength: 8_192, capabilities: [], vramBytes: null, isCloud: false,
      requiredPlan: null, installed, fit: fit(20_000_000_000, 'red'),
      installedProjection: 'variant_aggregate_compatibility',
      fitProjection: 'largest_variant_compatibility',
      source: 'bundled', freshness: 'fallback', sourceObservedAt: observedAt,
      sourceFetchedAt: '2026-08-02T00:00:00.000Z',
    }],
    live: false,
    source: {
      state: 'bundled_fallback', source: 'bundled_snapshot', observedAt,
      fetchedAt: '2026-08-02T00:00:00.000Z',
    },
  })
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') {
      return route.fulfill(json({ models: installed ? [localModel] : [] }))
    }
    if (url.pathname === '/api/models/catalog') return route.fulfill(json(catalog()))
    if (url.pathname.endsWith('/ollama-reference/start')) {
      pulls.push(request.postDataJSON() as Record<string, unknown>)
      // Hold the pull until both clicks of the double click have landed, as a real
      // pull would; an instant mock lets the second click race the result dialog.
      await pullReleased
      installed = true
      const frame = (event: unknown, sequence: number) =>
        `id: ${sequence}\nevent: guanxi\ndata: ${JSON.stringify(event)}\n\n`
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: frame({ type: 'progress', seq: 0, data: {
          status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
          completedBytes: 50, percent: 50, bytesPerSecond: 10, etaSeconds: 5,
        } }, 0) + frame({ type: 'done', seq: 1, data: { name: 'fixture:small' } }, 1),
      })
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/')
  const installedSection = page
    .getByRole('heading', { name: 'Установленные' })
    .locator('xpath=ancestor::section[1]')
  const marketplaceSection = page
    .getByRole('heading', { name: 'Каталог' })
    .locator('xpath=ancestor::section[1]')
  await expect(installedSection.getByText('Пока ничего не установлено')).toBeVisible()
  await expect(installedSection.locator('article[aria-label="fixture:small"]')).toHaveCount(0)
  await expect(marketplaceSection.locator('article[aria-label="fixture"]')).toHaveCount(1)
  await expect(
    marketplaceSection.getByRole('button', { name: 'Выбрать вариант small' }),
  ).toHaveCount(1)
  const carousel = page.getByRole('group', { name: 'Каталог моделей' })
  await carousel.focus()
  await carousel.press('ArrowRight')
  await carousel.press('Home')
  const small = page.getByRole('button', { name: 'Выбрать вариант small' })
  await small.hover()
  await small.focus()
  expect(pulls).toEqual([])
  await page.reload()
  expect(pulls).toEqual([])

  await small.focus()
  await small.press('Enter')
  await expect(page.getByText('fixture:small')).toBeVisible()
  await expect(page.getByText(/Влезает по оценке заявленного размера/u)).toBeVisible()
  await expect(page.getByText(/offline fallback/u)).toBeVisible()
  const review = page.getByRole('button', { name: 'Проверить точную установку' })
  await review.focus()
  await review.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Установка выбранного варианта каталога' })
  const confirm = dialog.getByRole('button', { name: /Подтвердить точную цель/u })
  await expect(confirm).toBeFocused()
  await expect(dialog.getByText(/mutable tag/u)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(review).toBeFocused()
  expect(pulls).toEqual([])

  await review.press('Enter')
  await dialog.getByRole('button', { name: /Подтвердить точную цель/u }).dblclick()
  await expect.poll(() => pulls.length).toBe(1)
  releasePull()
  await expect(dialog.getByText('sha256:exact-small')).toBeVisible()
  // The post-install refresh must not unmount the card that owns the result: once the
  // refreshed catalog card reports the installed digest, the dialog still shows it.
  await expect(
    page.locator('article[aria-label="fixture"]').getByText('sha256:exact-small'),
  ).toBeVisible()
  await expect(dialog.getByText('sha256:exact-small')).toBeVisible()
  await dialog.getByRole('button', { name: 'Готово' }).press('Enter')
  await expect(dialog).toBeHidden()
  await expect(small).toBeFocused()
  await expect(small).toHaveAttribute('aria-pressed', 'true')
  await expect(installedSection.locator('article[aria-label="fixture:small"]')).toHaveCount(1)
  await expect(marketplaceSection.locator('article[aria-label="fixture"]')).toHaveCount(1)
  expect(pulls).toEqual([{
    reference: 'fixture:small', confirmedModelName: 'fixture:small',
  }])

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
})
