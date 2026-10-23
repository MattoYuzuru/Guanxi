import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionScreen } from '../../src/features/new-session/NewSessionScreen.tsx'
import { RECENT_PROJECTS_KEY, readRecentProjects, rememberProject } from '../../src/features/new-session/recent.ts'
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
    if (path.startsWith('/api/agent/projects/') && init?.method === 'PATCH') { calls.patch.push(JSON.parse(String(init.body))); return state.patch ? state.patch() : Response.json({}) }
    throw new Error(`Unexpected request ${path}`)
  }))
  return { calls, state }
}
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
/** jsdom does not run the summary's activation behaviour; the browser spec clicks the real summary. */
const openOptions = () => { const details = document.querySelector('details'); if (!details) throw new Error('no run options'); details.open = true }
const start = () => screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement
async function ready() { await waitFor(() => expect(screen.queryByText('Loading session choices…')).toBeNull()); await screen.findByRole('form', { name: 'New session' }) }
async function fillValid() {
  fireEvent.change(field('Project'), { target: { value: 'p' } })
  fireEvent.change(field('Connection'), { target: { value: CONNECTION } })
  fireEvent.change(field('Model ID'), { target: { value: 'fixture' } })
  fireEvent.change(field('What should the agent do?'), { target: { value: 'Inspect' } })
}

beforeEach(() => {
  setActiveLocale('en')
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  window.history.replaceState(null, '', '/agent')
})
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })

describe('new-session screen states', () => {
  it('shows a skeleton with a status while loading and no form, then the form', async () => {
    let release: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => String(url) === '/api/agent/projects'
      ? new Promise<Response>(resolve => { release = resolve }) : Promise.resolve(Response.json(String(url) === '/api/workspaces' ? { workspaces: [] } : { connections: [], costs: [], vault: { unlocked: false, unattendedAvailable: false } }))))
    render(<NewSessionScreen />)
    expect(screen.getAllByRole('status').filter(node => node.textContent === 'Loading session choices…')).toHaveLength(1)
    expect(screen.getAllByTestId('new-session-skeleton')).toHaveLength(1)
    expect(screen.queryByRole('form', { name: 'New session' })).toBeNull()
    await act(async () => { release(Response.json({ projects: [project('p', 'Alpha')] })) })
    await waitFor(() => expect(screen.queryByTestId('new-session-skeleton')).toBeNull())
  })

  it('has exactly one empty state with one primary action when there is no project, and when there is no connection', async () => {
    install({ projects: [] })
    const view = render(<NewSessionScreen />)
    await screen.findByText('No projects yet. Create a project to start a session.')
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Open Projects' }).getAttribute('href')).toBe('/projects')
    expect(screen.queryByRole('form', { name: 'New session' })).toBeNull()
    view.unmount()
    install({ connections: [] })
    render(<NewSessionScreen />)
    await screen.findByText('No model connection yet. Add one in Settings to start a session.')
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings')
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull()
  })

  it('reports a rejected source with name, time, copyable code and a Retry that recovers', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url)
      if (path === '/api/agent/projects') { attempts++; return attempts === 1 ? Response.json({ code: 'egress_unavailable' }, { status: 503 }) : Response.json({ projects: [project('p', 'Alpha')] }) }
      if (path === '/api/connections') return Response.json({ connections: [connection(CONNECTION, 'Fixture model', 'model_api')], costs: [], vault: { unlocked: false, unattendedAvailable: false } })
      return Response.json({ workspaces: [] })
    }))
    render(<NewSessionScreen />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Session choices could not be loaded')).toBeTruthy()
    expect(within(alert).getByText('GET /api/agent/projects')).toBeTruthy()
    expect(alert.textContent).toContain('egress_unavailable')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(start().disabled).toBe(true)
    expect(screen.getByText('Load the session choices again with Retry.')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByRole('form', { name: 'New session' })
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(attempts).toBe(2)
  })

  it('names the unreachable node when no answer arrives and never starts a session', async () => {
    const { calls } = install({ network: 'down' })
    render(<NewSessionScreen />)
    const alert = await screen.findByRole('alert')
    expect(alert.getAttribute('data-state')).toBe('node_unreachable')
    expect(alert.textContent).toContain('node_unreachable')
    expect(alert.textContent).toContain('No choices were loaded before the connection dropped.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(start().disabled).toBe(true)
    fireEvent.click(start())
    fireEvent.submit(screen.getByRole('form', { name: 'New session' }))
    expect(calls.create).toHaveLength(0)
  })

  it('keeps the last loaded choices with their age when a refresh finds the node unreachable', async () => {
    const { calls, state } = install()
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    expect(start().disabled).toBe(false)
    state.network = 'down'
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    // The browser's own offline signal alone already disables starting.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/As of .+, /)
    expect(field('Project').value).toBe('p')
    expect(start().disabled).toBe(true)
    expect(screen.getByText('Reconnect to the node.')).toBeTruthy()
    fireEvent.submit(screen.getByRole('form', { name: 'New session' }))
    expect(calls.create).toHaveLength(0)
    // Back online reloads once and the panel disappears.
    state.network = undefined
    const before = calls.projects
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
    expect(calls.projects).toBe(before + 1)
    expect(start().disabled).toBe(false)
  })

  it('degrades to a visible message when only the folder list is missing and still starts', async () => {
    const { calls } = install({ workspaces: 'fail', projects: [project('p', 'Alpha', ['w1'])] })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    openOptions()
    expect(screen.getAllByText(/GET \/api\/workspaces/)).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'Project folders' })).toBeNull()
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
  })
})

describe('new-session start flow', () => {
  it('lists exactly what is missing, in order, and clears the reasons as the form is completed', async () => {
    install()
    render(<NewSessionScreen />)
    await ready()
    const needs = () => Array.from(document.querySelectorAll('#new-session-needs li')).map(node => node.textContent)
    expect(needs()).toEqual(['Choose a project.', 'Choose a model connection.', 'Enter a model ID.', 'Describe the task.'])
    expect(start().getAttribute('aria-describedby')).toBe('new-session-needs')
    expect(start().disabled).toBe(true)
    await fillValid()
    expect(needs()).toEqual([])
    expect(document.getElementById('new-session-needs')?.textContent).toBe('Ready to start.')
    expect(start().disabled).toBe(false)
  })

  it('submits one session with the defaults and navigates to it, remembering the project only after success', async () => {
    const { calls } = install()
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    expect(readRecentProjects()).toEqual([])
    fireEvent.click(start())
    await waitFor(() => expect(window.location.pathname).toBe('/agent/session-1'))
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0]).toEqual({ projectId: 'p', connectionId: CONNECTION, model: 'fixture', mode: 'read-only', prompt: 'Inspect',
      retention: 'ttl', domains: [], attachmentIds: [], protectedPaths: [] })
    expect(readRecentProjects()).toEqual(['p'])
  })

  it('sends exactly one request for a double Enter, ignores Shift+Enter and does not swallow Enter while blocked', async () => {
    const { calls } = install({ create: () => new Response(JSON.stringify({ sessionId: 'session-1' }), { status: 202, headers: { 'Content-Type': 'application/json' } }) })
    render(<NewSessionScreen />)
    await ready()
    const prompt = field('What should the agent do?')
    fireEvent.change(prompt, { target: { value: 'Inspect' } })
    // Blocked: Enter must keep its newline behaviour (the event is not cancelled).
    expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(true)
    expect(calls.create).toHaveLength(0)
    await fillValid()
    expect(fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(calls.create).toHaveLength(0)
    expect(fireEvent.keyDown(prompt, { key: 'Enter', isComposing: true })).toBe(true)
    expect(calls.create).toHaveLength(0)
    expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(false)
    fireEvent.keyDown(prompt, { key: 'Enter' })
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
    expect(document.body.textContent).toContain(copy)
    expect(document.activeElement).toBe(title.closest('[tabindex="-1"]'))
    expect(title.textContent).toContain(copy) // the specific reason is inside the announced alert
    expect(field('What should the agent do?').value).toBe('Inspect')
    expect(field('Model ID').value).toBe('fixture')
    expect(window.location.pathname).toBe('/agent')
    expect(readRecentProjects()).toEqual([])
    expect(calls.create).toHaveLength(1)
    expect(start().disabled).toBe(false)
  })

  it('shows changed options as chips only for non-default values with exact counts', async () => {
    install({ projects: [project('p', 'Alpha', ['w1'])], workspaces: [{ id: 'w1', name: 'Repo', rootPath: '/r', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: true }, { id: 'w2', name: 'Docs', rootPath: '/d', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: false }] })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    const chips = () => screen.queryByRole('list', { name: 'Changed options' })?.querySelectorAll('li').length ?? 0
    expect(chips()).toBe(0)
    fireEvent.change(field('Access mode'), { target: { value: 'full-access' } })
    expect(chips()).toBe(1)
    openOptions()
    fireEvent.change(field('Network allowlist (comma-separated hosts)'), { target: { value: 'example.com, localhost:3000' } })
    fireEvent.change(field('Protected paths (one per line)'), { target: { value: 'a\nb\n\nc' } })
    fireEvent.change(field('Project attachment IDs (comma-separated; upload in Attachments)'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Docs · not found on disk' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Docs/ }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }))
    expect(screen.getByRole('button', { name: /Docs/ }).getAttribute('aria-pressed')).toBe('true')
    const items = Array.from(screen.getByRole('list', { name: 'Changed options' }).querySelectorAll('li')).map(node => node.textContent)
    expect(items).toEqual(['Access: Full access', 'Network hosts: 2', 'Protected paths: 3', 'Attachments: 1', 'Folders to save: 2'])
    fireEvent.change(field('Access mode'), { target: { value: 'read-only' } })
    expect(chips()).toBe(4)
  })

  it('marks invalid hosts and context, blocks starting, and requires the context only for local runtimes', async () => {
    const { calls } = install({ connections: [connection(CONNECTION, 'Fixture model', 'model_api'), connection(LOCAL, 'Local Ollama', 'local_runtime')] })
    render(<NewSessionScreen />)
    await ready(); await fillValid()
    openOptions()
    expect(screen.queryByLabelText('Local runtime context (tokens)')).toBeNull()
    fireEvent.change(field('Network allowlist (comma-separated hosts)'), { target: { value: 'localhost' } })
    const domains = field('Network allowlist (comma-separated hosts)')
    expect(domains.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/Use host names, or host:port/)).toBeTruthy()
    expect(start().disabled).toBe(true)
    expect(screen.getByText('Fix the options marked as invalid.')).toBeTruthy()
    fireEvent.change(domains, { target: { value: 'localhost:3000' } })
    expect(domains.getAttribute('aria-invalid')).toBeNull()
    expect(start().disabled).toBe(false)
    fireEvent.change(field('Connection'), { target: { value: LOCAL } })
    expect(start().disabled).toBe(true)
    expect(screen.getByText('Set the local runtime context.')).toBeTruthy()
    fireEvent.change(field('Local runtime context (tokens)'), { target: { value: '12.5' } })
    expect(field('Local runtime context (tokens)').getAttribute('aria-invalid')).toBe('true')
    expect(start().disabled).toBe(true)
    fireEvent.change(field('Local runtime context (tokens)'), { target: { value: '8192' } })
    expect(start().disabled).toBe(false)
    fireEvent.click(start())
    await waitFor(() => expect(calls.create).toHaveLength(1))
    expect(calls.create[0]).toMatchObject({ connectionId: LOCAL, contextTokens: 8192, domains: ['localhost:3000'] })
  })

  it('saves project folders through the project route exactly once and reports a failed save', async () => {
    const { calls, state } = install({ projects: [project('p', 'Alpha')], workspaces: [{ id: 'w1', name: 'Repo', rootPath: '/r', createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists: true }] })
    render(<NewSessionScreen />)
    await ready()
    fireEvent.change(field('Project'), { target: { value: 'p' } })
    expect(screen.getByText('No folders · scratch only')).toBeTruthy()
    openOptions()
    const save = screen.getByRole('button', { name: 'Save folders' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Repo' }))
    expect(save.disabled).toBe(false)
    state.patch = () => Response.json({ code: 'root_unavailable' }, { status: 503 })
    fireEvent.click(save)
    await screen.findByRole('alert')
    expect(calls.patch).toEqual([{ workspaceIds: ['w1'] }])
  })
})

describe('recent projects', () => {
  it('lists remembered projects newest first, ignores deleted ones and selects without a duplicate entry', async () => {
    rememberProject('gone'); rememberProject('a'); rememberProject('b')
    install({ projects: [project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')] })
    render(<NewSessionScreen />)
    await ready()
    const group = screen.getByRole('region', { name: 'Recent projects' })
    expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['Beta', 'Alpha'])
    expect(within(group).getAllByRole('button').map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    fireEvent.click(within(group).getByRole('button', { name: 'Alpha' }))
    expect(field('Project').value).toBe('a')
    expect(within(group).getByRole('button', { name: 'Alpha' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(group).getAllByRole('button')).toHaveLength(2)
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
    await screen.findByRole('form', { name: 'Новая сессия' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Новая сессия')
    expect(screen.getByRole('button', { name: 'Начать сессию' })).toBeTruthy()
    expect(screen.getByLabelText('Проект')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/newSession\./)
  })
})
