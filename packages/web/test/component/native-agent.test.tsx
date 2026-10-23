import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeAgentPage, NativeProgress } from '../../src/features/native-agent/NativeAgentPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import type { AgentProgress } from '@guanxi/contract'
const progress: AgentProgress = { sessionId: 'session', projectId: 'p', connectionId: 'c', model: 'fixture', mode: 'read-only',
  status: 'running', plan: [{ text: 'Inspect', status: 'verification_requested' }], queue: [{ id: 'q', text: 'Follow up' }],
  summary: 'Response', error: null, observedAt: '2026-10-21T00:00:00.000Z', source: 'session.log', confidence: 'high' }
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })
it.each(['en', 'ru'] as const)('progress renders exact plan/queue counts with provenance, button actions and localized status in %s', locale => {
  setActiveLocale(locale)
  const stop = vi.fn(), remove = vi.fn()
  render(<NativeProgress progress={progress} stop={stop} remove={remove} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText(locale === 'en' ? /Verification requested/ : /Требуется проверка/)).toBeTruthy()
  expect(screen.getByText(locale === 'en' ? /Session log, observed/ : /Журнал сессии, наблюдение/)).toBeTruthy()
  expect(document.body.textContent).not.toContain(' · ')
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Stop session' : 'Остановить сессию' }))
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Remove queued prompt' : 'Убрать запрос из очереди' }))
  expect(stop).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledExactlyOnceWith('q')
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
  render(<NativeProgress progress={{ ...progress, shellUnavailable: 'container_runtime_unavailable' }} stop={() => {}} remove={() => {}} />)
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

it('a failed progress read keeps the last state, offers no Retry and recovers by itself', async () => {
  setActiveLocale('en')
  let fail = false, reads = 0
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url) === '/api/agent/session') { reads++; if (fail) throw new TypeError('Failed to fetch'); return Response.json({ ...progress, status: 'running' }) }
    throw new Error('Unexpected request')
  }))
  render(<NativeAgentPage sessionId="session" />)
  await screen.findByRole('region', { name: 'Session progress' })
  // A running session re-reads quietly every 500 ms; the next read fails.
  fail = true
  await screen.findByText(/Guanxi reconnects by itself/, undefined, { timeout: 2_000 })
  expect(screen.getByText('Response')).toBeTruthy()
  expect(screen.queryAllByRole('button', { name: /Retry/ })).toHaveLength(0)
  const before = reads
  fail = false
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await waitFor(() => expect(screen.queryByText(/Guanxi reconnects by itself/)).toBeNull())
  expect(reads).toBeGreaterThan(before)
})

it.each(['en', 'ru'] as const)('session errors are visible and localized in %s', locale => {
  setActiveLocale(locale)
  const view = render(<NativeProgress progress={{ ...progress, status: 'failed', error: 'agent_failed' }} stop={() => {}} remove={() => {}} />)
  expect(screen.getByRole('alert').textContent).toContain(locale === 'en' ? 'This session failed' : 'Сессия завершилась с ошибкой')
  view.rerender(<NativeProgress progress={{ ...progress, status: 'failed', error: 'cleanup_unconfirmed' }} stop={() => {}} remove={() => {}} />)
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
  expect(button.getAttribute('aria-describedby')).toBe('native-delete-description')
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
  const readsBefore = reads
  fireEvent.change(screen.getByLabelText('Ask about this session'), { target: { value: 'q' } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  await screen.findByText('Side answer')
  fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 2' }))
  await waitFor(() => expect(screen.getAllByRole('status').some(node => node.textContent === 'Running')).toBe(true))
  expect(reads).toBe(readsBefore + 1)
  expect(screen.getByRole('button', { name: 'Stop session' })).toBeTruthy()
})
