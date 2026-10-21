import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeAgentPage, NativeProgress } from '../../src/features/native-agent/NativeAgentPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import type { AgentProgress } from '@guanxi/contract'
const progress: AgentProgress = { sessionId: 'session', projectId: 'p', connectionId: 'c', model: 'fixture', mode: 'read-only',
  status: 'running', plan: [{ text: 'Inspect', status: 'verification_requested' }], queue: [{ id: 'q', text: 'Follow up' }],
  summary: 'Response', error: null, observedAt: '2026-10-21T00:00:00.000Z', source: 'session.log', confidence: 'high' }
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })
it.each(['en', 'ru'] as const)('progress renders exact plan/queue counts with provenance, keyboard actions and localized status in %s', locale => {
  setActiveLocale(locale)
  const stop = vi.fn(), remove = vi.fn()
  render(<NativeProgress progress={progress} stop={stop} remove={remove} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText(locale === 'en' ? /Verification requested/ : /Требуется проверка/)).toBeTruthy()
  expect(screen.getByText(locale === 'en' ? /Session log · observed/ : /Журнал сессии · наблюдение/)).toBeTruthy()
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
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p' } })
  fireEvent.change(screen.getByLabelText('Connection'), { target: { value: '11111111-1111-4111-8111-111111111111' } })
  expect(screen.getByText('No folders · scratch only')).toBeTruthy()
  expect((screen.getByLabelText('Access mode') as HTMLSelectElement).value).toBe('read-only')
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'fixture' } })
  fireEvent.change(screen.getByLabelText('What should the agent do?'), { target: { value: 'Inspect' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ mode: 'read-only', domains: [], attachmentIds: [], protectedPaths: [] })
})
it('failed/offline choices announce a recoverable error and prevent dispatch', async () => {
  setActiveLocale('en'); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  render(<NativeAgentPage sessionId={null} />)
  await screen.findByRole('alert')
  expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})
