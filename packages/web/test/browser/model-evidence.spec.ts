import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('installed evidence stays truthful, localized, keyboard and constrained-layout safe', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-03T00:00:00.000Z'
  const pageErrors: string[] = []
  const probeRequests: Array<Record<string, unknown>> = []
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
    freshness: {
      state: 'stale', source: 'persistent_cache', observedAt,
      validatedAt: observedAt, expiresAt: '2026-08-03T00:15:00.000Z',
      staleUntil: '2026-08-10T00:15:00.000Z', offline: true,
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
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
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
    if (
      url.pathname === '/api/models/fixture%3Alatest/probes/completion'
      || url.pathname === '/api/models/fixture:latest/probes/completion'
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>
      probeRequests.push(body)
      if (probeRequests.length === 3) {
        return route.fulfill(json({
          code: 'internal_error',
          message: 'The completion probe could not be completed safely',
          details: null,
        }, 500))
      }
      return route.fulfill(json({
        evidence: {
          status: 'verified', reason: 'terminal_response', capability: 'completion',
          source: 'runtime_probe', confidence: 'verified', observedAt,
          completedAt: observedAt, durationMs: 0,
          basis: {
            state: 'exact', keyVersion: 1, probeDefinitionVersion: 1,
            provider: 'ollama', normalizedModelReference: 'fixture:latest',
            artifactDigest: 'sha256:fixture', runtimeVersion: '0.12.6',
            contextLength: 8_192, id: `sha256:${'a'.repeat(64)}`,
          },
          historical: probeRequests.length === 2,
        },
      }))
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/')
  // The card keeps one caution badge; the evidence facts sit in its details popover (visual pass 3).
  await expect(page.getByText('Неполные данные')).toBeVisible()
  await page.getByRole('button', { name: 'Подробности о модели' }).click()
  await expect(page.getByRole('dialog', { name: 'Подробности о модели' }).getByText('Ollama /api/tags + Ollama /api/show')).toBeVisible()
  await page.keyboard.press('Escape')
  const installedModels = page.getByRole('group', { name: 'Установленные модели' })
  await expect(installedModels.getByText('completion')).toHaveCount(0)
  const profile = page.getByRole('link', { name: 'fixture:latest' }).first()
  await profile.focus()
  await expect(profile).toBeFocused()
  await profile.press('Enter')
  await expect(page).toHaveURL(/\/models\/fixture%3Alatest$/u)
  await expect(page.getByRole('heading', { name: 'Доказательства установленной модели' })).toBeVisible()
  await expect(page.getByText('sha256:fixture').first()).toBeVisible()
  await expect(page.getByText(/Provider declarations расходятся/u)).toBeVisible()
  await expect(page.getByText('Устарело, offline').first()).toBeVisible()
  await expect(page.getByText(/7-дневного stale window/u)).toBeVisible()
  await expect(page.getByText(/не является controlled probe/u)).toBeVisible()
  await expect(page.getByText(/ручная проверка может ненадолго загрузить/u)).toBeVisible()

  const probe = page.getByRole('button', {
    name: 'Просмотреть условия и запустить проверку completion',
  })
  await probe.hover()
  expect(probeRequests).toEqual([])
  await page.reload()
  await expect(probe).toBeVisible()
  expect(probeRequests).toEqual([])

  await probe.focus()
  await probe.press('Enter')
  const dialog = page.getByRole('dialog', {
    name: 'Ненадолго загрузить и проверить модель?',
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Запустить проверку' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(probe).toBeFocused()
  expect(probeRequests).toEqual([])

  await probe.press('Enter')
  await dialog.getByRole('button', { name: 'Запустить проверку' }).press('Enter')
  await expect(page.getByText('Подтверждено', { exact: true })).toBeVisible()
  expect(probeRequests).toEqual([{
    capability: 'completion', expectedDigest: 'sha256:fixture',
    contextLength: 8_192, force: false,
  }])

  await probe.press('Enter')
  await dialog.getByRole('button', { name: 'Запустить проверку' }).press('Enter')
  await expect(page.getByText('Исторический exact-результат')).toBeVisible()
  await page.getByRole('button', {
    name: 'Просмотреть условия и запустить новую проверку completion',
  }).press('Enter')
  await page.getByRole('dialog', { name: 'Запустить новую проверку?' })
    .getByRole('button', { name: 'Запустить новую проверку' }).press('Enter')
  await expect(page.getByText('Ошибка запроса')).toBeVisible()
  await expect(page.getByText('Локальное приложение не смогло завершить запрос.')).toBeVisible()
  expect(probeRequests[2]?.force).toBe(true)

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
