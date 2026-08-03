import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('degraded Ollama keeps the shell and bundled catalog accessible on a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript((runtimeSnapshot) => {
    const observedAt = '2026-08-02T12:00:00.000Z'
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })

    const health = {
      ok: true,
      appVersion: 'test',
      application: {
        state: 'reachable',
        source: 'application_http',
        observedAt,
      },
      ollama: {
        installed: true,
        running: false,
        state: 'incompatible',
        source: 'ollama_api_version',
        observedAt,
        version: null,
        host: 'http://127.0.0.1:11434',
        installHint: null,
      },
      hardware: {
        platform: 'darwin',
        arch: 'arm64',
        cpuModel: 'fixture',
        cpuCores: 8,
        totalMemoryBytes: 16_000_000_000,
        usableMemoryBytes: 12_000_000_000,
        accelerator: 'metal',
        acceleratorName: 'fixture',
        unifiedMemory: true,
        freeDiskBytes: 100_000_000_000,
      },
      network: {
        ollamaComReachable: null,
        checkedAt: null,
        status: 'unknown',
        source: 'not_checked',
      },
    }
    const fit = {
      level: 'unknown',
      summary: 'Fixture estimate',
      contextLength: 32_768,
      modelBytes: 1_000_000,
      kvCacheBytes: 100_000,
      requiredBytes: 1_100_000,
      usableBytes: 12_000_000_000,
      utilization: 0.01,
      basis: 'estimate',
      measured: null,
    }
    const degradedRuntime = {
      ...runtimeSnapshot,
      source: {
        state: 'incompatible',
        source: 'ollama_api_ps',
        observedAt,
        errorCode: 'runtime_protocol',
      },
      models: null,
      decisions: [
        {
          code: 'source_failure',
          modelName: null,
          normalizedModelName: null,
          leaseId: null,
          owner: null,
          runtimeDigest: null,
          requestedContext: null,
          observedContext: null,
          identityBasis: 'none',
          artifactIdentity: 'unknown',
        },
      ],
    }

    window.fetch = async (input) => {
      const rawUrl = typeof input === 'string' ? input : input.url
      const url = new URL(rawUrl, window.location.origin)
      if (url.pathname === '/api/health') return json(health)
      if (url.pathname === '/api/runtime') return json(degradedRuntime)
      if (url.pathname === '/api/models') {
        return json(
          {
            code: 'ollama_unavailable',
            message: 'Ollama is unavailable',
            details: null,
          },
          503,
        )
      }
      if (url.pathname === '/api/models/catalog') {
        return json({
          live: false,
          source: {
            state: 'bundled_fallback',
            source: 'bundled_snapshot',
            observedAt,
            fetchedAt: observedAt,
          },
          models: [
            {
              name: 'fixture-catalog',
              description: 'Bundled fixture',
              variants: [{ tag: 'latest', sizeBytes: 1_000_000, parameterSize: '1B' }],
              contextLength: 32_768,
              capabilities: ['completion'],
              vramBytes: null,
              isCloud: false,
              requiredPlan: null,
              installed: false,
              fit,
              source: 'bundled',
              freshness: 'fallback',
              sourceObservedAt: observedAt,
              sourceFetchedAt: observedAt,
            },
          ],
        })
      }
      return json({ code: 'internal_error', message: url.pathname, details: null }, 500)
    }
  }, runtimeBrowserSnapshot())

  await page.goto('/')

  await expect(page.getByRole('link', { name: 'Чат' })).toBeVisible()
  await expect(page.getByText('Ollama вернула несовместимый ответ')).toBeVisible()
  const runtime = page.getByRole('region', { name: 'Runtime и ресурсы' })
  await expect(runtime).toContainText('Источник Ollama несовместим')
  await runtime.getByText('Показать сведения о runtime').click()
  await expect(page.getByText(/Состояние загруженных моделей неизвестно/)).toBeVisible()
  await expect(page.getByText('Встроенный fallback каталога')).toBeVisible()
  await expect(page.getByText('fixture-catalog')).toBeVisible()

  const retry = page.getByRole('button', { name: 'Проверить снова' })
  await retry.focus()
  await expect(retry).toBeFocused()
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44)

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true)
})
