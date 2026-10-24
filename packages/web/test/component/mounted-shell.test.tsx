import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SESSION_ROUTES } from '@guanxi/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { ThemeProvider } from '../../src/lib/theme.tsx'
import { App } from '../../src/App.tsx'
import { SHELL_PREFERENCES_KEY } from '../../src/features/shell/preferences.ts'
import { browserSettings, runtimeBrowserSnapshot } from '../browser/fixtures/runtime-snapshot.ts'

const lazyWorkspace = vi.hoisted(() => ({ loads: 0 }))

vi.mock('../../src/features/workspace/Workspace.tsx', async () => {
  lazyWorkspace.loads += 1
  const { createElement } = await import('react')
  return {
    Workspace: ({ children }: { children?: unknown }) =>
      createElement('section', { 'data-testid': 'workspace-boundary' }, children as never),
  }
})

const observedAt = '2026-10-22T12:00:00.000Z'
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
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
  return new URL(raw, window.location.origin).pathname
}

function installApi(locale: 'en' | 'ru' = 'en') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = pathOf(input)
    if (path === '/api/health') return json(health)
    if (path === '/api/runtime') return json(runtimeBrowserSnapshot())
    if (path === '/api/settings') {
      return json(browserSettings({ locale, localeSource: 'user_setting' }))
    }
    if (path === '/api/models') return json({ models: [] })
    if (path === '/api/workspaces') return json({ workspaces: [] })
    if (path === '/api/threads') {
      return json({ ownershipVersion: 1, scope: 'projectless', chats: [] })
    }
    if (path === SESSION_ROUTES.page()) {
      return json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
    }
    if (path === '/api/projects') return json({ projects: [] })
    if (path === '/api/layouts/context') return json({ account: 'local', replication: false })
    if (path === '/api/layouts') return json({ documents: [], active: [] })
    if (path === '/api/layouts/geometry') return json({ geometry: {} })
    return json({ code: 'internal_error', message: path, details: null }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderApp(path: string) {
  window.history.replaceState(null, '', path)
  return render(<ThemeProvider><App /></ThemeProvider>)
}

async function shell() {
  return screen.findByRole('navigation', { name: 'Main navigation' })
}

/** The intended session state: the canonical empty page, not the fixture's error fallback. */
async function emptySessions() {
  const region = await screen.findByRole('region', { name: 'Sessions' })
  expect(await within(region).findByText('No sessions yet. Start a new session.')).toBeTruthy()
  expect(within(region).queryByRole('alert')).toBeNull()
}

async function choose(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Navigation sidebar' }))
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: label }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

function runtimeCalls(fetchMock: ReturnType<typeof installApi>) {
  return fetchMock.mock.calls.filter(([input]) => pathOf(input) === '/api/runtime')
}

const storage = new Map<string, string>()

function installStorage(): Storage {
  const value = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, next: string) => { storage.set(key, next) },
    removeItem: (key: string) => { storage.delete(key) },
    clear: () => { storage.clear() },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size },
  }
  vi.stubGlobal('localStorage', value)
  return value as Storage
}

beforeEach(() => {
  setActiveLocale('en')
  storage.clear()
  installStorage()
  window.history.replaceState(null, '', '/')
  installApi()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mounted product shell', () => {
  it('mounts one shell and one SidebarSlot around the real App chat route', async () => {
    const fetchMock = installApi()
    const { container } = renderApp('/chat')
    const navigation = await shell()
    await emptySessions()

    expect(within(navigation).getAllByRole('link')).toHaveLength(4)
    expect(within(navigation).getAllByRole('link').map(link => link.getAttribute('href')))
      .toEqual(['/agent', '/projects', '/', '/settings'])
    expect(container.querySelectorAll('main')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="sidebar-slot"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="app-shell-sidebar"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="app-shell-chrome"]')).toHaveLength(1)
    // D-202/D-203: no runtime bar and no Developer/Visual chips; one row of icon status items.
    expect(screen.queryAllByRole('region', { name: 'Runtime and resources' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^(Developer|Visual)$/u })).toHaveLength(0)
    expect(screen.getAllByTestId('shell-status-items')).toHaveLength(1)
    expect(screen.queryByRole('banner')).toBeNull()

    await waitFor(() => expect(container.querySelectorAll('li[data-plugin-entry]')).toHaveLength(1))
    expect(container.querySelectorAll('li[data-plugin-entry]')).toHaveLength(1)

    await waitFor(() => expect(screen.getByRole('button', { name: 'This device' })).toBeTruthy())
    expect(screen.queryAllByRole('button', { name: /: Unknown$/u })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^(Quota|Keep awake|Power)\b/u })).toHaveLength(0)
    await waitFor(() => expect(runtimeCalls(fetchMock)).toHaveLength(1))

    // D-205: the toggle swaps light and dark only; the stored default stays "system" until used.
    const toggle = () => screen.getByTestId('shell-theme-toggle')
    const darkAtStart = window.document.documentElement.classList.contains('dark')
    expect(toggle().getAttribute('aria-label')).toBe(darkAtStart ? 'Switch to the light theme' : 'Switch to the dark theme')
    fireEvent.click(toggle())
    expect(window.document.documentElement.classList.contains('dark')).toBe(!darkAtStart)
    fireEvent.click(toggle())
    expect(window.document.documentElement.classList.contains('dark')).toBe(darkAtStart)
    expect(window.localStorage.getItem('guanxi.theme')).toBe(darkAtStart ? 'dark' : 'light')
    expect(toggle().textContent).toBe('')
  })

  it('preserves actual route content through move, rail, hide and show without duplicating navigation', async () => {
    const fetchMock = installApi()
    renderApp('/chat')
    await shell()
    const heading = await screen.findByRole('heading', { name: 'New conversation' })
    heading.dataset['identity'] = 'original'
    const push = vi.spyOn(window.history, 'pushState')

    await choose('Move sidebar to the right')
    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' }).getAttribute('data-side'))
      .toBe('right')
    expect(screen.getByRole('heading', { name: 'New conversation' })).toBe(heading)
    expect(heading.dataset['identity']).toBe('original')

    await choose('Collapse sidebar to a rail')
    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' }).getAttribute('data-visibility'))
      .toBe('rail')
    expect(screen.getByRole('heading', { name: 'New conversation' })).toBe(heading)
    expect(document.querySelectorAll('[data-slot="sidebar-slot"]')).toHaveLength(1)

    await choose('Hide sidebar')
    const sidebar = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar"]')!
    expect(sidebar.hidden).toBe(true)
    expect(sidebar.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('heading', { name: 'New conversation' })).toBe(heading)
    const show = screen.getByRole('button', { name: 'Show sidebar' })
    await waitFor(() => expect(document.activeElement).toBe(show))

    fireEvent.click(show)
    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' }).getAttribute('data-visibility'))
      .toBe('expanded')
    // Showing the sidebar moves focus into it (its menu now lives in the strip).
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('complementary', { name: 'Navigation sidebar' })))
    expect(screen.getByRole('heading', { name: 'New conversation' })).toBe(heading)
    expect(document.querySelectorAll('main')).toHaveLength(1)
    await waitFor(() => expect(document.querySelectorAll('li[data-plugin-entry]')).toHaveLength(1))
    expect(push).not.toHaveBeenCalled()
    expect(runtimeCalls(fetchMock)).toHaveLength(1)
  })

  it('changes location exactly once for each of the four fixed navigation links', async () => {
    renderApp('/chat')
    const navigation = await shell()
    const push = vi.spyOn(window.history, 'pushState')
    const destinations = [
      ['Projects', '/projects'],
      ['Models', '/'],
      ['New', '/agent'],
      ['Settings', '/settings'],
    ] as const

    for (const [name, path] of destinations) {
      const before = push.mock.calls.length
      fireEvent.click(within(navigation).getByRole('link', { name }))
      await waitFor(() => expect(window.location.pathname).toBe(path))
      expect(push).toHaveBeenCalledTimes(before + 1)
      expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy()
      expect(document.querySelectorAll('main')).toHaveLength(1)
    }
  })

  it('keeps one Ctrl/Meta+K handler and executes one palette action while navigation is hidden', async () => {
    renderApp('/projects')
    await shell()
    await choose('Hide sidebar')
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy()
    const push = vi.spyOn(window.history, 'pushState')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const search = within(dialog).getByRole('combobox', { name: 'Search commands' })
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Show sidebar' })))

    fireEvent.keyDown(window, { key: 'K', metaKey: true })
    await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const reopened = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.change(within(reopened).getByRole('combobox'), { target: { value: 'Chat' } })
    fireEvent.click(within(reopened).getByRole('option', { name: 'Chat' }))
    await waitFor(() => expect(window.location.pathname).toBe('/chat'))
    expect(push).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main navigation', hidden: true })).toBeTruthy()
  })

  it('keeps the Workspace lazy boundary and mounts it only on the workspace route', async () => {
    lazyWorkspace.loads = 0
    renderApp('/chat')
    await shell()
    await screen.findByRole('heading', { name: 'New conversation' })
    expect(lazyWorkspace.loads).toBe(0)
    expect(screen.queryByTestId('workspace-boundary')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'Session workspace' } })
    fireEvent.click(within(dialog).getByRole('option', { name: 'Session workspace' }))
    await waitFor(() => expect(window.location.pathname).toBe('/workspace'))
    expect(await screen.findByTestId('workspace-boundary')).toBeTruthy()
    expect(lazyWorkspace.loads).toBe(1)
    expect(await screen.findByRole('heading', { name: 'New conversation' })).toBeTruthy()
    expect(document.querySelectorAll('main')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="sidebar-slot"]')).toHaveLength(1)
  })

  it('shows the unreachable server before the shell mounts and recovers by itself, with no Retry (D-203)', async () => {
    let healthState: 'fail' | 'ok' = 'fail'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input)
      if (path === '/api/health') {
        return healthState === 'fail'
          ? json({ code: 'internal_error', message: 'offline', details: null }, 503)
          : json(health)
      }
      if (path === '/api/runtime') return json(runtimeBrowserSnapshot())
      if (path === '/api/settings') return json(browserSettings({ locale: 'en' }))
      if (path === SESSION_ROUTES.page()) {
        return json({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
      }
      return json({ code: 'internal_error', message: path, details: null }, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderApp('/chat')

    expect(await screen.findByRole('heading', { name: 'The Guanxi server is not responding' }))
      .toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull()
    expect(screen.queryAllByRole('button', { name: /check again|retry/iu })).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('Guanxi reconnects by itself as soon as the server answers.')
    healthState = 'ok'
    // The read recovers on focus (or on its backoff timer) without any button.
    act(() => { window.dispatchEvent(new Event('focus')) })
    await shell()
    expect(fetchMock.mock.calls.filter(([input]) => pathOf(input) === '/api/health').length)
      .toBeGreaterThanOrEqual(2)
  })

  it('starts with defaults when shell preferences are corrupt or denied', async () => {
    window.localStorage.setItem(SHELL_PREFERENCES_KEY, '{not-json')
    const first = renderApp('/chat')
    await shell()
    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' }).getAttribute('data-side'))
      .toBe('left')
    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' }).getAttribute('data-visibility'))
      .toBe('expanded')
    first.unmount()

    vi.stubGlobal('localStorage', {
      getItem() { throw new DOMException('denied', 'SecurityError') },
      setItem() { throw new DOMException('denied', 'SecurityError') },
      removeItem() { throw new DOMException('denied', 'SecurityError') },
      clear() { throw new DOMException('denied', 'SecurityError') },
      key() { throw new DOMException('denied', 'SecurityError') },
      length: 0,
    })
    renderApp('/chat')
    await shell()
    await choose('Hide sidebar')
    expect(document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar"]')!.hidden).toBe(true)
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy()
  })
})
