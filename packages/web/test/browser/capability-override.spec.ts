import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { pickValue } from './fixtures/select.ts'

const AT = '2026-08-07T00:00:00.000Z'
const DIGEST = 'sha256:fixture'
const RUNTIME = '0.12.6'

test('user capability overrides stay separate, truthful, keyboard and layout safe', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const mutations: Array<{ method: string; body: Record<string, unknown> }> = []
  let overrides: Array<Record<string, unknown>> = []
  let digest = DIGEST

  const overrideRow = (capability: string) => ({
    version: 1,
    source: 'user_override',
    state: 'overridden',
    value: 'present',
    capability,
    provider: 'ollama',
    normalizedModelReference: 'fixture:latest',
    artifactDigest: DIGEST,
    runtimeVersion: RUNTIME,
    createdAt: AT,
    updatedAt: AT,
  })

  const basis = {
    reference: {
      state: 'canonical', provider: 'ollama', original: 'fixture:latest',
      normalized: 'fixture:latest',
    },
    artifact: { state: 'exact_digest', digest: DIGEST },
    runtime: {
      state: 'sourced', runtime: 'ollama', version: RUNTIME,
      source: 'ollama_api_version', observedAt: AT, confidence: 'observed',
    },
  }
  const descriptor = () => ({
    reference: basis.reference,
    artifact: { state: 'exact_digest', digest },
    installation: {
      state: 'installed', source: 'ollama_api_tags', observedAt: AT, confidence: 'observed',
    },
    // A degraded provider conflict must stay visible next to a positive assertion.
    capabilities: {
      state: 'degraded',
      reason: 'conflicting_provider_declarations',
      observedAt: AT,
      declarations: [
        {
          capabilities: ['completion'], source: 'ollama_api_tags', observedAt: AT,
          confidence: 'declared', basis,
        },
        {
          capabilities: ['tools'], source: 'ollama_api_show', observedAt: AT,
          confidence: 'declared',
          basis: {
            ...basis,
            artifact: { state: 'unknown', digest: null, reason: 'detail_not_bound_to_digest' },
          },
        },
      ],
    },
    freshness: {
      state: 'fresh', source: 'provider', observedAt: AT, validatedAt: AT,
      expiresAt: '2026-08-07T00:15:00.000Z', offline: false,
    },
    runtime: basis.runtime,
    overrides,
  })

  const fit = {
    level: 'green', summary: 'fixture fit', contextLength: 8_192,
    modelBytes: 4_000, kvCacheBytes: 1_000, requiredBytes: 5_000,
    usableBytes: 12_000_000_000, utilization: 0.1, basis: 'estimate', measured: null,
  }
  const model = () => ({
    name: 'fixture:latest', digest, sizeBytes: 4_000, modifiedAt: AT,
    family: 'fixture', parameterSize: '1B', quantization: 'Q4', contextLength: 32_768,
    contextLimit: {
      state: 'declared', value: 32_768, source: 'ollama_api_tags', observedAt: AT,
      confidence: 'declared',
    },
    capabilities: ['completion'], descriptor: descriptor(), isCloud: false, fit,
  })
  const detail = () => ({
    ...model(), modelInfo: {}, template: null, systemPrompt: null, license: null,
    fitByContext: [fit],
  })
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt: AT },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true, state: 'reachable',
      source: 'ollama_api_version', observedAt: AT, version: RUNTIME,
      host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'Fixture Metal', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: {
      ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked',
    },
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  const forbidden: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = decodeURIComponent(url.pathname)
    const method = route.request().method()

    if (path === '/api/health') return route.fulfill(json(health))
    if (path === '/api/settings') return route.fulfill(json(browserSettings()))
    if (path === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (path === '/api/models') return route.fulfill(json({ models: [model()] }))
    if (path === '/api/models/catalog') {
      return route.fulfill(json({
        models: [], live: false,
        source: { state: 'unknown', source: 'none', observedAt: AT, fetchedAt: null },
      }))
    }
    if (path === '/api/models/fixture:latest/capability-overrides') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      mutations.push({ method, body })
      if (body['expectedDigest'] !== digest) {
        return route.fulfill(json({
          outcome: {
            state: 'conflict', capability: body['capability'],
            reason: 'digest_expectation_mismatch', identity: null, overrides: [],
          },
        }))
      }
      const identity = {
        provider: 'ollama', normalizedModelReference: 'fixture:latest',
        artifactDigest: DIGEST, runtimeVersion: RUNTIME,
      }
      if (method === 'DELETE') {
        const had = overrides.some((row) => row['capability'] === body['capability'])
        overrides = overrides.filter((row) => row['capability'] !== body['capability'])
        return route.fulfill(json({
          outcome: {
            state: had ? 'cleared' : 'absent', capability: body['capability'],
            identity, overrides,
          },
        }))
      }
      if (!overrides.some((row) => row['capability'] === body['capability'])) {
        overrides = [...overrides, overrideRow(String(body['capability']))]
      }
      return route.fulfill(json({
        outcome: {
          state: 'applied', capability: body['capability'], identity, overrides,
        },
      }))
    }
    if (path === '/api/models/fixture:latest') return route.fulfill(json(detail()))

    // Any pull, probe, prewarm, warm, stop or model deletion is a defect here.
    if (/\/(pull|probes|prewarm|warm|stop)$/u.test(path) || method === 'DELETE') {
      forbidden.push(`${method} ${path}`)
    }
    return route.fulfill(json({ code: 'internal_error', message: path, details: null }, 500))
  })

  await page.goto('/models/fixture%3Alatest')

  // Three separate labelled regions: provider evidence, probe, user assertions.
  const evidence = page.getByRole('heading', { name: 'Доказательства установленной модели' })
  const probe = page.getByRole('heading', { name: 'Контролируемая проверка completion' })
  const assertions = page.getByRole('heading', { name: 'Ваши утверждения о capabilities' })
  await expect(evidence).toBeVisible()
  await expect(probe).toBeVisible()
  await expect(assertions).toBeVisible()
  await expect(page.getByText(/Это ваше собственное утверждение, а не provider declaration/u))
    .toBeVisible()
  await expect(page.getByText(/Оно не наследуется другим digest/u)).toBeVisible()
  await expect(
    page.getByText('Вы не утверждали ни одной capability для этого exact артефакта.'),
  ).toBeVisible()

  const add = page.getByRole('button', {
    name: 'Просмотреть условия и утвердить выбранную capability',
  })

  // Mount, hover, focus and a reload never mutate.
  await add.hover()
  await add.focus()
  await page.reload()
  await expect(add).toBeVisible()
  expect(mutations).toEqual([])

  // Escape from the confirmation returns focus and records nothing.
  await add.focus()
  await add.press('Enter')
  const addDialog = page.getByRole('dialog', {
    name: 'Утвердить эту capability самостоятельно?',
  })
  await expect(addDialog).toBeVisible()
  await expect(addDialog.getByRole('button', { name: 'Утвердить capability' })).toBeFocused()
  await expect(addDialog.getByText(DIGEST)).toBeVisible()
  await expect(addDialog.getByText(RUNTIME)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(add).toBeFocused()
  expect(mutations).toEqual([])

  await pickValue(page, page.getByRole('combobox', { name: 'Какую capability утвердить' }), 'tools')
  await add.press('Enter')
  await addDialog.getByRole('button', { name: 'Утвердить capability' }).press('Enter')
  await expect(page.getByText('Ваше утверждение записано.')).toBeVisible()
  expect(mutations).toEqual([{
    method: 'POST',
    body: {
      capability: 'tools', expectedDigest: DIGEST, expectedRuntimeVersion: RUNTIME,
    },
  }])

  // The positive assertion does not repair or hide the provider conflict.
  await expect(page.getByText(/Provider declarations расходятся/u)).toBeVisible()
  await expect(page.getByText('Неполные данные')).toBeVisible()
  await expect(page.getByText('Переопределено')).toHaveCount(1)
  await expect(page.getByText('user override')).toHaveCount(1)

  // Export is deterministic and never a mutation.
  const exported = await page.evaluate(async () => {
    const results: string[] = []
    const original = navigator.clipboard?.writeText
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => { results.push(text) } },
      configurable: true,
    })
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.getAttribute('aria-label')?.includes('Копировать ваши утверждения'),
    )
    button?.click()
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (original) {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: original }, configurable: true,
      })
    }
    return results
  })
  expect(exported).toHaveLength(2)
  expect(exported[0]).toBe(exported[1])
  expect(exported[0]).toContain('"schema": "guanxi.model-capability-overrides"')
  expect(exported[0]).not.toMatch(/127\.0\.0\.1|http|token|secret|prompt|reasoning|template/iu)
  expect(mutations).toHaveLength(1)

  // An identity that drifted server-side gives a conflict plus an explicit reload.
  digest = 'sha256:replaced'
  const remove = page.getByRole('button', {
    name: 'Просмотреть условия и удалить ваше утверждение для tools',
  })
  await remove.focus()
  await remove.press('Enter')
  const removeDialog = page.getByRole('dialog', { name: 'Удалить ваше утверждение?' })
  await expect(removeDialog.getByRole('button', { name: 'Удалить утверждение' })).toBeFocused()
  await removeDialog.getByRole('button', { name: 'Удалить утверждение' }).press('Enter')
  await expect(page.getByText('Ничего не изменено')).toBeVisible()
  await expect(page.getByText(/Установленный digest изменился/u)).toBeVisible()
  // The conflict removed nothing.
  await expect(page.getByText('Переопределено')).toHaveCount(1)
  expect(mutations).toHaveLength(2)
  expect(mutations[1]?.method).toBe('DELETE')

  // D-203: identity drift re-reads the model by itself (no Reload button); the re-read is not
  // a mutation.
  const beforeReload = mutations.length
  await expect(page.getByRole('button', { name: 'Перечитать модель' })).toHaveCount(0)
  await expect(page.getByText('sha256:replaced').first()).toBeVisible()
  expect(mutations).toHaveLength(beforeReload)

  // A reloaded exact identity that no longer matches shows no stale assertion.
  await expect(page.getByText('Переопределено')).toHaveCount(1)
  expect(forbidden).toEqual([])

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => {
    const region = document.querySelector(
      '[aria-label="Пользовательские override capabilities для этой exact установленной модели"]',
    )
    const style = region ? getComputedStyle(region) : null
    return {
      present: region !== null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: style?.animationDuration ?? '',
      transitionDuration: style?.transitionDuration ?? '',
    }
  })
  expect(layout.present).toBe(true)
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Number.parseFloat(layout.animationDuration || '0')).toBeLessThanOrEqual(0.00001)
  expect(Number.parseFloat(layout.transitionDuration || '0')).toBeLessThanOrEqual(0.00001)
  expect(pageErrors).toEqual([])
})

test('marketplace rows never expose capability override management', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const mutations: string[] = []

  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt: AT },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true, state: 'reachable',
      source: 'ollama_api_version', observedAt: AT, version: RUNTIME,
      host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'Fixture Metal', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: {
      ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked',
    },
  }
  const catalogModel = {
    name: 'catalog-fixture',
    description: 'catalog fixture row',
    variants: [],
    contextLength: 32_768,
    capabilities: ['completion', 'tools'],
    vramBytes: null,
    isCloud: false,
    requiredPlan: 'free',
    installed: false,
    fit: {
      level: 'green', summary: 'fixture fit', contextLength: 8_192, modelBytes: 4_000,
      kvCacheBytes: 1_000, requiredBytes: 5_000, usableBytes: 12_000_000_000,
      utilization: 0.1, basis: 'estimate', measured: null,
    },
    source: 'bundled',
    freshness: 'fallback',
    sourceObservedAt: AT,
    sourceFetchedAt: null,
  }

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = decodeURIComponent(url.pathname)
    if (path.endsWith('/capability-overrides')) {
      mutations.push(`${route.request().method()} ${path}`)
    }
    if (path === '/api/health') return route.fulfill(json(health))
    if (path === '/api/settings') return route.fulfill(json(browserSettings()))
    if (path === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (path === '/api/models') return route.fulfill(json({ models: [] }))
    if (path === '/api/models/catalog') {
      return route.fulfill(json({
        models: [catalogModel], live: false,
        source: { state: 'unknown', source: 'none', observedAt: AT, fetchedAt: null },
      }))
    }
    return route.fulfill(json({ code: 'internal_error', message: path, details: null }, 500))
  })

  await page.goto('/')
  await expect(page.getByText('catalog fixture row')).toBeVisible()
  // No assertion region and no assertion control exists outside the Installed profile.
  await expect(page.getByRole('heading', { name: 'Ваши утверждения о capabilities' }))
    .toHaveCount(0)
  await expect(page.getByRole('button', {
    name: 'Просмотреть условия и утвердить выбранную capability',
  })).toHaveCount(0)
  await expect(page.getByText('Переопределено')).toHaveCount(0)
  expect(mutations).toEqual([])
  expect(pageErrors).toEqual([])
})
