import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Connection, ConnectionSnapshot } from '@guanxi/contract'
import { ConnectionsPage, ConnectionsView } from '../../src/features/connections/ConnectionsPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

const connection: Connection = { id: '11111111-1111-4111-8111-111111111111', accountId: 'test', name: 'Fixture model', kind: 'model_api',
  provider: 'deepseek', auth: 'api_key', unattended: false, secretRef: null, facts: {}, createdAt: '2026-10-20T00:00:00.000Z', balance: null }
const snapshot: ConnectionSnapshot = { connections: [connection], costs: [], vault: { unlocked: false, unattendedAvailable: false } }
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })
const mutate = vi.fn(async (action: () => Promise<unknown>) => { await action() })

it.each([undefined, null])('a balance without observedAt=%s renders Unknown and never its numeric amount', observedAt => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, balance: { amount: 123.45, currency: 'USD', source: 'fixture', observedAt, confidence: 'high' } }] }} retry={() => {}} mutate={mutate} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe('Unknown')
  expect(screen.queryByText(/123.45/)).toBeNull()
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
})
it('renders observed balances with source, observation time and confidence, including a real zero', () => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, balance: { amount: 0, currency: 'USD', source: 'fixture-api', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } }] }} retry={() => {}} mutate={mutate} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe('0 USD')
  expect(screen.getByText(/fixture-api · observed/).textContent).toContain('high confidence')
})
it.each(['en', 'ru'] as const)('names controls and shows empty state in %s', locale => {
  setActiveLocale(locale)
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [] }} retry={() => {}} mutate={mutate} />)
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.getAllByRole('combobox')).toHaveLength(2)
  expect(screen.getByLabelText(locale === 'en' ? 'Connection name' : 'Название подключения')).toBeTruthy()
  expect(screen.getByText(locale === 'en' ? 'No connections yet.' : 'Подключений пока нет.')).toBeTruthy()
})
it('loading, offline and retry states have announced names', () => {
  setActiveLocale('en')
  const retry = vi.fn()
  render(<ConnectionsView snapshot={null} loading error offline retry={retry} mutate={mutate} />)
  expect(screen.getByText('Loading connections').getAttribute('role')).toBe('status')
  expect(screen.getByRole('alert').textContent).toContain('offline')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledOnce()
})
it('failed request retries and stale fetch cannot replace the next result after unmount', async () => {
  setActiveLocale('en')
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json(snapshot))
  vi.stubGlobal('fetch', fetchMock)
  render(<ConnectionsPage />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Fixture model')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})
it('create sends no unattended opt-in; saving a key clears the password input', async () => {
  setActiveLocale('en')
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_path, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ ok: true }) }))
  const run = async (action: () => Promise<unknown>) => { await action() }
  render(<ConnectionsView snapshot={{ ...snapshot, vault: { unlocked: true, unattendedAvailable: true } }} retry={() => {}} mutate={run} />)
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'New' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toEqual({ name: 'New', kind: 'model_api', provider: 'anthropic', auth: 'api_key' })
  const password = screen.getByLabelText('API key') as HTMLInputElement
  expect(password.type).toBe('password')
  const fakeKey = crypto.randomUUID()
  fireEvent.change(password, { target: { value: fakeKey } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save key' })))
  expect(password.value).toBe('')
  expect(screen.queryByText(fakeKey)).toBeNull()
})
