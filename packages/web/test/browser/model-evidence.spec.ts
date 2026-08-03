import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('installed evidence stays truthful, localized, keyboard and constrained-layout safe', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-03T00:00:00.000Z'
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const basis = {
    reference: {
      state: 'canonical', provider: 'ollama', original: 'fixture:latest',
      normalized: 'fixture:latest',
    },
    artifact: { state: 'exact_digest', digest: 'sha256:fixture' },
    runtime: {
      state: 'sourced', runtime: 'ollama', version: '0.12.6',
      source: 'ollama_api_version', observedAt, confidence: 'observed',
    },
  }
  const descriptor = {
    reference: basis.reference,
    artifact: basis.artifact,
    installation: {
      state: 'installed', source: 'ollama_api_tags', observedAt, confidence: 'observed',
    },
    capabilities: {
      state: 'degraded',
      reason: 'conflicting_provider_declarations',
      observedAt,
      declarations: [
        {
          capabilities: ['completion'], source: 'ollama_api_tags', observedAt,
          confidence: 'declared', basis,
        },
        {
          capabilities: ['tools'], source: 'ollama_api_show', observedAt,
          confidence: 'declared',
          basis: {
            ...basis,
            artifact: {
              state: 'unknown', digest: null, reason: 'detail_not_bound_to_digest',
            },
          },
        },
      ],
    },
  }
  const fit = {
    level: 'green', summary: 'fixture fit', contextLength: 8_192,
    modelBytes: 4_000, kvCacheBytes: 1_000, requiredBytes: 5_000,
    usableBytes: 12_000_000_000, utilization: 0.1, basis: 'estimate', measured: null,
  }
  const model = {
    name: 'fixture:latest', digest: 'sha256:fixture', sizeBytes: 4_000,
    modifiedAt: observedAt, family: 'fixture', parameterSize: '1B', quantization: 'Q4',
    contextLength: 32_768,
    contextLimit: {
      state: 'declared', value: 32_768, source: 'ollama_api_tags', observedAt,
      confidence: 'declared',
    },
    capabilities: ['completion'], descriptor, isCloud: false, fit,
  }
  const detail = {
    ...model, modelInfo: {}, template: null, systemPrompt: null, license: null,
    fitByContext: [fit],
  }
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true, state: 'reachable',
      source: 'ollama_api_version', observedAt, version: '0.12.6',
      host: 'http://127.0.0.1:11434', installHint: null,
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
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [model] }))
    if (url.pathname === '/api/models/catalog') {
      return route.fulfill(json({
        models: [], live: false,
        source: { state: 'unknown', source: 'none', observedAt, fetchedAt: null },
      }))
    }
    if (url.pathname === '/api/models/fixture%3Alatest' || url.pathname === '/api/models/fixture:latest') {
      return route.fulfill(json(detail))
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/')
  await expect(page.getByText('Неполные данные')).toBeVisible()
  await expect(page.getByText('Ollama /api/tags + Ollama /api/show')).toBeVisible()
  await expect(page.getByText('completion')).toHaveCount(0)
  const profile = page.getByRole('link', { name: 'fixture:latest' }).first()
  await profile.focus()
  await expect(profile).toBeFocused()
  await profile.press('Enter')
  await expect(page).toHaveURL(/\/models\/fixture%3Alatest$/u)
  await expect(page.getByRole('heading', { name: 'Доказательства установленной модели' })).toBeVisible()
  await expect(page.getByText('sha256:fixture').first()).toBeVisible()
  await expect(page.getByText(/Provider declarations расходятся/u)).toBeVisible()
  await expect(page.getByText(/не является controlled probe/u)).toBeVisible()

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => {
    const badge = document.querySelector('[aria-label="Доказательства capabilities установленной модели"]')
    const style = badge ? getComputedStyle(badge) : null
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: style?.animationDuration ?? '',
      transitionDuration: style?.transitionDuration ?? '',
    }
  })
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Number.parseFloat(layout.animationDuration || '0')).toBeLessThanOrEqual(0.00001)
  expect(Number.parseFloat(layout.transitionDuration || '0')).toBeLessThanOrEqual(0.00001)
  expect(pageErrors).toEqual([])
})
