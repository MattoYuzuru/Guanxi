import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionScreen } from '../../src/features/new-session/NewSessionScreen.tsx'
import { RECENT_PROJECTS_KEY, readRecentProjects, rememberProject } from '../../src/features/new-session/recent.ts'
import { LAST_MODEL_CHOICE_KEY } from '../../src/features/new-session/model-choice.ts'
import { newSessionEnglish, newSessionRussian } from '../../src/features/new-session/messages.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const LOCAL = '22222222-2222-4222-8222-222222222222'
const connection = (id: string, name: string, kind: 'model_api' | 'local_runtime') => ({ id, accountId: 'local', name, kind,
  provider: kind === 'model_api' ? 'deepseek' : 'ollama', auth: kind === 'model_api' ? 'api_key' : 'none', unattended: false, secretRef: null,
  facts: {}, createdAt: '2026-10-21T00:00:00.000Z', balance: null })
const project = (id: string, name: string, bindings: string[] = []) => ({ id, name, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
  filesystemBindings: bindings.map(workspaceId => ({ workspaceId })) })

interface Fixture {
  projects?: unknown[]; connections?: unknown[]; workspaces?: unknown[] | 'fail'; create?: () => Response | Promise<Response>
  network?: 'down'; patch?: () => Response
}
function install(fixture: Fixture = {}) {
  const calls = { create: [] as unknown[], projects: 0, connections: 0, workspaces: 0, patch: [] as unknown[] }
  const state = { ...fixture }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (state.network === 'down') throw new TypeError('Failed to fetch')
    if (path === '/api/agent/projects') { calls.projects++; return Response.json({ projects: state.projects ?? [project('p', 'Alpha')] }) }
    if (path === '/api/connections') { calls.connections++; return Response.json({ connections: state.connections ?? [connection(CONNECTION, 'Fixture model', 'model_api')], costs: [], vault: { unlocked: false, unattendedAvailable: false } }) }
    if (path === '/api/workspaces') {
      calls.workspaces++
      if (state.workspaces === 'fail') return Response.json({ code: 'internal_error', message: 'x', details: null }, { status: 500 })
      return Response.json({ workspaces: state.workspaces ?? [] })
    }
    if (path === '/api/agent' && init?.method === 'POST') {
      calls.create.push(JSON.parse(String(init.body)))
      return state.create ? state.create() : Response.json({ sessionId: 'session-1' }, { status: 202 })
    }
    if (path.startsWith('/api/connections/') && path.endsWith('/models')) {
      return Response.json([{ id: 'fixture', facts: {} }, { id: 'fixture-large', facts: {} }])
    }
    if (path.startsWith('/api/models')) return Response.json({ models: [] })
    if (path.startsWith('/api/agent/projects/') && init?.method === 'PATCH') { calls.patch.push(JSON.parse(String(init.body))); return state.patch ? state.patch() : Response.json({}) }
    throw new Error(`Unexpected request ${path}`)
  }))
  return { calls, state }
}
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const prompt = () => field('What should the agent do?')
const start = () => screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement
/** Send stays focusable while blocked (focusableWhenDisabled), so "blocked" is aria-disabled. */
const blocked = () => start().disabled || start().getAttribute('aria-disabled') === 'true'
const hint = () => document.getElementById('new-session-needs')?.textContent
const retryButtons = () => screen.queryAllByRole('button', { name: /Retry|Refresh|Try again/ })
async function ready() { await waitFor(() => expect(screen.queryByText('Loading session choices…')).toBeNull()); await screen.findByRole('region', { name: 'New session' }) }
/** Opens the model popover at the composer's lower right unless it is already open. */
async function openModel() {
  if (screen.queryByRole('group', { name: 'Connection' })) return
  fireEvent.click(screen.getByRole('button', { name: /^(Choose a model|Model: |Model connection: )/ }))
  await screen.findByRole('group', { name: 'Connection' })
}
/** Opens the run options popover at the composer's lower left unless it is already open. */
async function openOptions() {
  if (screen.queryByLabelText('Network allowlist (comma-separated hosts)')) return
  fireEvent.click(screen.getByRole('button', { name: 'Run options' }))
  await screen.findByLabelText('Network allowlist (comma-separated hosts)')
}
async function chooseProject(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /^(Choose a project|Project: )/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(name) }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}
async function chooseMode(label: 'Read-only' | 'Full access') {
  fireEvent.click(screen.getByRole('button', { name: /^Access: / }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
  await waitFor(() => expect(screen.getByRole('button', { name: `Access: ${label}` })).toBeTruthy())
}
async function chooseModel(id = 'fixture') {
  const option = await screen.findByRole('option', { name: id })
  await act(async () => { fireEvent.click(option) })
}
/** The default fixture has one project and one connection, both preselected. */
async function fillValid() {
  await openModel()
  await chooseModel()
  fireEvent.change(prompt(), { target: { value: 'Inspect' } })
}

beforeEach(() => {
  setActiveLocale('en')
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  window.history.replaceState(null, '', '/agent')
})
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })

describe('new-session screen states', () => {
  it('shows a skeleton with a status while loading and no composer, then the composer', async () => {
    let release: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => String(url) === '/api/agent/projects'
      ? new Promise<Response>(resolve => { release = resolve }) : Promise.resolve(Response.json(String(url) === '/api/workspaces' ? { workspaces: [] } : { connections: [connection(CONNECTION, 'Fixture model', 'model_api')], costs: [], vault: { unlocked: false, unattendedAvailable: false } }))))
    render(<NewSessionScreen />)
    expect(screen.getAllByRole('status').filter(node => node.textContent === 'Loading session choices…')).toHaveLength(1)
    expect(screen.getAllByTestId('new-session-skeleton')).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'New session' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'What should the agent do?' })).toBeNull()
    await act(async () => { release(Response.json({ projects: [project('p', 'Alpha')] })) })
    await waitFor(() => expect(screen.queryByTestId('new-session-skeleton')).toBeNull())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What should the agent do?')
    expect(screen.getAllByRole('textbox', { name: 'What should the agent do?' })).toHaveLength(1)
  })

  it('has exactly one empty state with one primary action when there is no project, and when there is no connection', async () => {
    install({ projects: [] })
    const view = render(<NewSessionScreen />)
    await screen.findByText('No projects yet. Create a project to start a session.')
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Open Projects' }).getAttribute('href')).toBe('/projects')
    expect(screen.queryByRole('region', { name: 'New session' })).toBeNull()
    view.unmount()
    install({ connections: [] })
    render(<NewSessionScreen />)
    await screen.findByText('No model connection yet. Add one in Settings to start a session.')
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings')
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull()
  })

  it('reports a rejected source with name, time and copyable code, offers no Retry and recovers by itself', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url)
      if (path === '/api/agent/projects') { attempts++; return attempts === 1 ? Response.json({ code: 'egress_unavailable' }, { status: 503 }) : Response.json({ projects: [project('p', 'Alpha')] }) }
      if (path === '/api/connections') return Response.json({ connections: [connection(CONNECTION, 'Fixture model', 'model_api')], costs: [], vault: { unlocked: false, unattendedAvailable: false } })
      return Response.json({ workspaces: [] })
    }))
    render(<NewSessionScreen />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Session choices could not be loaded. The node is still preparing secret protection')
    expect(within(alert).getByText('GET /api/agent/projects')).toBeTruthy()
    expect(alert.textContent).toContain('egress_unavailable')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(blocked()).toBe(true)
    expect(hint()).toBe('Wait for the session choices; Guanxi loads them again by itself.')
    expect(retryButtons()).toHaveLength(0)
    // Focus is one of the automatic recovery triggers (the other is a growing timer).
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
    expect(attempts).toBe(2)
    expect(screen.getByRole('button', { name: 'Project: Alpha' })).toBeTruthy()
  })

  it('retries a failed load on a growing timer without any user action', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      let attempts = 0
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = String(url)
        if (path === '/api/agent/projects') { attempts++; return attempts === 1 ? Response.json({ code: 'internal_error' }, { status: 500 }) : Response.json({ projects: [project('p', 'Alpha')] }) }
        if (path === '/api/connections') return Response.json({ connections: [connection(CONNECTION, 'Fixture model', 'model_api')], costs: [], vault: { unlocked: false, unattendedAvailable: false } })
        return Response.json({ workspaces: [] })
      }))
      render(<NewSessionScreen />)
      await screen.findByRole('alert')
      expect(attempts).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
      await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
      expect(attempts).toBe(2)
      expect(retryButtons()).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('keeps a repeated failure quiet: no skeleton flash, the same alert record, and no focus jump', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      let attempts = 0
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = String(url)
        if (path === '/api/agent/projects') { attempts++; return attempts < 3 ? Response.json({ code: 'internal_error' }, { status: 500 }) : Response.json({ projects: [project('p', 'Alpha')] }) }
        if (path === '/api/connections') return Response.json({ connections: [connection(CONNECTION, 'Fixture model', 'model_api')], costs: [], vault: { unlocked: false, unattendedAvailable: false } })
        return Response.json({ workspaces: [] })
      }))
      render(<NewSessionScreen />)
      const alert = await screen.findByRole('alert')
      const recorded = alert.querySelector('time')?.getAttribute('datetime')
      const outside = document.createElement('button'); document.body.append(outside); outside.focus()
      let skeletonSeen = false
      const observer = new MutationObserver(() => { if (screen.queryByTestId('new-session-skeleton')) skeletonSeen = true })
      observer.observe(document.body, { childList: true, subtree: true })
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
      await waitFor(() => expect(attempts).toBe(2))
      // The second, identical failure changes nothing on screen.
      expect(screen.getByRole('alert')).toBe(alert)
      expect(alert.querySelector('time')?.getAttribute('datetime')).toBe(recorded)
      expect(document.activeElement).toBe(outside)
      await act(async () => { await vi.advanceTimersByTimeAsync(4_100) })
      await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
      expect(attempts).toBe(3)
      observer.disconnect(); outside.remove()
      expect(skeletonSeen).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('names the unreachable node when no answer arrives and never starts a session', async () => {
    const { calls } = install({ network: 'down' })
    render(<NewSessionScreen />)
    const status = await waitFor(() => { const node = document.querySelector('[data-state="node_unreachable"]'); if (!node) throw new Error('not yet'); return node })
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toContain('The node is not answering')
    expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(retryButtons()).toHaveLength(0)
    expect(blocked()).toBe(true)
    fireEvent.click(start())
    fireEvent.submit(start().closest('form')!)
    expect(calls.create).toHaveLength(0)
  })

  it('keeps the last loaded choices with their age when a refresh finds the node unreachable, and recovers by itself', async () => {
    const { calls, state } = install({ projects: [project('p', 'Alpha')], workspaces: [{ id: 'w1', name: 'Repo', rootPath: '/r', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: true }] })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    expect(blocked()).toBe(false)
    // Saving folders reloads the choices; the node answers the save and then stops answering.
    state.patch = () => { state.network = 'down'; return Response.json({}) }
    await openOptions()
    fireEvent.click(screen.getByRole('button', { name: 'Repo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save folders' }))
    const status = await waitFor(() => { const node = document.querySelector('[data-state="node_unreachable"]'); if (!node) throw new Error('not yet'); return node })
    expect(status.textContent).toMatch(/Last loaded at .+\./)
    expect(status.textContent).not.toMatch(/ago|just now/u)
    expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Project: Alpha' })).toBeTruthy()
    expect(blocked()).toBe(true)
    expect(hint()).toBe('Reconnect to the node.')
    expect(retryButtons()).toHaveLength(0)
    fireEvent.submit(start().closest('form')!)
    expect(calls.create).toHaveLength(0)
    state.network = undefined
    const before = calls.projects
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(document.querySelector('[data-state="node_unreachable"]')).toBeNull())
    expect(calls.projects).toBe(before + 1)
    expect(blocked()).toBe(false)
  })

  it('does not call the node unreachable only because the browser reports no network', async () => {
    const { calls } = install()
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(document.querySelector('[data-state="node_unreachable"]')).toBeNull()
    expect(blocked()).toBe(false)
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  })

  it('degrades to a visible message when only the folder list is missing and still starts', async () => {
    const { calls } = install({ workspaces: 'fail', projects: [project('p', 'Alpha', ['w1'])] })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    await openOptions()
    expect(screen.getAllByText(/GET \/api\/workspaces/)).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'Project folders' })).toBeNull()
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
  })
})

describe('new-session start flow', () => {
  it('names the first missing need, in order, and says ready once the composer is complete', async () => {
    install({ projects: [project('a', 'Alpha'), project('b', 'Beta')], connections: [connection(CONNECTION, 'Fixture model', 'model_api'), connection(LOCAL, 'Local Ollama', 'local_runtime')] })
    render(<NewSessionScreen />)
    await ready()
    expect(screen.getByRole('button', { name: 'Choose a project' })).toBeTruthy()
    expect(hint()).toBe('Choose a project.')
    expect(start().getAttribute('aria-describedby')).toBe('new-session-needs')
    expect(blocked()).toBe(true)
    await chooseProject('Alpha')
    expect(hint()).toBe('Choose a model connection.')
    await openModel()
    fireEvent.click(screen.getByRole('button', { name: 'Fixture model' }))
    expect(screen.getByRole('button', { name: 'Fixture model' }).getAttribute('aria-pressed')).toBe('true')
    expect(hint()).toBe('Enter a model ID.')
    await chooseModel()
    expect(hint()).toBe('Describe the task.')
    expect(blocked()).toBe(true)
    fireEvent.change(prompt(), { target: { value: 'Inspect' } })
    expect(hint()).toBe('Ready to start.')
    expect(blocked()).toBe(false)
  })

  it('opens in the current project and preselects the only connection', async () => {
    rememberProject('b')
    install({ projects: [project('a', 'Alpha'), project('b', 'Beta')] })
    render(<NewSessionScreen />)
    await ready()
    expect(screen.getByRole('button', { name: 'Project: Beta' })).toBeTruthy()
    await openModel()
    expect(screen.getByRole('button', { name: 'Fixture model' }).getAttribute('aria-pressed')).toBe('true')
    expect(hint()).toBe('Enter a model ID.')
  })

  it('submits one session with the defaults and navigates to it, remembering the project only after success', async () => {
    const { calls } = install()
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    expect(screen.getByRole('button', { name: 'Access: Read-only' })).toBeTruthy()
    expect(readRecentProjects()).toEqual([])
    fireEvent.click(start())
    await waitFor(() => expect(window.location.pathname).toBe('/agent/session-1'))
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0]).toEqual({ projectId: 'p', connectionId: CONNECTION, model: 'fixture', mode: 'read-only', prompt: 'Inspect',
      retention: 'ttl', domains: [], attachmentIds: [], protectedPaths: [] })
    expect(readRecentProjects()).toEqual(['p'])
  })

  it('sends exactly one request for a double Enter, ignores Shift+Enter and composition, and never sends while blocked', async () => {
    const { calls } = install({ create: () => new Response(JSON.stringify({ sessionId: 'session-1' }), { status: 202, headers: { 'Content-Type': 'application/json' } }) })
    render(<NewSessionScreen />)
    await ready()
    fireEvent.change(prompt(), { target: { value: 'Inspect' } })
    // Blocked (no model yet): Enter sends nothing. The composer contract keeps newlines on Shift+Enter.
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(calls.create).toHaveLength(0)
    await fillValid()
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true })).toBe(true)
    expect(calls.create).toHaveLength(0)
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', isComposing: true })).toBe(true)
    expect(calls.create).toHaveLength(0)
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(false)
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    fireEvent.click(start())
    await waitFor(() => expect(window.location.pathname).toBe('/agent/session-1'))
    expect(calls.create).toHaveLength(1)
  })

  it.each([
    ['root_busy', 'Another full-access session already uses one of these folders'],
    ['protected_path_invalid', 'A protected path is outside the project folders'],
    ['egress_unavailable', 'still preparing secret protection'],
    ['something_new', 'The node could not start the session'],
  ])('explains a rejected start (%s), keeps every input, focuses the failure and does not remember the project', async (code, copy) => {
    const { calls } = install({ create: () => Response.json({ code }, { status: 409 }) })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    fireEvent.click(start())
    const title = await screen.findByRole('alert')
    expect(title.textContent).toContain('The session could not be started')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('POST /api/agent')
    expect(screen.getByRole('alert').textContent).toContain(code)
    await waitFor(() => expect(document.activeElement).toBe(title.closest('[tabindex="-1"]')))
    expect(title.textContent).toContain(copy) // the specific reason is inside the announced alert
    expect(prompt().value).toBe('Inspect')
    expect(screen.getByRole('button', { name: 'Model: Fixture model, fixture' })).toBeTruthy()
    expect(window.location.pathname).toBe('/agent')
    expect(readRecentProjects()).toEqual([])
    expect(calls.create).toHaveLength(1)
    expect(retryButtons()).toHaveLength(0)
    expect(blocked()).toBe(false)
  })

  it('says the outcome is unknown when the node never answers a start, keeps the inputs and never navigates', async () => {
    const { calls, state } = install()
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    state.create = () => { throw new TypeError('Failed to fetch') }
    fireEvent.click(start())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('it is unknown whether the session started')
    expect(alert.textContent).toContain('unreachable')
    expect(alert.textContent).not.toContain('could not start the session. Check')
    expect(window.location.pathname).toBe('/agent')
    expect(calls.create).toHaveLength(1)
    expect(prompt().value).toBe('Inspect')
  })

  it('does not navigate when the screen was left while the node was starting the session', async () => {
    let release: (response: Response) => void = () => {}
    const { calls } = install({ create: () => new Promise<Response>(resolve => { release = resolve }) as never })
    const view = render(<NewSessionScreen />)
    await ready(); await fillValid()
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
    view.unmount()
    await act(async () => { release(Response.json({ sessionId: 'session-1' }, { status: 202 })) })
    expect(window.location.pathname).toBe('/agent')
    expect(readRecentProjects()).toEqual(['p'])
  })

  it('shows changed options as chips only for non-default values with exact counts', async () => {
    install({ projects: [project('p', 'Alpha', ['w1'])], workspaces: [{ id: 'w1', name: 'Repo', rootPath: '/r', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: true }, { id: 'w2', name: 'Docs', rootPath: '/d', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: false }] })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    const chips = () => screen.queryByRole('list', { name: 'Changed options' })?.querySelectorAll('li').length ?? 0
    expect(chips()).toBe(0)
    await chooseMode('Full access')
    expect(chips()).toBe(1)
    await openOptions()
    fireEvent.change(field('Network allowlist (comma-separated hosts)'), { target: { value: 'example.com, localhost:3000' } })
    fireEvent.change(field('Protected paths (one per line)'), { target: { value: 'a\nb\n\nc' } })
    fireEvent.change(field('Project attachment IDs (comma-separated; upload in Attachments)'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Docs (not found on disk)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Docs/ }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }))
    expect(screen.getByRole('button', { name: /Docs/ }).getAttribute('aria-pressed')).toBe('true')
    const items = Array.from(screen.getByRole('list', { name: 'Changed options' }).querySelectorAll('li')).map(node => node.textContent)
    expect(items).toEqual(['Access: Full access', 'Network hosts: 2', 'Protected paths: 3', 'Attachments: 1', 'Folders to save: 2'])
    await chooseMode('Read-only')
    expect(chips()).toBe(4)
  })

  it('marks invalid hosts and context, blocks starting, and requires the context only for local runtimes', async () => {
    const { calls } = install({ connections: [connection(CONNECTION, 'Fixture model', 'model_api'), connection(LOCAL, 'Local Ollama', 'local_runtime')] })
    render(<NewSessionScreen />)
    await ready()
    await openModel()
    fireEvent.click(screen.getByRole('button', { name: 'Fixture model' }))
    await fillValid()
    expect(screen.queryByLabelText('Context window, tokens')).toBeNull()
    await openOptions()
    const domains = field('Network allowlist (comma-separated hosts)')
    fireEvent.change(domains, { target: { value: 'localhost' } })
    expect(domains.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/Use host names, or host:port/)).toBeTruthy()
    expect(blocked()).toBe(true)
    expect(hint()).toBe('Fix the options marked as invalid.')
    fireEvent.change(domains, { target: { value: 'localhost:3000' } })
    expect(domains.getAttribute('aria-invalid')).toBeNull()
    expect(blocked()).toBe(false)
    await openModel()
    fireEvent.click(screen.getByRole('button', { name: 'Local Ollama' }))
    expect(blocked()).toBe(true)
    expect(hint()).toBe('Enter a model ID.')
    await chooseModel()
    expect(hint()).toBe('Set the context window in the model picker.')
    const context = await screen.findByLabelText('Context window, tokens') as HTMLInputElement
    fireEvent.change(context, { target: { value: '12.5' } })
    expect(context.getAttribute('aria-invalid')).toBe('true')
    expect(blocked()).toBe(true)
    fireEvent.change(context, { target: { value: '8192' } })
    expect(blocked()).toBe(false)
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
    expect(calls.create[0]).toMatchObject({ connectionId: LOCAL, contextTokens: 8192, domains: ['localhost:3000'] })
  })

  it('saves project folders through the project route exactly once and reports a failed save', async () => {
    const { calls, state } = install({ projects: [project('p', 'Alpha')], workspaces: [{ id: 'w1', name: 'Repo', rootPath: '/r', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: true }] })
    render(<NewSessionScreen />)
    await ready()
    expect(screen.getByText('No folders, scratch only')).toBeTruthy()
    await fillValid()
    await openOptions()
    const save = screen.getByRole('button', { name: 'Save folders' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Repo' }))
    expect(save.disabled).toBe(false)
    expect(hint()).toBe('Save the folder changes under Run options, or restore the folders.')
    expect(blocked()).toBe(true)
    state.patch = () => Response.json({ code: 'root_unavailable' }, { status: 503 })
    fireEvent.click(save)
    const failure = await screen.findByRole('alert')
    expect(failure.textContent).toContain('A project folder is unavailable')
    expect(failure.textContent).not.toContain('could not start the session')
    expect(calls.patch).toEqual([{ workspaceIds: ['w1'] }])
  })
})

describe('recent projects', () => {
  it('opens in the most recent existing project, lists remembered projects first and selects without a duplicate entry', async () => {
    rememberProject('gone'); rememberProject('a'); rememberProject('b')
    install({ projects: [project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')] })
    render(<NewSessionScreen />)
    await ready()
    expect(screen.getByRole('button', { name: 'Project: Beta' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Project: Beta' }))
    const menu = await screen.findByRole('menu')
    const names = within(menu).getAllByRole('menuitem').map(item => ['Alpha', 'Beta', 'Gamma'].find(name => item.textContent?.includes(name)))
    expect(names).toEqual(['Beta', 'Alpha', 'Gamma'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Alpha/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project: Alpha' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Project: Alpha' }))
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem')).toHaveLength(3)
  })
  it('opens in the project named by the route over the most recent one, and ignores an unknown one (P2)', async () => {
    rememberProject('a')
    install({ projects: [project('a', 'Alpha'), project('b', 'Beta')] })
    window.history.replaceState(null, '', '/agent?project=b')
    const view = render(<NewSessionScreen />)
    await ready()
    expect(screen.getAllByRole('button', { name: 'Project: Beta' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Project: Alpha' })).toBeNull()
    view.unmount()
    window.history.replaceState(null, '', '/agent?project=missing')
    render(<NewSessionScreen />)
    await ready()
    expect(screen.getAllByRole('button', { name: 'Project: Alpha' })).toHaveLength(1)
  })
  it('remembers at most ten projects, newest first, dropping the oldest', () => {
    for (let index = 0; index < 14; index++) rememberProject(`p${index}`)
    expect(readRecentProjects()).toEqual(['p13', 'p12', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4'])
    window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(Array.from({ length: 40 }, (_, index) => `q${index}`)))
    expect(readRecentProjects()).toHaveLength(10)
    expect(rememberProject('fresh')).toHaveLength(10)
    expect(readRecentProjects()[0]).toBe('fresh')
  })
  it('stores only opaque ids and survives corrupted or blocked storage', () => {
    rememberProject('a'); rememberProject('b'); rememberProject('a')
    expect(readRecentProjects()).toEqual(['a', 'b'])
    expect(window.localStorage.getItem(RECENT_PROJECTS_KEY)).toBe('["a","b"]')
    window.localStorage.setItem(RECENT_PROJECTS_KEY, '{broken')
    expect(readRecentProjects()).toEqual([])
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readRecentProjects()).toEqual([])
    expect(() => rememberProject('c')).not.toThrow()
  })
})

describe('catalog model picker', () => {
  it('groups connections by catalog category and hides the retired (dotenv) suffix', async () => {
    install({ connections: [connection(CONNECTION, 'Legacy (dotenv)', 'model_api'), connection(LOCAL, 'Local Ollama', 'local_runtime')] })
    render(<NewSessionScreen />)
    await ready()
    await openModel()
    const group = screen.getByRole('group', { name: 'Connection' })
    expect(within(group).getByText('LLM APIs')).toBeTruthy()
    expect(within(group).getByText('Local runtimes')).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Legacy' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Local Ollama' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('(dotenv)')
    expect(document.body.textContent).not.toContain('dotenv')
  })

  it('lists the selected connection models, filters them, and selects with arrow keys and Enter', async () => {
    install()
    render(<NewSessionScreen />)
    await ready()
    await openModel()
    fireEvent.click(screen.getByRole('button', { name: 'Fixture model' }))
    const search = await screen.findByLabelText('Search models')
    expect(screen.getByRole('option', { name: 'fixture' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'fixture-large' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'large' } })
    expect(screen.queryByRole('option', { name: 'fixture' })).toBeNull()
    const large = screen.getByRole('option', { name: 'fixture-large' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(large)
    await act(async () => { fireEvent.keyDown(large, { key: 'Enter' }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model: Fixture model, fixture-large' })).toBeTruthy())
    expect(screen.queryByRole('group', { name: 'Connection' })).toBeNull()
  })

  it('renders the trigger as two styled spans and never a middle-dot string', async () => {
    window.localStorage.setItem(LAST_MODEL_CHOICE_KEY, JSON.stringify({ connectionId: CONNECTION, model: 'fixture' }))
    install()
    render(<NewSessionScreen />)
    await ready()
    const trigger = await screen.findByRole('button', { name: 'Model: Fixture model, fixture' })
    expect(trigger.querySelectorAll('span.new-session-choice-connection')).toHaveLength(1)
    expect(trigger.querySelectorAll('span.new-session-choice-model')).toHaveLength(1)
    expect(trigger.textContent).not.toContain('·')
  })

  it('preselects the last connection and model from central storage', async () => {
    window.localStorage.setItem(LAST_MODEL_CHOICE_KEY, JSON.stringify({ connectionId: CONNECTION, model: 'fixture-large' }))
    install()
    render(<NewSessionScreen />)
    await ready()
    expect(await screen.findByRole('button', { name: 'Model: Fixture model, fixture-large' })).toBeTruthy()
    await openModel()
    expect(screen.getByRole('option', { name: 'fixture-large' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: 'fixture' }).getAttribute('aria-selected')).toBe('false')
  })

  it('reveals a typed model ID only as a fallback and sends it unchanged', async () => {
    const { calls } = install()
    render(<NewSessionScreen />)
    await ready()
    await openModel()
    fireEvent.click(screen.getByRole('button', { name: 'Fixture model' }))
    await screen.findByRole('option', { name: 'fixture' })
    expect(screen.queryByLabelText('Model ID')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Other model ID…' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'owner/custom:model' } })
    fireEvent.change(prompt(), { target: { value: 'Inspect' } })
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
    expect(calls.create[0]).toMatchObject({ connectionId: CONNECTION, model: 'owner/custom:model' })
    expect(window.localStorage.getItem(LAST_MODEL_CHOICE_KEY)).toContain('owner/custom:model')
  })
})

describe('locale parity', () => {
  it('keeps every placeholder identical in English and Russian and leaves no empty copy', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(newSessionEnglish) as (keyof typeof newSessionEnglish)[]) {
      expect(newSessionRussian[key].trim().length, key).toBeGreaterThan(0)
      expect(placeholders(newSessionRussian[key]), key).toEqual(placeholders(newSessionEnglish[key]))
    }
  })
  it('renders the screen in Russian with the same controls', async () => {
    setActiveLocale('ru')
    install()
    render(<NewSessionScreen />)
    await screen.findByRole('region', { name: 'Новая сессия' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Что должен сделать агент?')
    expect(screen.getByRole('button', { name: 'Начать сессию' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Проект: Alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Доступ: Только чтение' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Подключение модели: Fixture model' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/newSession\./)
  })
})
