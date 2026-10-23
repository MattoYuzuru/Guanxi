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
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, balance: { amount: 123.45, currency: 'USD', source: 'fixture', observedAt, confidence: 'high' } }] }} mutate={mutate} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe('Unknown')
  expect(screen.queryByText(/123.45/)).toBeNull()
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('switch').textContent).toBe('Unattended use: off')
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
})
it('renders observed balances with source, observation time and confidence, including a real zero', () => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, balance: { amount: 0, currency: 'USD', source: 'fixture-api', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } }] }} mutate={mutate} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe('0 USD')
  expect(screen.getByText(/fixture-api, observed/).textContent).toContain('high confidence')
})
it.each(['en', 'ru'] as const)('names controls and shows empty state in %s', locale => {
  setActiveLocale(locale)
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [] }} mutate={mutate} />)
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.getAllByRole('combobox')).toHaveLength(2)
  expect(screen.getByLabelText(locale === 'en' ? 'Connection name' : 'Название подключения')).toBeTruthy()
  expect(screen.getByText(locale === 'en' ? 'No connections yet.' : 'Подключений пока нет.')).toBeTruthy()
})
it('loading, offline and recovering states have announced names and no Retry button', () => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={null} loading error offline recovering mutate={mutate} />)
  expect(screen.getByText('Loading connections').getAttribute('role')).toBe('status')
  expect(screen.getByRole('alert').textContent).toContain('offline')
  expect(screen.getByRole('alert').textContent).toContain('Guanxi tries again by itself.')
  expect(screen.queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
})
it('a failed request recovers by itself and stale fetch cannot replace the next result after unmount', async () => {
  setActiveLocale('en')
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json(snapshot))
  vi.stubGlobal('fetch', fetchMock)
  render(<ConnectionsPage />)
  await screen.findByRole('alert')
  expect(screen.queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await screen.findByText('Fixture model')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})
it('create sends no unattended opt-in; saving a key clears the password input', async () => {
  setActiveLocale('en')
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_path, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ ok: true }) }))
  const run = async (action: () => Promise<unknown>) => { await action() }
  render(<ConnectionsView snapshot={{ ...snapshot, vault: { unlocked: true, unattendedAvailable: true } }} mutate={run} />)
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'New' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]).toEqual({ name: 'New', kind: 'model_api', provider: 'anthropic', auth: 'api_key' })
  const password = screen.getByLabelText('API key') as HTMLInputElement
  expect(password.type).toBe('password')
  expect(password.autocomplete).toBe('off')
  const fakeKey = crypto.randomUUID()
  fireEvent.change(password, { target: { value: fakeKey } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save key' })))
  expect(password.value).toBe('')
  expect(screen.queryByText(fakeKey)).toBeNull()
})

it('formats observation numbers and dates in the chosen locale and visibly labels unattended state', () => {
  setActiveLocale('ru')
  const observedAt = '2026-10-20T00:00:00.000Z'
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, unattended: true,
    balance: { amount: 1234.5, currency: 'USD', source: 'locale-fixture', observedAt, confidence: 'high' },
  }] }} mutate={mutate} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe(`${(1234.5).toLocaleString('ru')} USD`)
  expect(screen.getByText(/locale-fixture/).textContent).toContain(new Date(observedAt).toLocaleString('ru'))
  expect(screen.getByRole('switch').textContent).toBe('Фоновое использование: вкл.')
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it.each(['en', 'ru'] as const)('facts and metered costs render value, source, time and confidence in %s', locale => {
  setActiveLocale(locale)
  const observedAt = '2026-10-20T11:22:33.000Z'
  const time = new Date(observedAt).toLocaleString(locale)
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, facts: {
    'pi-ai.context': { value: 8192, source: 'catalog-fixture', observedAt, confidence: 'medium' },
    'unobserved.limit': { value: 987654321, source: 'missing-time', observedAt: null, confidence: 'high' },
  } }], costs: [{ id: 'cost-fixture', accountId: connection.accountId, connectionId: connection.id,
    runId: 'run-fixture', requestId: 'request-fixture', inputTokens: 10, outputTokens: 2, costUsd: 0.125,
    source: 'usage-fixture', observedAt, confidence: 'medium' }],
  }} mutate={mutate} />)
  const fact = screen.getByText('pi-ai.context: 8192').parentElement!
  expect(fact.textContent).toContain('catalog-fixture')
  expect(fact.textContent).toContain(time)
  expect(fact.textContent).toContain(locale === 'en' ? 'estimated' : 'оценка')
  expect(screen.getByText(/usage-fixture/).textContent).toContain((0.125).toLocaleString(locale))
  expect(screen.getByText(/usage-fixture/).textContent).toContain(time)
  expect(screen.getByText(/usage-fixture/).textContent).toContain(locale === 'en' ? 'estimated' : 'оценка')
  expect(screen.queryByText(/987654321/)).toBeNull()
  expect(screen.getByText(/unobserved.limit:/).textContent).toContain(locale === 'en' ? 'Unknown' : 'Неизвестно')
})

it.each([
  ['connection_not_found', 'no longer exists'], ['vault_locked', 'vault is locked'],
  ['policy_denied', 'disabled by'], ['egress_unavailable', 'protection is not ready'],
  ['internal_error', 'could not process'], ['validation_failed', 'details are invalid'], ['provider_failed', 'provider request failed'],
] as const)('shows an actionable message for %s', (code, message) => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={null} error errorCode={code} mutate={mutate} />)
  expect(screen.getByRole('alert').textContent).toContain(message)
  if (code === 'vault_locked') expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeTruthy()
  expect(screen.queryAllByRole('button', { name: /retry/iu })).toHaveLength(0)
})

it('preserves the server recovery code and unlocks from a failed initial load', async () => {
  setActiveLocale('en')
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    requests.push(path)
    if (requests.length === 1) return Response.json({ code: 'vault_locked' }, { status: 423 })
    if (path.endsWith('/unlock')) return Response.json({ ok: true })
    return Response.json({ ...snapshot, vault: { ...snapshot.vault, unlocked: true } })
  }))
  render(<ConnectionsPage />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Unlock vault' }))
  await screen.findByText('Vault unlocked')
  expect(requests).toEqual(['/api/connections', '/api/connections/vault/unlock', '/api/connections'])
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([
  ['en', '1,234.5 CNY', '0.125 USD'],
  ['ru', '1\u00a0234,5 CNY', '0,125 USD'],
] as const)('uses a literal amount-space-currency format in %s for balances and costs', (locale, balance, cost) => {
  setActiveLocale(locale)
  const observedAt = '2026-10-20T11:22:33.000Z'
  render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection,
    balance: { amount: 1234.5, currency: 'CNY', source: 'currency-fixture', observedAt, confidence: 'high' },
  }], costs: [{ id: 'currency-cost', accountId: connection.accountId, connectionId: connection.id,
    runId: 'run', requestId: 'request', inputTokens: 1, outputTokens: 1, costUsd: 0.125,
    source: 'currency-cost-fixture', observedAt, confidence: 'medium' }],
  }} mutate={mutate} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe(balance)
  expect(screen.getByText(/currency-cost-fixture/).textContent).toContain(`${cost},`)
})

it('shows only the immutable API host for a compatible connection', () => {
  setActiveLocale('en')
  const view = render(<ConnectionsView snapshot={{ ...snapshot, connections: [{ ...connection, provider: 'openai',
    baseUrl: 'https://api.example.invalid:9443/private-api/v1',
  }] }} retry={() => {}} mutate={mutate} />)
  expect(screen.getByText('API host: api.example.invalid:9443')).toBeTruthy()
  expect(view.container.textContent).not.toContain('/private-api/v1')
})
