import { SESSION_ROUTES } from '@guanxi/contract'
import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { closeNavigation, closeStatusOverflow, openNavigation, openStatusOverflow } from './fixtures/shell-navigation.ts'

test('degraded Ollama keeps the shell and bundled catalog accessible on a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(({ runtimeSnapshot, settings, sessionPageRoute }) => {
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
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(rawUrl, window.location.origin)
      if (url.pathname === '/api/health') return json(health)
      if (url.pathname === sessionPageRoute) {
        return json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
      }
      if (url.pathname === '/api/settings') return json(settings)
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
  }, { runtimeSnapshot: runtimeBrowserSnapshot(), settings: browserSettings(), sessionPageRoute: SESSION_ROUTES.page() })

  await page.goto('/')

  await openNavigation(page)
  const navigation = page.getByRole('navigation', { name: 'Главная навигация' })
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole('link')).toHaveCount(4)
  await expect(page.getByRole('link', { name: 'Новая сессия' })).toBeVisible()
  await closeNavigation(page)
  await openStatusOverflow(page)
  // D-202: the degraded Ollama is the runtime status item, named in text (not only by colour).
  const trigger = page.getByRole('button', { name: /^Среда выполнения: Не поддерж\./u })
  await expect(trigger).toBeVisible()
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(24)
  await trigger.focus()
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  const popover = page.getByTestId('shell-runtime-popover')
  await expect(popover.getByRole('alert')).toContainText('Эта версия Ollama не поддерживается')
  const runtime = popover.getByRole('region', { name: 'Runtime и ресурсы' })
  await expect(runtime).toContainText('Источник Ollama несовместим')
  await expect(page.getByText(/Состояние загруженных моделей неизвестно/)).toBeVisible()
  await page.keyboard.press('Escape')
  await closeStatusOverflow(page)
  await expect(page.getByText('Встроенный fallback каталога')).toBeVisible()
  await expect(page.getByText('fixture-catalog')).toBeVisible()

  // D-203: no "Проверить снова" button; health is re-read by itself.
  await expect(page.getByRole('button', { name: 'Проверить снова' })).toHaveCount(0)

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true)
})
