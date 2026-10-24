import { expect, test } from '@playwright/test'
import { installFrameOrderSwitch, setFramesBeforePendingCommits } from './fixtures/frame-order.ts'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { pickValue } from './fixtures/select.ts'

test('attachment recovery/reload stays exact, scoped, accessible and download-once', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installFrameOrderSwitch(page)
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const observedAt = '2026-08-14T14:00:00.000Z'
  const project = {
    id: 'legacy-project-browser',
    name: 'Legacy Attachment Project',
    createdAt: observedAt,
    updatedAt: observedAt,
    filesystemBindings: [],
  }
  const health = {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true,
      installSource: 'runtime_response',
      running: true,
      state: 'reachable',
      source: 'ollama_api_version',
      observedAt,
      version: 'test',
      host: 'http://127.0.0.1:11434',
      installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: {
      ollamaComReachable: null,
      checkedAt: null,
      status: 'unknown',
      source: 'not_checked',
    },
  }
  const id = '11111111-1111-4111-8111-111111111111'
  const checksum = `sha256:${'a'.repeat(64)}`
  const item = {
    attachmentVersion: 1,
    artifact: {
      artifactVersion: 1,
      id,
      kind: 'file',
      mediaType: 'text/plain',
      byteSize: 13,
      checksum,
      ownership: { scope: 'project', projectId: project.id },
      source: { jobId: null, parentArtifactId: null },
      retention: { mode: 'keep' },
      reference: { state: 'referenced' },
      gc: { state: 'not_implemented' },
      createdAt: observedAt,
    },
    displayName: 'browser exact.txt',
    modelConsumption: { state: 'not_connected', reason: 'attachment_transport_only' },
    export: { state: 'available', rangeRequests: 'unsupported' },
  }
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  let persisted: typeof item[] = []
  // React StrictMode mounts the scoped loader twice in development.
  let listFailures = 2
  let postCalls = 0
  let downloadCalls = 0
  const intents: string[] = []
  const uploadBodies: Buffer[] = []
  const listQueries: Array<Record<string, string>> = []
  const forbiddenEffects: string[] = []

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/projects' && method === 'GET') {
      return route.fulfill(json({ projects: [project] }))
    }
    if (url.pathname === '/api/artifacts/policy' && method === 'GET') {
      return route.fulfill(json({
        policyVersion: 1,
        state: 'enabled',
        source: 'server_default_storage_policy',
        observedAt,
        maxBytes: 33_554_432,
        maxActiveTransfers: 1,
        maxQueuedTransfers: 8,
        rangeRequests: 'unsupported',
        modelCapability: 'not_applicable',
        reason: null,
      }))
    }
    if (url.pathname === '/api/artifacts' && method === 'GET') {
      listQueries.push(Object.fromEntries(url.searchParams))
      if (listFailures > 0 && url.searchParams.get('scope') === 'projectless') {
        listFailures -= 1
        return route.fulfill(json({
          code: 'storage_error',
          message: 'safe attachment browser failure',
          details: null,
        }, 500))
      }
      const scoped = url.searchParams.get('scope') === 'project'
        && url.searchParams.get('projectId') === project.id
      return route.fulfill(json({
        attachmentVersion: 1,
        scope: scoped ? 'project' : 'projectless',
        projectId: scoped ? project.id : null,
        attachments: scoped ? persisted : [],
        limit: 50,
        truncated: false,
      }))
    }
    if (url.pathname === '/api/artifacts' && method === 'POST') {
      postCalls += 1
      intents.push(request.headers()['idempotency-key'] ?? '')
      uploadBodies.push(request.postDataBuffer() ?? Buffer.alloc(0))
      expect(url.searchParams.get('scope')).toBe('project')
      expect(url.searchParams.get('projectId')).toBe(project.id)
      expect(url.searchParams.get('displayName')).toBe(item.displayName)
      persisted = [item]
      if (postCalls === 1) return route.abort('connectionreset')
      return route.fulfill(json(item, 201))
    }
    if (url.pathname === `/api/artifacts/${id}/content` && method === 'GET') {
      downloadCalls += 1
      expect(url.searchParams.get('scope')).toBe('project')
      expect(url.searchParams.get('projectId')).toBe(project.id)
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        headers: {
          'Content-Disposition': `attachment; filename="attachment-${id}"; filename*=UTF-8''browser%20exact.txt`,
          'Content-Length': '13',
          Digest: `sha-256=${Buffer.from('a'.repeat(64), 'hex').toString('base64')}`,
          ETag: `"${checksum}"`,
        },
        body: 'browser exact',
      })
    }
    if (
      method !== 'GET'
      || /models|jobs|threads|workspaces|tools|unload|providers|ollama/u.test(url.pathname)
    ) forbiddenEffects.push(`${method} ${url.pathname}`)
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })

  await page.goto('/attachments')
  const listError = page.getByRole('heading', { name: 'Не удалось загрузить вложения' })
  await expect(listError).toBeFocused()
  await expect(page.getByText('Не удалось сохранить запрос в локальное хранилище.')).toHaveCount(1)
  // D-203: no Retry button; the failed read recovers by itself. Regaining focus asks again at
  // once (StrictMode may leave one more armed failure, so focus is repeated until it lands).
  await expect(page.getByRole('button', { name: /^Повторить/u })).toHaveCount(0)
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByText('В этой области нет вложений')).toHaveCount(1, { timeout: 1_000 })
  }).toPass()
  await expect(page.getByText(/Стандартная storage policy сервера/u)).toHaveCount(1)
  await expect(page.getByText(/не capability модели/u)).toHaveCount(1)

  await pickValue(page, page.getByRole('combobox', { name: 'Область' }), project.id)
  await expect(page.getByRole('heading', { name: project.name })).toHaveCount(1)
  const input = page.getByLabel('Выберите или перетащите один локальный файл')
  await input.setInputFiles({
    name: item.displayName,
    mimeType: 'text/plain',
    buffer: Buffer.from('browser exact'),
  })
  const upload = page.getByRole('button', { name: 'Загрузить вложение' })
  // Upload completion must move focus only after React commits it, even when a frame
  // runs first: to the upload button after the failure, to the file input after success.
  await setFramesBeforePendingCommits(page, true)
  await upload.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => postCalls).toBe(1)
  // The failed upload keeps its own button (same intent), focused; no separate Retry.
  await expect(page.getByRole('button', { name: /^Повторить/u })).toHaveCount(0)
  await expect(upload).toBeFocused()
  await upload.press('Enter')
  await expect.poll(() => postCalls).toBe(2)
  expect(intents[0]).toMatch(/^[0-9a-f-]{36}$/u)
  expect(intents[1]).toBe(intents[0])
  expect(uploadBodies.map((body) => body.toString())).toEqual(['browser exact', 'browser exact'])
  await expect(page.getByRole('list', { name: 'Вложения в выбранной области' }).getByText(item.displayName)).toHaveCount(1)
  await expect(page.getByText(/Не добавлено в контекст модели/u)).toHaveCount(1)
  await expect(input).toBeFocused()
  await setFramesBeforePendingCommits(page, false)

  await page.reload()
  await pickValue(page, page.getByRole('combobox', { name: 'Область' }), project.id)
  await expect(page.getByRole('list', { name: 'Вложения в выбранной области' }).getByText(item.displayName)).toHaveCount(1)
  await expect(page.getByText(id)).toHaveCount(1)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Скачать' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('browser exact.txt')
  await expect.poll(() => downloadCalls).toBe(1)

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const downloadButton = page.getByRole('button', { name: 'Скачать' })
  await expect(downloadButton).toBeEnabled()
  await downloadButton.focus()
  await downloadButton.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(downloadButton).toBeFocused()
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    transitionProperty: getComputedStyle(document.activeElement!).transitionProperty,
    transitionDuration: getComputedStyle(document.activeElement!).transitionDuration,
    relevantAnimationCount: document.activeElement!.getAnimations({ subtree: true }).length,
    outlineStyle: getComputedStyle(document.activeElement!).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement!).outlineWidth,
    cardBorderWidth: getComputedStyle(document.querySelector('.attachment-card')!).borderWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.reducedMotion).toBe(true)
  expect(layout.forcedColors).toBe(true)
  expect(layout.transitionProperty).toBe('none')
  expect(layout.transitionDuration.split(',').every((value) => Number.parseFloat(value) === 0)).toBe(true)
  expect(layout.relevantAnimationCount).toBe(0)
  expect(layout.outlineStyle).toBe('solid')
  expect(layout.outlineWidth).toBe('3px')
  expect(layout.cardBorderWidth).not.toBe('0px')
  expect(listQueries.some((query) => JSON.stringify(query) === JSON.stringify({
    attachmentVersion: '1',
    scope: 'project',
    projectId: project.id,
    limit: '50',
  }))).toBe(true)
  expect(forbiddenEffects).toEqual([])
})
