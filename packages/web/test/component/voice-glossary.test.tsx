/**
 * Voice glossary editor (V1 UI). Every state, the create / edit / deactivate / revert / history
 * flows and the live preview run against the stateful stand-in node in `fixtures/glossary-node.ts`.
 * Counts are exact: one request per action, one alert per failure, one mark per replacement.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOSSARY_PREVIEW_MAX_CHARS } from '@guanxi/contract'
import { GlossaryPage } from '../../src/features/voice/GlossaryPage.tsx'
import { GlossarySettingsLink } from '../../src/features/voice/GlossarySettingsLink.tsx'
import { PREVIEW_DELAY_MS } from '../../src/features/voice/GlossaryPreview.tsx'
import { voiceGlossaryEnglish } from '../../src/features/voice/messages.ts'
import { paths, parseRoute } from '../../src/lib/router.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { createGlossaryNode, glossaryFetch, type GlossaryNode } from '../fixtures/glossary-node.ts'

const PROJECTS = [
  { id: 'p1', name: 'Alpha project', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', filesystemBindings: [] },
  { id: 'p2', name: 'Beta project', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', filesystemBindings: [] },
]

let node: GlossaryNode
let projectCalls = 0
let projectsDown = false

function install(seed?: (node: GlossaryNode) => void) {
  node = createGlossaryNode()
  projectCalls = 0
  projectsDown = false
  seed?.(node)
  vi.stubGlobal('fetch', vi.fn(glossaryFetch(node, (path) => {
    if (path === '/api/agent/projects') {
      projectCalls++
      return projectsDown ? Response.json({ code: 'agent_unavailable' }, { status: 500 }) : Response.json({ projects: PROJECTS })
    }
    throw new Error(`Unexpected request ${path}`)
  })))
}
const seedBasic = (target: GlossaryNode) => {
  target.seed({ canonical: 'Hono', variants: ['хоно', 'хона'] }, { id: 'gl_hono' })
  target.seed({ canonical: 'PR', variants: ['пиар'] }, { id: 'gl_pr' })
  target.seed({ canonical: 'Vite', variants: ['вайт'] }, { id: 'gl_vite', scope: 'project', projectId: 'p1' })
}

const card = (name: string) => screen.getByRole('heading', { level: 4, name }).closest('article') as HTMLElement
const button = (name: string | RegExp, scope: HTMLElement | Document = document) => within(scope as HTMLElement).getByRole('button', { name }) as HTMLButtonElement
const field = (name: string) => {
  const controls = screen.getAllByLabelText(name).filter((element) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
  if (controls.length !== 1) throw new Error(`expected one control labelled "${name}", found ${controls.length}`)
  return controls[0] as HTMLInputElement
}
const alerts = () => screen.queryAllByRole('alert')
const announcement = () => screen.getByTestId('glossary-announcement').textContent
const describedBy = (element: HTMLElement) => (element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
const mutationCount = () => node.requests.filter((request) => request.method !== 'GET' && request.path !== '/apply-preview').length
const type = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } })
async function ready() {
  await waitFor(() => expect(screen.queryByTestId('glossary-skeleton')).toBeNull())
  await screen.findByRole('heading', { level: 2, name: 'Entries' })
}
async function open() { install(seedBasic); render(<GlossaryPage />); await ready() }
const submitForm = () => fireEvent.submit(screen.getByRole('form'))

beforeEach(() => {
  setActiveLocale('en')
  window.history.replaceState(null, '', '/settings/voice/glossary')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setActiveLocale('ru') })

describe('states', () => {
  it('shows one status and a skeleton while loading, no cards, then the entries', async () => {
    let release: () => void = () => {}
    install(seedBasic)
    node.holdList = new Promise<void>((resolve) => { release = resolve })
    render(<GlossaryPage />)
    expect(screen.getAllByText('Loading the glossary…')).toHaveLength(1)
    expect(screen.getAllByTestId('glossary-skeleton')).toHaveLength(1)
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    await act(async () => { release() })
    await ready()
    expect(screen.queryAllByRole('article')).toHaveLength(3)
    expect(screen.queryByText('Loading the glossary…')).toBeNull()
  })

  it('has exactly one empty state with one primary action, and no second New entry button', async () => {
    install()
    render(<GlossaryPage />)
    await ready()
    expect(document.querySelectorAll('[data-slot="empty-state"]')).toHaveLength(1)
    expect(screen.getByText(voiceGlossaryEnglish['voiceGlossary.empty'])).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'New entry' })).toHaveLength(1)
    expect(within(document.querySelector('[data-slot="empty-state"]') as HTMLElement).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(screen.queryByTestId('glossary-count')).toBeTruthy()
  })

  it('reports a rejected list with source, time and code, then recovers by itself with exactly one more request', async () => {
    install(seedBasic)
    node.fail.set('GET /', { status: 503, code: 'glossary_unavailable', once: true })
    render(<GlossaryPage />)
    await waitFor(() => expect(alerts()).toHaveLength(1))
    const alert = alerts()[0] as HTMLElement
    expect(alert.textContent).toContain('The glossary could not be loaded')
    expect(alert.textContent).toContain('The voice glossary service is not running on this node')
    expect(alert.textContent).toContain('GET /api/voice/glossary')
    expect(alert.textContent).toContain('glossary_unavailable')
    expect(alert.querySelector('time')).toBeTruthy()
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(node.count('GET', '/')).toBe(1)
    expect(screen.queryAllByRole('button', { name: /^(Retry|Reload)/u })).toHaveLength(0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(3))
    expect(alerts()).toHaveLength(0)
    expect(node.count('GET', '/')).toBe(2)
  })

  it('names node_unreachable when nothing was ever loaded, and recovers by itself', async () => {
    install(seedBasic)
    node.down = true
    render(<GlossaryPage />)
    await waitFor(() => expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1))
    expect(alerts()).toHaveLength(1)
    expect(screen.getByText('No entries were loaded before the connection dropped.')).toBeTruthy()
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'New entry' }).hasAttribute('disabled')).toBe(true)
    node.down = false
    expect(screen.queryAllByRole('button', { name: /^(Retry|Reload)/u })).toHaveLength(0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(3))
    expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(0)
  })

  it('keeps the last entries with their age when the node drops, and disables every network action with a reason', async () => {
    await open()
    node.down = true
    act(() => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1))
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]?.textContent).toMatch(/As of /u)
    expect(screen.queryAllByRole('article')).toHaveLength(3)
    // Four network actions on each of the three cards: History only toggles a panel but also needs the node, so it stays enabled to show cached nothing.
    const mutating = screen.getAllByRole('button').filter((element) => /^(Edit|Deactivate|Reactivate|Revert) /u.test(element.getAttribute('aria-label') ?? ''))
    expect(mutating).toHaveLength(9)
    for (const element of mutating) expect(element.hasAttribute('disabled'), element.getAttribute('aria-label') ?? '').toBe(true)
    const editHono = screen.getByRole('button', { name: 'Edit Hono' })
    expect(describedBy(editHono)).toContain('Creating, editing, deactivating, reactivating and reverting are disabled')
    expect(screen.getByRole('button', { name: 'New entry' }).hasAttribute('disabled')).toBe(true)
    expect(mutationCount()).toBe(0)
    node.down = false
    expect(screen.queryAllByRole('button', { name: /^(Retry|Reload)/u })).toHaveLength(0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(0))
    expect(screen.getByRole('button', { name: 'Edit Hono' }).hasAttribute('disabled')).toBe(false)
  })

  it('treats a body-less 502 (a proxy with no node behind it) as node_unreachable, not as a version mismatch', async () => {
    install(seedBasic)
    node.fail.set('GET /', { status: 502 })
    render(<GlossaryPage />)
    await waitFor(() => expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1))
    expect(alerts()).toHaveLength(1)
    expect(document.body.textContent).not.toContain('different versions')
    expect(screen.getByText('Nothing can be read or changed until the connection returns.')).toBeTruthy()
  })

  it('says a project is missing from the list only when the list is known, and shows the plain id otherwise', async () => {
    install((target) => { target.seed({ canonical: 'Ghost' }, { id: 'gl_ghost', scope: 'project', projectId: 'gone' }) })
    render(<GlossaryPage />)
    await ready()
    expect(screen.getByRole('heading', { level: 3, name: 'Project gone, missing from the project list' })).toBeTruthy()
    cleanup()
    install((target) => { target.seed({ canonical: 'Ghost' }, { id: 'gl_ghost', scope: 'project', projectId: 'gone' }) })
    projectsDown = true
    render(<GlossaryPage />)
    await ready()
    await screen.findByText(/The project list could not be loaded/u)
    expect(screen.getByRole('heading', { level: 3, name: 'Project gone' })).toBeTruthy()
    expect(screen.queryAllByText(/missing from the project list/u)).toHaveLength(0)
  })

  it('degrades to project ids when the project list is unavailable and says so once', async () => {
    install(seedBasic)
    projectsDown = true
    render(<GlossaryPage />)
    await ready()
    await screen.findByText(/The project list could not be loaded/u)
    expect(screen.getAllByText(/The project list could not be loaded/u)).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 3, name: 'Project p1' })).toBeTruthy()
    fireEvent.click(button('New entry'))
    type(field('Applies to'), 'project')
    expect(screen.getByText('The project list is unavailable, so a project entry cannot be created now.')).toBeTruthy()
    expect((field('Project') as unknown as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('list', () => {
  it('groups account entries before projects with exact counts, languages, spoken forms and inactive marks', async () => {
    install((target) => {
      seedBasic(target)
      target.seed({ canonical: 'Old', variants: [] }, { id: 'gl_old', active: false })
    })
    render(<GlossaryPage />)
    await ready()
    const groups = Array.from(document.querySelectorAll('[data-group]')).map((element) => element.getAttribute('data-group'))
    expect(groups).toEqual(['account', 'project:p1'])
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Account-wide', 'Project: Alpha project'])
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual(['Hono', 'Old', 'PR', 'Vite'])
    expect(screen.getAllByRole('article')).toHaveLength(4)
    expect(screen.getByTestId('glossary-count').textContent).toBe('Entries: 4, active: 3')
    expect(within(card('Hono')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['хоно', 'хона'])
    expect(within(card('Old')).getByText('No spoken forms: only the term itself is matched.')).toBeTruthy()
    expect(document.querySelectorAll('[data-active="false"]')).toHaveLength(1)
    expect(within(card('Old')).getAllByText('Inactive')).toHaveLength(1)
    expect(screen.queryAllByText('Inactive')).toHaveLength(1)
  })

  it('asks the node for exactly what the view needs: all, then a project, and with or without inactive', async () => {
    await open()
    expect(node.requests.filter((request) => request.path === '/').map((request) => request.query)).toEqual([{ includeInactive: 'true' }])
    type(field('Show entries for'), 'p1')
    await waitFor(() => expect(node.count('GET', '/')).toBe(2))
    expect(node.requests.filter((request) => request.path === '/')[1]?.query).toEqual({ projectId: 'p1', includeInactive: 'true' })
    expect(screen.getByRole('button', { name: 'Show inactive entries' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Show inactive entries' }))
    expect(screen.getByRole('button', { name: 'Show inactive entries' }).getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(node.count('GET', '/')).toBe(3))
    expect(node.requests.filter((request) => request.path === '/')[2]?.query).toEqual({ projectId: 'p1', includeInactive: 'false' })
  })

  it('shows the skeleton instead of another view\'s entries while a different view loads', async () => {
    await open()
    let release: () => void = () => {}
    node.holdList = new Promise<void>((resolve) => { release = resolve })
    type(field('Show entries for'), 'p1')
    await waitFor(() => expect(screen.queryAllByTestId('glossary-skeleton')).toHaveLength(1))
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    await act(async () => { release() })
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(3))
  })

  it('marks an account entry as overridden only in the project view where an active project entry hides it', async () => {
    install((target) => {
      seedBasic(target)
      target.seed({ canonical: 'hono', variants: ['хоно проекта'] }, { id: 'gl_hono_p1', scope: 'project', projectId: 'p1' })
    })
    render(<GlossaryPage />)
    await ready()
    expect(screen.queryAllByText('Overridden in this project')).toHaveLength(0)
    type(field('Show entries for'), 'p1')
    await waitFor(() => expect(screen.queryAllByText('Overridden in this project')).toHaveLength(1))
    expect(within(screen.getAllByRole('heading', { level: 4, name: 'Hono' })[0]?.closest('article') as HTMLElement).getAllByText('Overridden in this project')).toHaveLength(1)
    expect(screen.getAllByRole('article').filter((element) => element.textContent?.includes('Overridden in this project'))).toHaveLength(1)
  })

  it('shows letter-case and no-endings flags only where they are set', async () => {
    install((target) => {
      target.seed({ canonical: 'Plain' })
      target.seed({ canonical: 'Strict', caseSensitive: true })
      target.seed({ canonical: 'Frozen', inflect: false })
    })
    render(<GlossaryPage />)
    await ready()
    expect(screen.queryAllByText('Letter case must match')).toHaveLength(1)
    expect(screen.queryAllByText('No Russian endings')).toHaveLength(1)
    expect(within(card('Plain')).queryByText('Letter case must match')).toBeNull()
    expect(within(card('Strict')).queryAllByText('Letter case must match')).toHaveLength(1)
  })
})

describe('create', () => {
  it('opens with focus in the canonical field and sends exactly one request with exactly the typed entry', async () => {
    await open()
    fireEvent.click(button('New entry'))
    expect(screen.getAllByRole('form')).toHaveLength(1)
    expect(document.activeElement).toBe(field('Canonical term'))
    type(field('Canonical term'), '  Guanxi ')
    type(field('Spoken forms'), 'гуанси\n\n  гуаньси  \n')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(node.requests.filter((request) => request.method === 'POST' && request.path === '/')).toEqual([
      { method: 'POST', path: '/', query: {}, body: { scope: 'account', entry: { canonical: 'Guanxi', variants: ['гуанси', 'гуаньси'], language: 'en' } } },
    ])
    expect(mutationCount()).toBe(1)
    expect(screen.getAllByRole('article')).toHaveLength(4)
    expect(within(card('Guanxi')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['гуанси', 'гуаньси'])
    expect(announcement()).toBe('Created “Guanxi”, revision 1.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 4, name: 'Guanxi' }))
    expect(node.count('GET', '/')).toBe(1)
  })

  it('creates a project entry with its project id and the right group', async () => {
    await open()
    fireEvent.click(button('New entry'))
    type(field('Applies to'), 'project')
    type(field('Project'), 'p2')
    type(field('Canonical term'), 'Zod')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(node.requests.at(-1)?.body).toEqual({ scope: 'project', projectId: 'p2', entry: { canonical: 'Zod', variants: [], language: 'en' } })
    expect(document.querySelector('[data-group="project:p2"]')?.textContent).toContain('Zod')
    expect(screen.getByRole('heading', { level: 3, name: 'Project: Beta project' })).toBeTruthy()
  })

  it('sends non-default flags and the chosen language, and disables endings when they cannot apply', async () => {
    await open()
    fireEvent.click(button('New entry'))
    type(field('Canonical term'), 'Корень')
    type(field('Language of the term'), 'ru')
    const endings = screen.getByRole('button', { name: 'Add Russian endings after a hyphen (PR-а)' })
    expect((endings as HTMLButtonElement).disabled).toBe(true)
    expect(endings.getAttribute('aria-pressed')).toBe('false')
    expect(describedBy(endings)).toBe('Available for English terms only.')
    type(field('Language of the term'), 'en')
    const caseToggle = screen.getByRole('button', { name: 'Match letter case exactly' })
    expect(caseToggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(caseToggle)
    expect(caseToggle.getAttribute('aria-pressed')).toBe('true')
    expect(describedBy(screen.getByRole('button', { name: 'Add Russian endings after a hyphen (PR-а)' })))
      .toBe('Off while letter case must match.')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(node.requests.at(-1)?.body).toEqual({ scope: 'account', entry: { canonical: 'Корень', variants: [], language: 'en', caseSensitive: true } })
  })

  it('explains inflected Latin terms with the PR-а example next to the spoken forms', async () => {
    await open()
    fireEvent.click(button('New entry'))
    const hint = describedBy(field('Spoken forms'))
    expect(hint).toContain('PR-а')
    expect(hint).toContain('пиара')
    expect(hint).toContain('One per line')
  })

  it('refuses an empty term locally: no request, one described invalid field, focus on it', async () => {
    await open()
    fireEvent.click(button('New entry'))
    submitForm()
    expect(mutationCount()).toBe(0)
    expect(field('Canonical term').getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(field('Canonical term'))).toContain('Enter the canonical term.')
    expect(document.activeElement).toBe(field('Canonical term'))
    expect(alerts().map((alert) => alert.textContent)).toEqual(['Fix the fields marked as invalid.'])
    expect(screen.getAllByRole('form')).toHaveLength(1)
  })

  it('refuses a term over the contract limit with that limit, and a project entry without a project', async () => {
    await open()
    fireEvent.click(button('New entry'))
    type(field('Canonical term'), 'x'.repeat(201))
    type(field('Applies to'), 'project')
    submitForm()
    expect(mutationCount()).toBe(0)
    expect(describedBy(field('Canonical term'))).toContain('longer than 200 characters')
    expect(describedBy(field('Project'))).toContain('Choose a project for a project entry.')
    expect(document.activeElement).toBe(field('Project'))
    type(field('Canonical term'), 'x'.repeat(200))
    type(field('Project'), 'p1')
    submitForm()
    await waitFor(() => expect(mutationCount()).toBe(1))
  })

  it('cancel discards the form, sends nothing and returns focus to New entry', async () => {
    await open()
    fireEvent.click(button('New entry'))
    type(field('Canonical term'), 'Draft')
    expect(screen.getByText('Cancel discards what you typed.')).toBeTruthy()
    fireEvent.click(button('Cancel'))
    expect(screen.queryAllByRole('form')).toHaveLength(0)
    expect(mutationCount()).toBe(0)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New entry' }))
    fireEvent.click(button('New entry'))
    expect(field('Canonical term').value).toBe('')
  })

  it('shows glossary_invalid once, without echoing any term, keeps the typed values and changes nothing', async () => {
    await open()
    fireEvent.click(button('New entry'))
    type(field('Canonical term'), 'Secret-Term')
    type(field('Spoken forms'), 'хоно')
    submitForm()
    await waitFor(() => expect(alerts()).toHaveLength(1))
    const alert = alerts()[0] as HTMLElement
    expect(alert.textContent).toContain('The entry was not saved')
    expect(alert.textContent).toContain('collide with a spoken form of another entry')
    expect(alert.textContent).toContain('glossary_invalid')
    expect(alert.textContent).not.toContain('Secret-Term')
    expect(alert.textContent).not.toContain('хоно')
    expect(alert.textContent).not.toContain('Hono')
    expect(node.entries.size).toBe(3)
    expect(screen.getAllByRole('form')).toHaveLength(1)
    expect(field('Canonical term').value).toBe('Secret-Term')
    expect(field('Spoken forms').value).toBe('хоно')
    expect(alert.parentElement?.contains(document.activeElement) || alert.parentElement === document.activeElement).toBe(true)
    expect(node.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    type(field('Spoken forms'), 'совсем другое')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(alerts()).toHaveLength(0)
    expect(node.entries.size).toBe(4)
  })

  it('says the outcome is unknown when the node does not answer, and keeps the form', async () => {
    await open()
    fireEvent.click(button('New entry'))
    type(field('Canonical term'), 'Lost')
    node.down = true
    submitForm()
    // The unanswered write also makes the page re-read, which names the offline state: two alerts, each once.
    await waitFor(() => expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1))
    expect(alerts()).toHaveLength(2)
    const formAlert = within(screen.getByRole('form')).getAllByRole('alert')
    expect(formAlert).toHaveLength(1)
    expect(formAlert[0]?.textContent).toContain('it is unknown whether the change was applied')
    expect(screen.getAllByRole('form')).toHaveLength(1)
    expect(field('Canonical term').value).toBe('Lost')
    expect(screen.queryAllByRole('article')).toHaveLength(3)
  })

  it('shows a created entry that the current view would hide by resetting the view, and says so', async () => {
    await open()
    type(field('Show entries for'), 'p2')
    await waitFor(() => expect(node.count('GET', '/')).toBe(2))
    await waitFor(() => expect(screen.queryAllByTestId('glossary-skeleton')).toHaveLength(0))
    fireEvent.click(button('New entry'))
    type(field('Applies to'), 'project')
    type(field('Project'), 'p1')
    type(field('Canonical term'), 'Elsewhere')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('heading', { level: 4, name: 'Elsewhere' })).toHaveLength(1))
    expect((field('Show entries for') as unknown as HTMLSelectElement).value).toBe('')
    expect(announcement()).toBe('Created “Elsewhere”, revision 1. The view was reset to show it.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 4, name: 'Elsewhere' }))
  })
})

describe('edit', () => {
  it('prefills the form, fixes the scope, sends exactly one PUT and returns focus to Edit', async () => {
    await open()
    fireEvent.click(button('Edit Hono'))
    expect(screen.getAllByRole('form')).toHaveLength(1)
    expect(screen.getByText('Applies to: Account-wide')).toBeTruthy()
    expect(screen.queryByLabelText('Project')).toBeNull()
    expect(field('Canonical term').value).toBe('Hono')
    expect(field('Spoken forms').value).toBe('хоно\nхона')
    expect(document.activeElement).toBe(field('Canonical term'))
    type(field('Canonical term'), 'Hono.js')
    type(field('Spoken forms'), 'хоно')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(node.requests.filter((request) => request.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/gl_hono', query: {}, body: { entry: { canonical: 'Hono.js', variants: ['хоно'], language: 'en' } } },
    ])
    expect(mutationCount()).toBe(1)
    expect(screen.queryAllByRole('heading', { level: 4, name: 'Hono' })).toHaveLength(0)
    expect(within(card('Hono.js')).getByText(/Revision 2/u)).toBeTruthy()
    expect(announcement()).toBe('Saved “Hono.js”, revision 2.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit Hono.js' }))
    expect(screen.getAllByRole('article')).toHaveLength(3)
  })

  it('cancel returns focus to that entry\'s Edit button and sends nothing', async () => {
    await open()
    fireEvent.click(button('Edit PR'))
    type(field('Canonical term'), 'changed')
    fireEvent.click(button('Cancel'))
    expect(screen.queryAllByRole('form')).toHaveLength(0)
    expect(mutationCount()).toBe(0)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit PR' }))
    expect(screen.getByRole('heading', { level: 4, name: 'PR' })).toBeTruthy()
  })

  it('shows glossary_invalid on edit without echoing terms and leaves the entry untouched', async () => {
    await open()
    fireEvent.click(button('Edit PR'))
    type(field('Spoken forms'), 'хоно')
    submitForm()
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]?.textContent).not.toContain('хоно')
    expect(node.entries.get('gl_pr')?.revision).toBe(1)
    expect(field('Spoken forms').value).toBe('хоно')
    expect(mutationCount()).toBe(1)
  })

  it('cannot edit an inactive entry and says how to proceed', async () => {
    install((target) => { target.seed({ canonical: 'Old' }, { id: 'gl_old', active: false }) })
    render(<GlossaryPage />)
    await ready()
    expect(screen.getByRole('button', { name: 'Edit Old' }).hasAttribute('disabled')).toBe(true)
    expect(within(card('Old')).getByText('Reactivate this entry before editing it.')).toBeTruthy()
  })

  it('closes the editor when its entry disappears from the list', async () => {
    await open()
    fireEvent.click(button('Edit PR'))
    expect(screen.getAllByRole('form')).toHaveLength(1)
    node.entries.delete('gl_pr')
    act(() => { window.dispatchEvent(new Event('online')) }) // the view controls are locked while a form is open; a regained network re-reads
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
  })
})

describe('deactivate, reactivate and revert', () => {
  it('deactivates with one request, marks the card, disables editing, announces and keeps focus on the same control', async () => {
    await open()
    fireEvent.click(button('Deactivate Hono'))
    await waitFor(() => expect(card('Hono').getAttribute('data-active')).toBe('false'))
    expect(node.requests.filter((request) => request.path === '/gl_hono/deactivate')).toHaveLength(1)
    expect(mutationCount()).toBe(1)
    expect(within(card('Hono')).getAllByText('Inactive')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Edit Hono' }).hasAttribute('disabled')).toBe(true)
    expect(announcement()).toBe('Deactivated “Hono”, revision 2.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reactivate Hono' }))
    expect(screen.getByTestId('glossary-count').textContent).toBe('Entries: 3, active: 2')
    fireEvent.click(button('Reactivate Hono'))
    await waitFor(() => expect(card('Hono').getAttribute('data-active')).toBe('true'))
    expect(within(card('Hono')).queryAllByText('Inactive')).toHaveLength(0)
    expect(announcement()).toBe('Reactivated “Hono”, revision 3.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deactivate Hono' }))
    expect(mutationCount()).toBe(2)
  })

  it('describes what deactivate and revert do before they run, in the control\'s description', async () => {
    await open()
    expect(describedBy(button('Deactivate Hono'))).toBe('Stops replacing this term. Nothing is deleted; reactivate it at any time.')
    expect(describedBy(button('Revert Hono'))).toBe('This is the first revision, so reverting deactivates the entry. Nothing is deleted.')
    fireEvent.click(button('Edit Hono'))
    type(field('Canonical term'), 'Hono2')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(describedBy(button('Revert Hono2'))).toContain('Restores the previous revision of this entry')
    expect(describedBy(button('Revert Hono2'))).toContain('nothing is lost')
    expect(describedBy(button('Revert Hono2'))).not.toContain('first revision')
  })

  it('removes a deactivated card when inactive entries are hidden and moves focus to the list heading', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Show inactive entries' }))
    await waitFor(() => expect(node.count('GET', '/')).toBe(2))
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(3))
    fireEvent.click(button('Deactivate Hono'))
    await waitFor(() => expect(screen.queryAllByRole('heading', { level: 4, name: 'Hono' })).toHaveLength(0))
    expect(screen.queryAllByRole('article')).toHaveLength(2)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Entries' }))
  })

  it('reverts to the previous revision with one request, records it as a new revision and announces it', async () => {
    await open()
    fireEvent.click(button('Edit Hono'))
    type(field('Canonical term'), 'Hono 2')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    fireEvent.click(button('Revert Hono 2'))
    await waitFor(() => expect(screen.queryAllByRole('heading', { level: 4, name: 'Hono' })).toHaveLength(1))
    expect(node.requests.filter((request) => request.path === '/gl_hono/revert')).toHaveLength(1)
    expect(mutationCount()).toBe(2)
    expect(within(card('Hono')).getByText(/Revision 3/u)).toBeTruthy()
    expect(announcement()).toBe('Reverted “Hono”, now revision 3.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revert Hono' }))
    expect(screen.queryAllByRole('heading', { level: 4, name: 'Hono 2' })).toHaveLength(0)
  })

  it('reverting a first revision deactivates the entry, and the control says so beforehand', async () => {
    await open()
    expect(describedBy(button('Revert PR'))).toBe('This is the first revision, so reverting deactivates the entry. Nothing is deleted.')
    fireEvent.click(button('Revert PR'))
    await waitFor(() => expect(card('PR').getAttribute('data-active')).toBe('false'))
    expect(node.entries.get('gl_pr')?.entry.canonical).toBe('PR')
    expect(node.entries.get('gl_pr')?.revision).toBe(2)
  })

  it('shows one alert with the source on a failed revert, moves focus to it and leaves the entry as it was', async () => {
    await open()
    node.fail.set('POST /:id/revert', { status: 404, code: 'entry_not_found', once: true })
    fireEvent.click(button('Revert Hono'))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    const alert = alerts()[0] as HTMLElement
    expect(alert.textContent).toContain('The change was not applied')
    expect(alert.textContent).toContain('This entry no longer exists on the node')
    expect(alert.textContent).toContain('POST /api/voice/glossary/:id/revert')
    expect(alert.parentElement === document.activeElement || alert.contains(document.activeElement)).toBe(true)
    expect(within(card('Hono')).getByText(/Revision 1/u)).toBeTruthy()
    expect(announcement()).toBe('')
    expect(screen.getByRole('button', { name: 'Revert Hono' }).hasAttribute('disabled')).toBe(false)
  })

  it('sends one request for a double click and keeps every other entry untouched while a change is in flight', async () => {
    await open()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    node.holdList = null
    const original = node.handle.bind(node)
    node.handle = async (method, path, body) => { if (path.endsWith('/deactivate')) await gate; return original(method, path, body) }
    const deactivate = button('Deactivate Hono')
    fireEvent.click(deactivate)
    fireEvent.click(deactivate)
    fireEvent.click(button('Deactivate PR'))
    await act(async () => { release() })
    await waitFor(() => expect(card('Hono').getAttribute('data-active')).toBe('false'))
    expect(node.requests.filter((request) => request.path.endsWith('/deactivate'))).toHaveLength(1)
    expect(card('PR').getAttribute('data-active')).toBe('true')
  })
})


describe('consistency', () => {
  const hold = () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    return { gate, release }
  }

  it('locks the view controls while a form is open or a change is in flight, and says why', async () => {
    await open()
    const filter = field('Show entries for') as unknown as HTMLSelectElement
    const inactive = screen.getByRole('button', { name: 'Show inactive entries' })
    expect(filter.disabled).toBe(false)
    fireEvent.click(button('New entry'))
    expect(filter.disabled).toBe(true)
    expect((inactive as HTMLButtonElement).disabled).toBe(true)
    expect(describedBy(filter)).toContain('Finish or cancel the open form')
    fireEvent.click(button('Cancel'))
    expect(filter.disabled).toBe(false)
    const { gate, release } = hold()
    const original = node.handle.bind(node)
    node.handle = async (method, path, body) => { if (path.endsWith('/deactivate')) await gate; return original(method, path, body) }
    fireEvent.click(button('Deactivate PR'))
    expect(filter.disabled).toBe(true)
    await act(async () => { release() })
    await waitFor(() => expect(card('PR').getAttribute('data-active')).toBe('false'))
    expect(filter.disabled).toBe(false)
  })

  it('discards a read that started before a change and reads again, so an old snapshot never wins', async () => {
    await open()
    const { gate, release } = hold()
    node.holdList = gate
    act(() => { window.dispatchEvent(new Event('online')) }) // a read starts and takes its snapshot: Hono is active
    await waitFor(() => expect(node.count('GET', '/')).toBe(2))
    fireEvent.click(button('Deactivate Hono')) // the change completes while that read is still in flight
    await waitFor(() => expect(card('Hono').getAttribute('data-active')).toBe('false'))
    await act(async () => { release() })
    await waitFor(() => expect(node.count('GET', '/')).toBe(3))
    await waitFor(() => expect(screen.queryByTestId('glossary-skeleton')).toBeNull())
    expect(card('Hono').getAttribute('data-active')).toBe('false')
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.getByTestId('glossary-count').textContent).toBe('Entries: 3, active: 2')
  })

  it('blocks Save while another change is in flight instead of ignoring the click', async () => {
    await open()
    fireEvent.click(button('Edit Hono'))
    type(field('Canonical term'), 'Hono 2')
    const { gate, release } = hold()
    const original = node.handle.bind(node)
    node.handle = async (method, path, body) => { if (path.endsWith('/gl_pr/deactivate')) await gate; return original(method, path, body) }
    fireEvent.click(button('Deactivate PR'))
    expect(button('Save entry').disabled).toBe(true)
    submitForm()
    expect(node.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
    await act(async () => { release() })
    await waitFor(() => expect(button('Save entry').disabled).toBe(false))
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    expect(node.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
  })

  it('shows glossary_invalid once for a reactivation that collides, and leaves the entry inactive', async () => {
    await open()
    fireEvent.click(button('Deactivate PR'))
    await waitFor(() => expect(card('PR').getAttribute('data-active')).toBe('false'))
    node.seed({ canonical: 'Pee', variants: ['пиар'] }, { id: 'gl_pee' })
    fireEvent.click(button('Reactivate PR'))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]?.textContent).toContain('The change was not applied')
    expect(alerts()[0]?.textContent).toContain('does not accept this change')
    expect(alerts()[0]?.textContent).toContain('POST /api/voice/glossary/:id/reactivate')
    expect(alerts()[0]?.textContent).not.toContain('пиар')
    expect(card('PR').getAttribute('data-active')).toBe('false')
    expect(node.entries.get('gl_pr')?.revision).toBe(2)
  })

  it('shows glossary_invalid once for a revert that would collide, and keeps the current revision', async () => {
    await open()
    fireEvent.click(button('Edit PR'))
    type(field('Spoken forms'), 'пиар2')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    node.seed({ canonical: 'Pee', variants: ['пиар'] }, { id: 'gl_pee' })
    fireEvent.click(button('Revert PR'))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]?.textContent).toContain('glossary_invalid')
    expect(node.entries.get('gl_pr')?.revision).toBe(2)
    expect(within(card('PR')).getByText(/Revision 2/u)).toBeTruthy()
  })

  it('turns a write that got no answer into the named offline state, with the unknown outcome stated', async () => {
    await open()
    node.down = true
    fireEvent.click(button('Deactivate Hono'))
    await waitFor(() => expect(document.querySelectorAll('[data-state="node_unreachable"]')).toHaveLength(1))
    const text = alerts().map((alert) => alert.textContent ?? '').join(' | ')
    expect(text).toContain('it is unknown whether the change was applied')
    expect(alerts()).toHaveLength(2)
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(card('Hono').getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('button', { name: 'Deactivate Hono' }).hasAttribute('disabled')).toBe(true)
  })

  it('explains a disabled Edit on an inactive entry through the control\'s own description', async () => {
    install((target) => { target.seed({ canonical: 'Old' }, { id: 'gl_old', active: false }) })
    render(<GlossaryPage />)
    await ready()
    expect(describedBy(screen.getByRole('button', { name: 'Edit Old' }))).toContain('Reactivate this entry before editing it.')
  })

  it('does not move focus later when the read it waited for failed', async () => {
    await open()
    type(field('Show entries for'), 'p1')
    await waitFor(() => expect(node.count('GET', '/')).toBe(2))
    await waitFor(() => expect(screen.queryAllByTestId('glossary-skeleton')).toHaveLength(0))
    fireEvent.click(button('New entry'))
    type(field('Applies to'), 'project')
    type(field('Project'), 'p2')
    type(field('Canonical term'), 'Elsewhere')
    node.fail.set('GET /', { status: 503, code: 'glossary_unavailable' })
    submitForm()
    await waitFor(() => expect(alerts()).toHaveLength(1)) // the view reset asked again and the read failed
    const focusedBefore = document.activeElement
    ;(document.activeElement as HTMLElement | null)?.blur()
    node.fail.delete('GET /')
    expect(screen.queryAllByRole('button', { name: /^(Retry|Reload)/u })).toHaveLength(0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.queryAllByRole('heading', { level: 4, name: 'Elsewhere' })).toHaveLength(1))
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { level: 4, name: 'Elsewhere' }))
    expect(focusedBefore).not.toBeNull()
  })
})

describe('history', () => {
  it('loads once when opened, lists revisions newest first with exactly one current mark, and closes again', async () => {
    await open()
    fireEvent.click(button('Edit Hono'))
    type(field('Canonical term'), 'Hono 2')
    type(field('Spoken forms'), 'хоно')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    const toggle = button('History of Hono 2')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    await screen.findByRole('list', { name: 'History of Hono 2' })
    expect(node.count('GET', '/gl_hono/history')).toBe(1)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByTestId('glossary-history').id)
    const rows = within(screen.getByRole('list', { name: 'History of Hono 2' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.getAttribute('data-revision'))).toEqual(['2', '1'])
    expect(within(rows[0] as HTMLElement).getByText(/Edited by you/u)).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText('Changed: term, spoken forms')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText(/Created by you/u)).toBeTruthy()
    expect(screen.getAllByText('Current')).toHaveLength(1)
    expect(within(rows[0] as HTMLElement).getAllByText('Current')).toHaveLength(1)
    fireEvent.click(toggle)
    expect(screen.queryAllByTestId('glossary-history')).toHaveLength(0)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('refreshes an open history after a revert without closing it', async () => {
    await open()
    fireEvent.click(button('Edit PR'))
    type(field('Canonical term'), 'PR 2')
    submitForm()
    await waitFor(() => expect(screen.queryAllByRole('form')).toHaveLength(0))
    fireEvent.click(button('History of PR 2'))
    await screen.findByRole('list', { name: 'History of PR 2' })
    expect(within(screen.getByTestId('glossary-history')).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(button('Revert PR 2'))
    await waitFor(() => expect(within(screen.getByTestId('glossary-history')).queryAllByRole('listitem')).toHaveLength(3))
    const rows = within(screen.getByTestId('glossary-history')).getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-revision'))).toEqual(['3', '2', '1'])
    expect(within(rows[0] as HTMLElement).getByText(/Reverted by you/u)).toBeTruthy()
    expect(within(rows[0] as HTMLElement).getByText('Changed: term')).toBeTruthy()
    expect(screen.getAllByText('Current')).toHaveLength(1)
    expect(node.count('GET', '/gl_pr/history')).toBe(2)
  })

  it('reports a history failure once, with its source, and recovers by itself', async () => {
    await open()
    node.fail.set('GET /:id/history', { status: 500, code: 'internal_error', once: true })
    fireEvent.click(button('History of Hono'))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]?.textContent).toContain('The history could not be loaded')
    expect(alerts()[0]?.textContent).toContain('GET /api/voice/glossary/:id/history')
    expect(screen.queryAllByRole('button', { name: /^(Retry|Reload)/u })).toHaveLength(0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await screen.findByRole('list', { name: 'History of Hono' })
    expect(alerts()).toHaveLength(0)
    expect(node.count('GET', '/gl_hono/history')).toBe(2)
  })
})

describe('preview', () => {
  const wait = () => new Promise((resolve) => setTimeout(resolve, PREVIEW_DELAY_MS + 80))
  const preview = () => screen.getByTestId('glossary-preview')
  const previewRequests = () => node.requests.filter((request) => request.path === '/apply-preview')

  it('starts idle with one sentence and sends nothing for blank text', async () => {
    await open()
    expect(within(preview()).getByText('Type or paste dictated text to see the replacements.')).toBeTruthy()
    type(within(preview()).getByLabelText('Dictated text'), '   ')
    await act(wait)
    expect(previewRequests()).toHaveLength(0)
  })

  it('highlights exactly the replacements, shows the D-157 shape and the glossary revision hash', async () => {
    await open()
    type(within(preview()).getByLabelText('Dictated text'), 'открой пиара и хоно')
    await waitFor(() => expect(screen.queryAllByTestId('glossary-preview-output')).toHaveLength(1))
    expect(previewRequests()).toHaveLength(1)
    expect(previewRequests()[0]?.body).toEqual({ text: 'открой пиара и хоно', projectId: null })
    const marks = Array.from(screen.getByTestId('glossary-preview-output').querySelectorAll('mark')).map((mark) => mark.textContent)
    expect(marks).toEqual(['PR-а', 'Hono'])
    expect(screen.getByTestId('glossary-preview-output').textContent).toBe('открой PR-а и Hono')
    expect(screen.getByTestId('glossary-preview-count').textContent).toBe('Replacements: 2')
    expect(within(preview()).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['пиара → PR-а', 'хоно → Hono'])
    const hash = screen.getByTestId('glossary-revision').textContent
    expect(hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(within(preview()).getByText('Active entries in this glossary: 2')).toBeTruthy()
  })

  it('sends one request for a burst of typing, cancelling nothing it should keep', async () => {
    await open()
    const box = within(preview()).getByLabelText('Dictated text')
    type(box, 'х'); type(box, 'хо'); type(box, 'хоно')
    await waitFor(() => expect(screen.queryAllByTestId('glossary-preview-output')).toHaveLength(1))
    expect(previewRequests()).toHaveLength(1)
    expect(previewRequests()[0]?.body).toEqual({ text: 'хоно', projectId: null })
  })

  it('reports no replacement as such and still shows the revision', async () => {
    await open()
    type(within(preview()).getByLabelText('Dictated text'), 'просто текст')
    await waitFor(() => expect(screen.queryAllByTestId('glossary-preview-output')).toHaveLength(1))
    expect(screen.getByTestId('glossary-preview-count').textContent).toBe('No replacement applies to this text.')
    expect(screen.getByTestId('glossary-preview-output').querySelectorAll('mark')).toHaveLength(0)
    expect(screen.getByTestId('glossary-revision').textContent).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('re-runs after an edit and shows a different revision hash', async () => {
    await open()
    type(within(preview()).getByLabelText('Dictated text'), 'пиар')
    await waitFor(() => expect(screen.queryAllByTestId('glossary-revision')).toHaveLength(1))
    const before = screen.getByTestId('glossary-revision').textContent
    expect(previewRequests()).toHaveLength(1)
    fireEvent.click(button('Deactivate PR'))
    await waitFor(() => expect(previewRequests()).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId('glossary-revision').textContent).not.toBe(before))
    await waitFor(() => expect(screen.getByTestId('glossary-preview-output').querySelectorAll('mark')).toHaveLength(0))
    expect(screen.getByTestId('glossary-preview-count').textContent).toBe('No replacement applies to this text.')
  })

  it('previews a project glossary when a project is chosen, and follows the list view', async () => {
    await open()
    type(field('Show entries for'), 'p1')
    await waitFor(() => expect((within(preview()).getByLabelText('Glossary used') as unknown as HTMLSelectElement).value).toBe('p1'))
    type(within(preview()).getByLabelText('Dictated text'), 'вайт и пиар')
    await waitFor(() => expect(screen.queryAllByTestId('glossary-preview-output')).toHaveLength(1))
    expect(previewRequests()[0]?.body).toEqual({ text: 'вайт и пиар', projectId: 'p1' })
    expect(Array.from(screen.getByTestId('glossary-preview-output').querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['Vite', 'PR'])
    type(within(preview()).getByLabelText('Glossary used'), '')
    await waitFor(() => expect(previewRequests()).toHaveLength(2))
    expect(previewRequests()[1]?.body).toEqual({ text: 'вайт и пиар', projectId: null })
    await waitFor(() => expect(Array.from(screen.getByTestId('glossary-preview-output').querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['PR']))
  })

  it('marks the result stale, and announces no count for it, while a changed scope is being answered', async () => {
    await open()
    type(within(preview()).getByLabelText('Dictated text'), 'вайт и пиар')
    await waitFor(() => expect(screen.getByTestId('glossary-preview-count').textContent).toBe('Replacements: 1'))
    const accountHash = screen.getByTestId('glossary-revision').textContent
    expect(screen.queryAllByTestId('glossary-preview-stale')).toHaveLength(0)
    let release: () => void = () => {}
    node.holdPreview = new Promise<void>((resolve) => { release = resolve })
    type(within(preview()).getByLabelText('Glossary used'), 'p1')
    await waitFor(() => expect(previewRequests()).toHaveLength(2))
    expect(screen.getAllByTestId('glossary-preview-stale')).toHaveLength(1)
    expect(screen.getByTestId('glossary-preview-count').textContent).toBe('')
    expect(screen.getByTestId('glossary-revision').textContent).toBe(accountHash) // the old result is still what is on screen
    await act(async () => { release() })
    await waitFor(() => expect(screen.queryAllByTestId('glossary-preview-stale')).toHaveLength(0))
    expect(screen.getByTestId('glossary-preview-count').textContent).toBe('Replacements: 2')
    expect(screen.getByTestId('glossary-revision').textContent).not.toBe(accountHash)
  })

  it('marks the result stale while the answer to an edit is pending, then replaces it', async () => {
    await open()
    type(within(preview()).getByLabelText('Dictated text'), 'пиар')
    await waitFor(() => expect(screen.getByTestId('glossary-preview-count').textContent).toBe('Replacements: 1'))
    let release: () => void = () => {}
    node.holdPreview = new Promise<void>((resolve) => { release = resolve })
    fireEvent.click(button('Deactivate PR'))
    await waitFor(() => expect(previewRequests()).toHaveLength(2))
    expect(screen.getAllByTestId('glossary-preview-stale')).toHaveLength(1)
    expect(screen.getByTestId('glossary-preview-count').textContent).toBe('')
    await act(async () => { release() })
    await waitFor(() => expect(screen.getByTestId('glossary-preview-count').textContent).toBe('No replacement applies to this text.'))
    expect(screen.queryAllByTestId('glossary-preview-stale')).toHaveLength(0)
  })

  it('keeps one persistent status node for the page outcome and one for the preview count', async () => {
    await open()
    const statuses = screen.getAllByRole('status')
    expect(statuses.map((node) => node.getAttribute('data-testid'))).toEqual(['glossary-announcement', 'glossary-preview-count'])
    const [outcome, count] = statuses as [HTMLElement, HTMLElement]
    expect(count.textContent).toBe('')
    type(within(preview()).getByLabelText('Dictated text'), 'хоно')
    await waitFor(() => expect(count.textContent).toBe('Replacements: 1'))
    fireEvent.click(button('Deactivate Hono'))
    await waitFor(() => expect(outcome.textContent).toBe('Deactivated “Hono”, revision 2.'))
    expect(screen.getAllByRole('status')).toEqual([outcome, count]) // the same nodes: their text changes, they are never re-created
    await waitFor(() => expect(count.textContent).toBe('No replacement applies to this text.'))
  })

  it('fails visibly, once, and recovers by itself', async () => {
    await open()
    node.fail.set('POST /apply-preview', { status: 500, code: 'internal_error', once: true })
    type(within(preview()).getByLabelText('Dictated text'), 'хоно')
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]?.textContent).toContain('The preview could not be computed')
    expect(alerts()[0]?.textContent).toContain('POST /api/voice/glossary/apply-preview')
    expect(screen.queryAllByTestId('glossary-preview-output')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /^(Retry|Reload)/u })).toHaveLength(0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.queryAllByTestId('glossary-preview-output')).toHaveLength(1))
    expect(alerts()).toHaveLength(0)
    expect(previewRequests()).toHaveLength(2)
  })

  it('refuses text over the node\'s budget locally with the exact limit, and sends nothing', async () => {
    await open()
    const box = within(preview()).getByLabelText('Dictated text')
    type(box, 'x'.repeat(GLOSSARY_PREVIEW_MAX_CHARS + 1))
    await act(wait)
    expect(previewRequests()).toHaveLength(0)
    expect(within(preview()).getByText(`The text is longer than ${GLOSSARY_PREVIEW_MAX_CHARS} characters, the most the node accepts in one preview.`)).toBeTruthy()
    expect(box.getAttribute('aria-invalid')).toBe('true')
    type(box, 'x'.repeat(GLOSSARY_PREVIEW_MAX_CHARS))
    await waitFor(() => expect(previewRequests()).toHaveLength(1))
  })
})

describe('mounting', () => {
  it('has a Settings entry that links to the editor route, and the route parses back', () => {
    render(<GlossarySettingsLink />)
    const link = screen.getByRole('link', { name: 'Open the voice glossary' })
    expect(link.getAttribute('href')).toBe('/settings/voice/glossary')
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(parseRoute(paths.voiceGlossary())).toEqual({ name: 'voiceGlossary' })
    expect(parseRoute('/settings/voice')).toMatchObject({ name: 'notFound' })
  })

  it('links back to Settings from the page', async () => {
    await open()
    expect(screen.getByRole('link', { name: 'Back to Settings' }).getAttribute('href')).toBe('/settings')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})

describe('Russian', () => {
  it('renders the whole page without a missing translation or an English state string', async () => {
    setActiveLocale('ru')
    install(seedBasic)
    render(<GlossaryPage />)
    await screen.findByRole('heading', { level: 2, name: 'Записи' })
    await waitFor(() => expect(screen.queryByTestId('glossary-skeleton')).toBeNull())
    expect(screen.getByRole('heading', { level: 1, name: 'Голосовой глоссарий' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/missing translation|variables mismatch/u)
    expect(screen.getByTestId('glossary-count').textContent).toBe('Записей: 3, включённых: 3')
    fireEvent.click(screen.getByRole('button', { name: 'Новая запись' }))
    expect(describedBy(field('Произносимые формы'))).toContain('PR-а')
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeTruthy()
  })
})
