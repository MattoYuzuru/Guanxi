import { expect, test, type Page } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'
import { installFetchLifecycle } from './fixtures/fetch-lifecycle.ts'

type ProjectFetchRead = {
  id: number
  aborted: boolean
  abortedAtNetworkStart: boolean | null
  state: 'pending' | 'fulfilled' | 'rejected'
}

declare global {
  interface Window {
    __guanxiProjectFetchReads?: ProjectFetchRead[]
  }
}

/**
 * The shared fetch lifecycle fixture observes health/runtime/models. Delay the
 * project read by one microtask as well, so StrictMode cleanup can abort it
 * before Playwright intercepts the network in the forced schedule. Record only
 * the signal ordering and promise state for GET /api/projects; never a body.
 */
async function deferProjectReadBeforeNetwork(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window)
    const reads: ProjectFetchRead[] = []
    window.__guanxiProjectFetchReads = reads
    window.fetch = async (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname
      if (method !== 'GET' || path !== '/api/projects') return nativeFetch(input, init)
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const read: ProjectFetchRead = {
        id: reads.length + 1,
        aborted: signal?.aborted ?? false,
        abortedAtNetworkStart: null,
        state: 'pending',
      }
      reads.push(read)
      const onAbort = () => { read.aborted = true }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await Promise.resolve()
        read.abortedAtNetworkStart = signal?.aborted ?? false
        const response = await nativeFetch(input, init)
        read.state = 'fulfilled'
        return response
      } catch (error) {
        read.state = 'rejected'
        throw error
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  })
}

async function projectFetchReads(page: Page): Promise<ProjectFetchRead[]> {
  return page.evaluate(() => window.__guanxiProjectFetchReads ?? [])
}

for (const deferNetworkStart of [false, true]) {
  test(`Projects exposes resilient keyboard flow without requiring a filesystem root (${deferNetworkStart ? 'abort before interception' : 'native timing'})`, async ({ page }) => {
    await installFetchLifecycle(page, deferNetworkStart)
    if (deferNetworkStart) await deferProjectReadBeforeNetwork(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const observedAt = '2026-08-09T10:00:00.000Z'
    const project = {
      id: 'project-browser',
      name: 'Keyboard Project',
      createdAt: observedAt,
      updatedAt: observedAt,
      filesystemBindings: [],
      presentationVersion: 1,
      iconKey: 'folder',
      colorToken: 'slate',
    }
    const legacyProject = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      filesystemBindings: project.filesystemBindings,
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
        platform: 'darwin',
        arch: 'arm64',
        cpuModel: 'fixture',
        cpuCores: 8,
        totalMemoryBytes: 16_000_000_000,
        usableMemoryBytes: 12_000_000_000,
        accelerator: 'metal',
        acceleratorName: 'fixture',
        unifiedMemory: true,
        freeDiskBytes: null,
      },
      network: {
        ollamaComReachable: null,
        checkedAt: null,
        status: 'unknown',
        source: 'not_checked',
      },
    }
    const json = (body: unknown, status = 200) => ({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })

    let releaseInitial!: () => void
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    // Every initial read fails until the explicit keyboard retry; StrictMode may
    // have reached the route once or twice, so the initial count is observed.
    let failProjectReads = true
    let projectReads = 0
    let retryReads = 0
    let createReloadReads = 0
    let projectCreates = 0
    const sideEffects: string[] = []

    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      if (url.pathname === '/api/health') return route.fulfill(json(health))
      if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
      if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
      if (url.pathname === '/api/projects' && method === 'GET') {
        expect(url.searchParams.get('presentationVersion')).toBe('1')
        projectReads += 1
        if (failProjectReads) {
          await initialGate
          return route.fulfill(json({ code: 'internal_error', message: 'safe fixture failure', details: null }, 500))
        }
        if (projectCreates === 0) retryReads += 1
        else createReloadReads += 1
        return route.fulfill(json({ presentationVersion: 1, projects: projectCreates === 0 ? [] : [project] }))
      }
      if (url.pathname === '/api/projects' && method === 'POST') {
        projectCreates += 1
        return route.fulfill(json(legacyProject, 201))
      }
      if (url.pathname === `/api/projects/${project.id}/chats` && method === 'GET') {
        return route.fulfill(json({ ownershipVersion: 1, project: legacyProject, chats: [] }))
      }
      if (method !== 'GET') sideEffects.push(`${method} ${url.pathname}`)
      return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
    })

    await page.goto('/projects')
    await expect(page.getByRole('status', { name: 'Загружаем проекты' })).toBeVisible()
    // Release the initial gate while every initial read still fails. Whether
    // StrictMode's aborted attempt reached the route or not, the committed
    // result must be the focused error heading.
    releaseInitial()
    const errorHeading = page.getByRole('heading', { name: 'Не удалось загрузить проекты' })
    await expect(errorHeading).toBeFocused()
    const initialReadCount = projectReads
    expect(initialReadCount).toBeGreaterThanOrEqual(1)
    if (deferNetworkStart) {
      // Route counts cannot see an attempt Chromium drops. Record the signal on
      // the actual fetch call, and assert at least one project read was already
      // aborted before the network started. The focused committed error and
      // initialReadCount >= 1 above prove a non-aborted read reached the route;
      // no total StrictMode attempt count is assumed.
      await expect.poll(async () => (await projectFetchReads(page))
        .some((read) => read.abortedAtNetworkStart === true)).toBe(true)
    }

    // Switch to the empty projection only after the error is committed and
    // focused, immediately before the explicit keyboard retry.
    failProjectReads = false
    await page.getByRole('button', { name: 'Повторить', exact: true }).press('Enter')
    await expect(page.getByText('Проектов пока нет')).toBeVisible()
    await expect.poll(() => retryReads).toBe(1)
    expect(projectReads).toBe(initialReadCount + 1)

    const name = page.getByRole('textbox', { name: 'Название проекта' })
    await name.fill('Keyboard Project')
    await name.evaluate((input) => {
      const form = input.closest('form')!
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await expect.poll(() => projectCreates).toBe(1)
    await expect(page.getByRole('textbox', { name: 'Переименовать — Keyboard Project' })).toBeVisible()
    await expect(page.getByText('Нет привязки к файловой системе')).toBeVisible()
    await expect(page.getByLabel(/path|root|папк/iu)).toHaveCount(0)
    await expect.poll(() => createReloadReads).toBe(1)
    expect(projectReads).toBe(initialReadCount + 2)

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }))
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)

    const motion = await page.locator('article').evaluate((element) => {
      const style = getComputedStyle(element)
      return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration }
    })
    expect(['0s', '1e-05s']).toContain(motion.animationDuration)
    expect(['0s', '1e-05s']).toContain(motion.transitionDuration)
    expect(sideEffects).toEqual([])
  })
}
