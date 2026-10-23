import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeAgentPage, NativeProgress } from '../../src/features/native-agent/NativeAgentPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import type { AgentProgress } from '@guanxi/contract'
import { nativeEnglish, nativeRussian } from '../../src/features/native-agent/messages.ts'
import { RECENT_PROJECTS_KEY } from '../../src/features/new-session/recent.ts'
import { useCurrentProject } from '../../src/lib/current-project.ts'
const progress: AgentProgress = { sessionId: 'session', projectId: 'p', connectionId: 'c', model: 'fixture', mode: 'read-only',
  status: 'running', plan: [{ text: 'Inspect', status: 'verification_requested' }], queue: [{ id: 'q', text: 'Follow up' }],
  summary: 'Response', error: null, observedAt: '2026-10-21T00:00:00.000Z', source: 'session.log', confidence: 'high' }
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })
it.each(['en', 'ru'] as const)('progress renders exact plan/queue counts with provenance, button actions and localized status in %s', locale => {
  setActiveLocale(locale)
  const remove = vi.fn()
  render(<NativeProgress progress={progress} remove={remove} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText(locale === 'en' ? /Verification requested/ : /Требуется проверка/)).toBeTruthy()
  expect(screen.getByText(locale === 'en' ? /Session log, observed/ : /Журнал сессии, наблюдение/)).toBeTruthy()
  expect(document.body.textContent).not.toContain(' · ')
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Remove queued prompt' : 'Убрать запрос из очереди' }))
  expect(remove).toHaveBeenCalledExactlyOnceWith('q')
})
it('new session defaults to Read-only, exposes zero-root scratch state and submits a single session', async () => {
  setActiveLocale('en')
  const requests: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url) === '/api/workspaces') return Response.json({ workspaces: [] })
    if (String(url) === '/api/agent/projects') return Response.json({ projects: [{ id: 'p', name: 'No folder', filesystemBindings: [] }] })
    if (String(url) === '/api/connections') return Response.json({ connections: [{ id: '11111111-1111-4111-8111-111111111111', accountId: 'local', name: 'Fixture', kind: 'model_api',
      provider: 'deepseek', auth: 'api_key', unattended: false, secretRef: null, facts: {}, createdAt: '2026-10-21T00:00:00.000Z', balance: null }], costs: [], vault: { unlocked: false, unattendedAvailable: false } })
    if (String(url) === '/api/agent') { requests.push(JSON.parse(String(init.body))); return Response.json({ sessionId: 'session' }) }
    throw new Error('Unexpected request')
  }))
  render(<NativeAgentPage sessionId={null} />)
  await waitFor(() => expect(screen.queryByText('Loading session choices…')).toBeNull())
  // The only project and the only connection are preselected (D-207: a new session opens in the current project).
  expect(screen.getByRole('button', { name: 'Project: No folder' })).toBeTruthy()
  expect(screen.getByText('No folders, scratch only')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Run options' }))
  const hint = await screen.findByText(/Loopback hosts require a port/)
  expect(hint.textContent).toContain('localhost:3000')
  expect(screen.getByLabelText('Network allowlist (comma-separated hosts)').getAttribute('aria-describedby')?.split(' ')).toContain(hint.id)
  expect(screen.getByRole('button', { name: 'Access: Read-only' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Access: Read-only' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Full access' }))
  expect(await screen.findByText(/On macOS they require a local Linux container runtime/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Access: Full access' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Read-only' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access: Read-only' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Choose a model' }))
  fireEvent.change(await screen.findByLabelText('Model ID'), { target: { value: 'fixture' } })
  fireEvent.change(screen.getByLabelText('What should the agent do?'), { target: { value: 'Inspect' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ mode: 'read-only', domains: [], attachmentIds: [], protectedPaths: [] })
})
it.each(['en', 'ru'] as const)('unavailable shell runtime has a localized reason and recovery in %s', locale => {
  setActiveLocale(locale)
  render(<NativeProgress progress={{ ...progress, shellUnavailable: 'container_runtime_unavailable' }} remove={() => {}} />)
  expect(screen.getByRole('alert').textContent).toContain(locale === 'en' ? 'Shell execution is disabled' : 'Оболочка отключена')
  expect(screen.getByRole('alert').textContent).toContain('Colima')
})
it('failed/offline choices announce a self-recovering state, offer no Retry and prevent dispatch', async () => {
  setActiveLocale('en'); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  render(<NativeAgentPage sessionId={null} />)
  const status = await waitFor(() => { const node = document.querySelector('[data-state="node_unreachable"]'); if (!node) throw new Error('not yet'); return node })
  expect(status.getAttribute('role')).toBe('status')
  expect(status.textContent).toContain('Guanxi reconnects by itself')
  const start = screen.getByRole('button', { name: 'Start session' })
  expect(start.getAttribute('aria-disabled')).toBe('true')
  expect(screen.queryAllByRole('button', { name: /Retry/ })).toHaveLength(0)
})

it('with the browser offline a failed read says so at once, keeps the last state, offers no Retry and recovers by itself', async () => {
  setActiveLocale('en')
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  let fail = false, reads = 0
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url) === '/api/agent/session') { reads++; if (fail) throw new TypeError('Failed to fetch'); return Response.json({ ...progress, status: 'running' }) }
    throw new Error('Unexpected request')
  }))
  render(<NativeAgentPage sessionId="session" />)
  await screen.findByRole('region', { name: 'Session progress' })
  // A running session re-reads quietly every 500 ms; the browser drops offline and the next read fails.
  fail = true; online.mockReturnValue(false)
  await screen.findByText(/Guanxi reconnects by itself/, undefined, { timeout: 2_000 })
  expect(screen.getByText('Response')).toBeTruthy()
  expect(screen.queryAllByRole('button', { name: /Retry/ })).toHaveLength(0)
  const before = reads
  fail = false; online.mockReturnValue(true)
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await waitFor(() => expect(screen.queryByText(/Guanxi reconnects by itself/)).toBeNull())
  expect(reads).toBeGreaterThan(before)
  online.mockRestore()
})

it.each(['en', 'ru'] as const)('session errors are visible and localized in %s', locale => {
  setActiveLocale(locale)
  const view = render(<NativeProgress progress={{ ...progress, status: 'failed', error: 'agent_failed' }} remove={() => {}} />)
  expect(screen.getByRole('alert').textContent).toContain(locale === 'en' ? 'This session failed' : 'Сессия завершилась с ошибкой')
  view.rerender(<NativeProgress progress={{ ...progress, status: 'failed', error: 'cleanup_unconfirmed' }} remove={() => {}} />)
  expect(screen.getByRole('alert').textContent).toContain(locale === 'en' ? 'remain blocked' : 'заблокированы')
})
it.each(['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const)('prompt button describes the actual action for %s sessions', async status => {
  setActiveLocale('en')
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url) === '/api/agent/session') return Response.json({ ...progress, status })
    if (String(url) === '/api/agent/projects') return Response.json({ projects: [] })
    if (String(url) === '/api/connections') return Response.json({ connections: [] })
    if (String(url) === '/api/workspaces') return Response.json({ workspaces: [] })
    throw new Error('Unexpected request')
  }))
  render(<NativeAgentPage sessionId="session" />)
  await screen.findByRole('region', { name: 'Session progress' })
  expect(screen.getByRole('button', { name: status === 'running' ? 'Queue prompt' : 'Continue session' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: status === 'running' ? 'Continue session' : 'Queue prompt' })).toBeNull()
})

it.each(['en', 'ru'] as const)('delete uses the contract once, describes discarded data, and preserves the page on refusal in %s', async locale => {
  setActiveLocale(locale)
  const deletes: string[] = []
  let refuse = true
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url) === '/api/agent/session' && init?.method === 'DELETE') {
      deletes.push(String(url))
      return refuse ? Response.json({ code: 'session_busy' }, { status: 409 }) : Response.json({ sessionId: 'session', deleted: true })
    }
    if (String(url) === '/api/agent/session') return Response.json({ ...progress, status: 'completed' })
    if (String(url) === '/api/agent/projects') return Response.json({ projects: [] })
    if (String(url) === '/api/connections') return Response.json({ connections: [] })
    if (String(url) === '/api/workspaces') return Response.json({ workspaces: [] })
    throw new Error('Unexpected request')
  }))
  render(<NativeAgentPage sessionId="session" />)
  fireEvent.click(await screen.findByRole('button', { name: locale === 'en' ? 'Session info' : 'О сессии' }))
  const button = await screen.findByRole('button', { name: locale === 'en' ? 'Delete session' : 'Удалить сессию' })
  // The description is referenced by a generated id (useId), so assert the relation.
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
    .toMatch(locale === 'en' ? /Permanently removes this session/ : /Безвозвратно удаляет сессию/)
  expect(screen.getByText(locale === 'en' ? /Permanently removes this session/ : /Безвозвратно удаляет сессию/)).toBeTruthy()
  fireEvent.click(button)
  await screen.findByRole('alert')
  expect(deletes).toHaveLength(1)
  expect(screen.getByText('Response')).toBeTruthy()
  refuse = false
  fireEvent.click(button)
  await waitFor(() => expect(deletes).toHaveLength(2))
})

it.each(['running', 'quarantine'] as const)('delete is disabled for %s sessions', async state => {
  setActiveLocale('en')
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url) === '/api/agent/session') return Response.json({ ...progress, status: state === 'running' ? 'running' : 'failed', error: state === 'quarantine' ? 'cleanup_unconfirmed' : null })
    if (String(url) === '/api/agent/projects') return Response.json({ projects: [] })
    if (String(url) === '/api/connections') return Response.json({ connections: [] })
    if (String(url) === '/api/workspaces') return Response.json({ workspaces: [] })
    throw new Error('Unexpected request')
  }))
  render(<NativeAgentPage sessionId="session" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Session info' }))
  expect((await screen.findByRole('button', { name: 'Delete session' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('link', { name: 'Open trace' }).getAttribute('href')).toBe('/inspector/session')
})

it('a Send to main refreshes the session status so a stopped session shows its new turn and polling resumes', async () => {
  setActiveLocale('en')
  let reads = 0, status: 'completed' | 'running' = 'completed'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/agent/session') { reads++; return Response.json({ ...progress, status, queue: [] }) }
    if (path === '/api/agent/session/side-chat/respond') return Response.json({ requestId: crypto.randomUUID(), text: 'Side answer', truncated: false, context: { source: 'session.log', include: 'session', upToSeq: 3, observedAt: '2026-10-23T10:00:00.000Z', turns: 1, excerpted: 0, bytes: 5 } })
    if (path === '/api/agent/session/side-chat/send') { status = 'running'; return Response.json({ operationId: JSON.parse(String(init?.body)).operationId, messageId: crypto.randomUUID(), delivery: 'started', duplicate: false }, { status: 202 }) }
    throw new Error(`Unexpected request ${path}`)
  }))
  render(<NativeAgentPage sessionId="session" />)
  await screen.findByRole('region', { name: 'Session progress' })
  expect(screen.getAllByRole('status').some(node => node.textContent === 'Completed')).toBe(true)
  // Side chat is a side panel toggled from the header.
  fireEvent.click(screen.getByRole('button', { name: 'Side chat' }))
  const readsBefore = reads
  fireEvent.change(screen.getByLabelText('Ask about this session'), { target: { value: 'q' } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  await screen.findByText('Side answer')
  fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 2' }))
  await waitFor(() => expect(screen.getAllByRole('status').some(node => node.textContent === 'Running')).toBe(true))
  expect(reads).toBe(readsBefore + 1)
  expect(screen.getByRole('button', { name: 'Stop session' })).toBeTruthy()
})

it('one failed 500 ms poll shows nothing; the offline note appears after three consecutive failures in a slot that exists all along', async () => {
  setActiveLocale('en')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let failing = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url)
      if (path === '/api/agent/session') { if (failing) throw new TypeError('Failed to fetch'); return Response.json({ ...progress, status: 'running' }) }
      throw new TypeError('Failed to fetch')
    }))
    render(<NativeAgentPage sessionId="session" />)
    for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Response')).toBeTruthy()
    const slot = document.querySelector('[data-testid="native-connection"]')
    expect(slot).not.toBeNull()
    expect(slot!.textContent).toBe('')
    failing = true
    // First failure (the next 500 ms poll): a blip, nothing appears.
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(document.querySelector('[data-testid="native-connection"]')).toBe(slot)
    expect(slot!.textContent).toBe('')
    // Second failure after the 2 s back-off: still quiet.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(slot!.textContent).toBe('')
    // Third consecutive failure after 4 s: the note says the node is unreachable, in the same element.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100) })
    expect(document.querySelector('[data-testid="native-connection"]')).toBe(slot)
    expect(slot!.textContent).toContain('reconnects by itself')
    expect(screen.getByText('Response')).toBeTruthy()
    // Recovery clears it again.
    failing = false
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0) })
    expect(slot!.textContent).toBe('')
  } finally { vi.useRealTimers() }
})

it('the native session catalogue carries no Retry label in either language (D-203)', () => {
  expect(Object.keys(nativeEnglish).filter(key => /retry/i.test(key))).toEqual([])
  expect(Object.values(nativeEnglish).filter(text => /^retry$/i.test(text))).toEqual([])
  expect(Object.values(nativeRussian).filter(text => /^повторить$/i.test(text))).toEqual([])
})

const logEvent = (seq: number, type: 'prompt' | 'assistant.message', text: string) => ({
  sessionId: 'session', seq, id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, spanId: null, parentSpanId: null, jobId: null, writerEpoch: 1, redactions: 0,
  createdAt: '2026-10-22T10:00:00.000Z', version: 1, type, class: 'standard',
  data: type === 'prompt' ? { origin: 'typed', messageId: `m${seq}`, text, attachmentCount: 0 } : { messageId: null, step: 0, text },
})
function stubTimeline(overrides: { status?: AgentProgress['status']; events?: unknown[]; title?: string | null } = {}) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url)
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/agent/session') return Response.json({ ...progress, status: overrides.status ?? 'completed' })
    if (path === '/api/agent/projects') return Response.json({ projects: [{ id: 'p', name: 'Alpha' }] })
    if (path.startsWith('/api/sessions/session/events')) {
      const after = Number(new URL(path, 'http://x').searchParams.get('after'))
      const events = ((overrides.events ?? []) as { seq: number }[]).filter(event => event.seq > after)
      return Response.json({ sessionId: 'session', events, nextAfter: events.at(-1)?.seq ?? after, lastSeq: events.at(-1)?.seq ?? after, hasMore: false })
    }
    if (path === '/api/sessions/session') return Response.json({ sessionId: 'session', kind: 'agent', threadId: null, title: overrides.title ?? null, createdAt: '2026-10-22T10:00:00.000Z',
      lastSeq: 2, lastEventAt: null, counts: {}, eventCount: 2, reasoningPurged: 0, redactions: 0, tokens: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, samples: 0, context: null } })
    if (path === '/api/agent/session/stop') return Response.json({ ok: true })
    throw new Error(`Unexpected request ${path}`)
  }))
  return requests
}

it('the session header is the title with its project as a breadcrumb, not "Session progress"', async () => {
  setActiveLocale('en')
  stubTimeline({ title: 'Fix the nightly build', events: [logEvent(1, 'prompt', 'Why does it fail?')] })
  render(<NativeAgentPage sessionId="session" />)
  const heading = await screen.findByRole('heading', { level: 1, name: 'Fix the nightly build' })
  expect(document.activeElement).toBe(heading)
  const crumbs = screen.getByRole('navigation', { name: 'Session location' })
  expect(within(crumbs).getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe('/projects')
  expect(screen.queryByRole('heading', { name: 'Session progress' })).toBeNull()
})

it('opening a session makes its project current and most recent, and leaving clears it (P2)', async () => {
  setActiveLocale('en')
  const values = new Map<string, string>([[RECENT_PROJECTS_KEY, JSON.stringify(['other'])]])
  stubTimeline({ title: 'Fix the nightly build', events: [logEvent(1, 'prompt', 'Why does it fail?')] })
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  function Current() { return <output data-testid="current">{useCurrentProject() ?? 'none'}</output> }
  const view = render(<><Current /><NativeAgentPage sessionId="session" /></>)
  await screen.findByRole('heading', { level: 1, name: 'Fix the nightly build' })
  expect(screen.getByTestId('current').textContent).toBe('p')
  expect(JSON.parse(values.get(RECENT_PROJECTS_KEY)!)).toEqual(['p', 'other'])
  view.rerender(<Current />)
  expect(screen.getByTestId('current').textContent).toBe('none')
})
it('without a log title the first prompt names the session, and markdown renders with no literal backticks', async () => {
  setActiveLocale('en')
  stubTimeline({ events: [logEvent(1, 'prompt', 'Pin `libvips` please\nsecond line'), logEvent(2, 'assistant.message', 'Pinned **libvips** in `ci/Dockerfile`.\n\n- step one\n- step two')] })
  render(<NativeAgentPage sessionId="session" />)
  expect(await screen.findByRole('heading', { level: 1, name: 'Pin `libvips` please' })).toBeTruthy()
  const timeline = screen.getByRole('region', { name: 'Conversation' })
  await waitFor(() => expect(within(timeline).getAllByTestId('native-message')).toHaveLength(2))
  const [user, agent] = within(timeline).getAllByTestId('native-message')
  expect(user!.getAttribute('data-role')).toBe('user')
  expect(agent!.getAttribute('data-role')).toBe('agent')
  expect(timeline.querySelector('.native-message-body')!.textContent).not.toContain('`')
  expect(agent!.querySelector('.native-message-body')!.textContent).not.toMatch(/[`*]/)
  expect(agent!.querySelectorAll('code')).toHaveLength(1)
  expect(agent!.querySelectorAll('strong')).toHaveLength(1)
  expect(agent!.querySelectorAll('li')).toHaveLength(2)
  // The log has an agent turn, so the progress summary is not repeated as one more message.
  expect(within(timeline).queryByText('Response')).toBeNull()
})

it('each message has a named icon rail: trace link, one details popover and copy', async () => {
  setActiveLocale('en')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  stubTimeline({ events: [logEvent(1, 'prompt', 'Question'), logEvent(7, 'assistant.message', 'Answer text')] })
  render(<NativeAgentPage sessionId="session" />)
  const timeline = await screen.findByRole('region', { name: 'Conversation' })
  await waitFor(() => expect(within(timeline).getAllByTestId('native-message')).toHaveLength(2))
  const rails = within(timeline).getAllByRole('group')
  expect(rails.map(rail => rail.getAttribute('aria-label'))).toEqual(['Message actions, You', 'Message actions, Agent'])
  for (const rail of rails) {
    expect(within(rail).getAllByRole('link').map(link => link.getAttribute('aria-label') ?? link.textContent)).toEqual(['Show in trace'])
    expect(within(rail).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Message details', 'Copy message'])
  }
  // Each turn's trace link opens the trace at that turn's own event (P3).
  expect(rails.map(rail => within(rail).getByRole('link').getAttribute('href'))).toEqual(['/inspector/session?event=1', '/inspector/session?event=7'])
  fireEvent.click(within(rails[1]!).getByRole('button', { name: 'Message details' }))
  const dialog = await screen.findByRole('dialog', { name: 'Message details' })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(within(dialog).getByText('Agent')).toBeTruthy()
  expect(within(dialog).getByText('7')).toBeTruthy()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
  await act(async () => { fireEvent.click(within(rails[1]!).getByRole('button', { name: 'Copy message' })) })
  expect(writes).toEqual(['Answer text'])
  await waitFor(() => expect(within(timeline).getAllByRole('status').some(node => node.textContent === 'Message copied.')).toBe(true))
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('the stop control is a named button in the composer with a filled stop glyph, never a checkbox', async () => {
  setActiveLocale('en')
  const requests = stubTimeline({ status: 'running' })
  render(<NativeAgentPage sessionId="session" />)
  const stop = await screen.findByRole('button', { name: 'Stop session' })
  expect(stop.tagName).toBe('BUTTON')
  expect(stop.closest('[data-slot="composer"]')).not.toBeNull()
  expect(stop.classList.contains('native-stop')).toBe(true)
  expect(stop.hasAttribute('aria-checked')).toBe(false)
  expect(stop.hasAttribute('aria-pressed')).toBe(false)
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(stop.textContent).toBe('')
  // Queueing stays available next to it.
  expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeTruthy()
  await act(async () => { fireEvent.click(stop) })
  expect(requests.filter(request => request === 'POST /api/agent/session/stop')).toHaveLength(1)
})

it('side chat is a toggled side panel: pressed state, focus into the panel, Escape returns focus, turns survive closing', async () => {
  setActiveLocale('en')
  stubTimeline()
  render(<NativeAgentPage sessionId="session" />)
  const toggle = await screen.findByRole('button', { name: 'Side chat' })
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(panel.hidden).toBe(true)
  expect(screen.queryByRole('radiogroup', { name: 'Context from the session' })).toBeNull()
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  expect(panel.hidden).toBe(false)
  await waitFor(() => expect(document.activeElement).toBe(within(panel).getByLabelText('Ask about this session')))
  expect(within(panel).getByRole('radiogroup', { name: 'Context from the session' })).toBeTruthy()
  expect(within(panel).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Whole session', 'Last turns', 'No context'])
  expect(panel.querySelectorAll('select')).toHaveLength(0)
  fireEvent.change(within(panel).getByLabelText('Ask about this session'), { target: { value: 'kept draft' } })
  fireEvent.keyDown(within(panel).getByLabelText('Ask about this session'), { key: 'Escape' })
  expect(panel.hidden).toBe(true)
  await waitFor(() => expect(document.activeElement).toBe(toggle))
  fireEvent.click(toggle)
  expect((within(panel).getByLabelText('Ask about this session') as HTMLTextAreaElement).value).toBe('kept draft')
  fireEvent.click(within(panel).getByRole('button', { name: 'Close side chat' }))
  expect(panel.hidden).toBe(true)
})

it('before the first progress read the page says it is reading the session; with no turns the summary stands in', async () => {
  setActiveLocale('en')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url)
    if (path === '/api/agent/session') { await held; return Response.json({ ...progress, status: 'completed' }) }
    if (path.startsWith('/api/sessions/session/events')) return Response.json({ sessionId: 'session', events: [], nextAfter: 0, lastSeq: 0, hasMore: false })
    throw new TypeError('Failed to fetch')
  }))
  render(<NativeAgentPage sessionId="session" />)
  expect(await screen.findByText('Reading the session…')).toBeTruthy()
  await act(async () => { release() })
  const timeline = await screen.findByRole('region', { name: 'Conversation' })
  await waitFor(() => expect(within(timeline).getAllByTestId('native-message')).toHaveLength(1))
  expect(within(timeline).getByText('Response')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1, name: 'Untitled session' })).toBeTruthy()
})
