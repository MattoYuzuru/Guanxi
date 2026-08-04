import { expect, test } from '@playwright/test'
import { runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Add from Ollama is explicit, focus-contained, truthful and constrained-layout safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-04T00:00:00.000Z'
  const previewBodies: unknown[] = []
  const pullBodies: unknown[] = []
  let installed = false
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

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
    network: {
      ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked',
    },
  }
  const model = {
    name: 'qwen3:8b', digest: 'sha256:installed', sizeBytes: 1,
    modifiedAt: observedAt, family: 'qwen3', parameterSize: '8B',
    quantization: 'Q4', contextLength: 8_192, capabilities: [], isCloud: false,
    fit: {
      level: 'unknown', summary: 'unknown', contextLength: 8_192,
      modelBytes: 1, kvCacheBytes: 1, requiredBytes: 2, usableBytes: 1,
      utilization: 2, basis: 'estimate', measured: null,
    },
  }
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') {
      return route.fulfill(json({ models: installed ? [model] : [] }))
    }
    if (url.pathname === '/api/models/catalog') {
      return route.fulfill(json({
        models: [], live: false,
        source: { state: 'unknown', source: 'none', observedAt, fetchedAt: null },
      }))
    }
    if (url.pathname.endsWith('/ollama-reference/preview')) {
      previewBodies.push(request.postDataJSON())
      return route.fulfill(json({
        preview: {
          inputKind: 'official_page_url',
          displayValue: 'https://ollama.com/library/qwen3:8b',
          normalizedModelName: 'qwen3:8b',
        },
      }))
    }
    if (url.pathname.endsWith('/ollama-reference/start')) {
      pullBodies.push(request.postDataJSON())
      installed = true
      const frame = (event: unknown, seq: number) =>
        `id: ${seq}\nevent: alamo\ndata: ${JSON.stringify(event)}\n\n`
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: frame({ type: 'progress', seq: 0, data: {
          status: 'downloading', digest: 'sha256:layer', totalBytes: 100,
          completedBytes: 50, percent: 50, bytesPerSecond: 10, etaSeconds: 5,
        } }, 0) + frame({ type: 'done', seq: 1, data: { name: 'qwen3:8b' } }, 1),
      })
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/')
  const entry = page.getByRole('button', { name: 'Добавить модель по имени Ollama или официальной странице' })
  await entry.hover()
  expect(previewBodies).toEqual([])
  expect(pullBodies).toEqual([])
  await page.reload()
  expect(previewBodies).toEqual([])
  expect(pullBodies).toEqual([])

  await entry.focus()
  await entry.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Добавить из Ollama' })
  const input = dialog.getByRole('textbox', { name: 'Имя модели или URL официальной страницы' })
  await expect(input).toBeFocused()
  await input.fill('https://ollama.com/library/qwen3:8b')
  expect(previewBodies).toEqual([])
  expect(pullBodies).toEqual([])
  await input.press('Enter')
  await expect(dialog.getByText('qwen3:8b')).toBeVisible()
  expect(previewBodies).toEqual([{ reference: 'https://ollama.com/library/qwen3:8b' }])
  expect(pullBodies).toEqual([])
  await expect(dialog.getByRole('button', { name: /Подтвердить нормализованную цель/u })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(entry).toBeFocused()
  expect(pullBodies).toEqual([])

  await entry.press('Enter')
  await input.fill('https://ollama.com/library/qwen3:8b')
  await input.press('Enter')
  const confirm = dialog.getByRole('button', { name: /Подтвердить нормализованную цель/u })
  await confirm.dblclick()
  await expect(dialog.getByText(/нормализованное имя присутствует/u)).toBeVisible()
  await expect(dialog.getByText(/Completion probe/u)).toBeVisible()
  expect(pullBodies).toEqual([{
    reference: 'https://ollama.com/library/qwen3:8b',
    confirmedModelName: 'qwen3:8b',
  }])

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDuration: getComputedStyle(document.querySelector('[role="dialog"]')!).animationDuration,
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Number.parseFloat(layout.animationDuration || '0')).toBeLessThanOrEqual(0.00001)
  expect(pageErrors).toEqual([])
})
