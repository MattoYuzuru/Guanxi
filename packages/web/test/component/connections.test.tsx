import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { connectionSecretInputSchema, type Connection, type ConnectionSnapshot } from '@guanxi/contract'
import { ConnectionRequestError } from '../../src/features/connections/api.ts'
import { ConnectionsPage, ConnectionsView } from '../../src/features/connections/ConnectionsPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

const DEEPSEEK = '11111111-1111-4111-8111-111111111111'
const LOCAL = '22222222-2222-4222-8222-222222222222'
const secretRef = `secret://test/${DEEPSEEK}`
const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: DEEPSEEK, accountId: 'test', name: 'DeepSeek', kind: 'model_api', provider: 'deepseek', auth: 'api_key',
  unattended: false, secretRef, facts: { origin: { value: 'provider_key_import', source: 'connection_import',
    observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } }, balance: null, createdAt: '2026-10-20T00:00:00.000Z', ...overrides,
})
const local: Connection = connection({ id: LOCAL, name: 'Ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none', secretRef: null, facts: {} })
const empty: ConnectionSnapshot = { connections: [], costs: [], vault: { unlocked: true, unattendedAvailable: false } }
const snapshot = (connections: Connection[]): ConnectionSnapshot => ({ ...empty, connections })
const run = vi.fn(async (action: () => Promise<unknown>) => {
  try { await action(); return { ok: true as const } }
  catch (error) { return { ok: false as const, code: error instanceof ConnectionRequestError ? error.code : undefined } }
})

afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru'); run.mockClear() })

it('switches catalog categories and counts connected providers, not rows', () => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={snapshot([connection(), local, connection({ id: '33333333-3333-4333-8333-333333333333', name: 'Second' })])} mutate={run} />)
  const rail = screen.getByRole('navigation', { name: 'Provider categories' })
  expect(within(rail).getByRole('button', { name: /LLM APIs/ }).textContent).toContain('1')
  expect(within(rail).getByRole('button', { name: /Local runtimes/ }).textContent).toContain('1')
  expect(screen.getByRole('article', { name: 'DeepSeek' })).toBeTruthy()
  expect(screen.queryByRole('article', { name: 'Ollama' })).toBeNull()
  expect(screen.getByText('Connected (2)')).toBeTruthy()
  fireEvent.click(within(rail).getByRole('button', { name: /Local runtimes/ }))
  expect(screen.getByRole('article', { name: 'Ollama' })).toBeTruthy()
  expect(screen.queryByRole('article', { name: 'DeepSeek' })).toBeNull()
  expect(screen.getByText('Connected (1)')).toBeTruthy()
})

it('says the auto Ollama row stays removed until it is connected from the catalog', async () => {
  setActiveLocale('en')
  const auto = connection({ id: LOCAL, name: 'Ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none', secretRef: null,
    facts: { origin: { value: 'local_runtime_auto', source: 'connection_apply', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } } })
  render(<ConnectionsView snapshot={snapshot([auto])} mutate={run} />)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Provider categories' })).getByRole('button', { name: /Local runtimes/u }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove Ollama' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/stays removed, even after a restart/u)).toBeTruthy()
  expect(within(dialog).getByText(/Sessions, roles and leads bound to this connection will fail/u)).toBeTruthy()
})

it('re-creates Ollama from the catalog when it has no live row', async () => {
  setActiveLocale('en')
  const calls: { method: string; url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/connections' && init.method === 'POST') return Response.json(connection({
      id: LOCAL, name: 'Ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none', secretRef: null, facts: {},
    }), { status: 201 })
    throw new Error(`Unexpected request ${url}`)
  }))
  render(<ConnectionsView snapshot={empty} mutate={run} />)
  const rail = screen.getByRole('navigation', { name: 'Provider categories' })
  fireEvent.click(within(rail).getByRole('button', { name: /Local runtimes/u }))
  fireEvent.click(within(screen.getByRole('article', { name: 'Ollama' })).getByRole('button', { name: 'Connect' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).queryByLabelText('API key')).toBeNull()
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' })))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls).toEqual([{ method: 'POST', url: '/api/connections',
    body: { name: 'Ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none' } }])
})

it('adds a key with create + secret, closes the dialog and never renders the key back', async () => {
  setActiveLocale('en')
  const key = 'sk-test-fixture-key'
  const calls: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/connections' && init.method === 'POST') return Response.json(connection({ name: 'DeepSeek', secretRef: null }))
    if (url.endsWith('/secret') && init.method === 'PUT') return Response.json(connection())
    throw new Error(`Unexpected request ${url}`)
  }))
  render(<ConnectionsView snapshot={empty} mutate={run} />)
  const card = screen.getByRole('article', { name: 'DeepSeek' })
  fireEvent.click(within(card).getByRole('button', { name: 'Add key' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByLabelText('Connection name')).toHaveProperty('value', 'DeepSeek')
  const field = within(dialog).getByLabelText('API key') as HTMLInputElement
  expect(field.type).toBe('password')
  expect(field.autocomplete).toBe('off')
  fireEvent.change(field, { target: { value: key } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Show key' }))
  expect(field.type).toBe('text')
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add key' })))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'DeepSeek' })))
  expect(calls.map(call => [call.method, call.url, call.body])).toEqual([
    ['POST', '/api/connections', { name: 'DeepSeek', kind: 'model_api', provider: 'deepseek', auth: 'api_key' }],
    ['PUT', `/api/connections/${DEEPSEEK}/secret`, { value: key }],
  ])
  expect(document.body.textContent).not.toContain(key)
})

it('clears the key after a failed save and rolls the half-created connection back', async () => {
  setActiveLocale('en')
  const key = 'sk-test-rejected-key'
  const methods: string[] = []
  let secretAttempts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    methods.push(`${init.method} ${url}`)
    if (url === '/api/connections' && init.method === 'POST') return Response.json(connection({ secretRef: null }))
    if (url.endsWith('/secret') && init.method === 'PUT') {
      secretAttempts += 1
      return Response.json({ code: 'validation_failed' }, { status: 400 })
    }
    if (url === `/api/connections/${DEEPSEEK}` && init.method === 'DELETE') return Response.json({ id: DEEPSEEK })
    throw new Error(`Unexpected request ${url}`)
  }))
  render(<ConnectionsView snapshot={empty} mutate={run} />)
  fireEvent.click(within(screen.getByRole('article', { name: 'DeepSeek' })).getByRole('button', { name: 'Add key' }))
  const dialog = await screen.findByRole('dialog')
  const field = within(dialog).getByLabelText('API key') as HTMLInputElement
  fireEvent.change(field, { target: { value: key } })
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add key' })))
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('invalid'))
  expect(field.value).toBe('')
  expect(secretAttempts).toBe(1)
  expect(methods).toContain(`DELETE /api/connections/${DEEPSEEK}`)
  expect(document.body.textContent).not.toContain(key)
})

it('keeps an existing connection when a rotation fails and enforces the contract key minimum', async () => {
  setActiveLocale('en')
  const calls: string[] = []
  const minimumKey = 'k'.repeat(connectionSecretInputSchema.shape.value.minLength ?? 1)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`)
    if (url.endsWith('/secret') && init.method === 'PUT') return Response.json({ code: 'vault_locked' }, { status: 423 })
    throw new Error(`Unexpected request ${url}`)
  }))
  render(<ConnectionsView snapshot={snapshot([connection()])} mutate={run} />)
  fireEvent.click(screen.getByRole('button', { name: 'Replace the key for DeepSeek' }))
  const dialog = await screen.findByRole('dialog')
  const field = within(dialog).getByLabelText('API key') as HTMLInputElement
  const submit = within(dialog).getByRole('button', { name: 'Replace key' }) as HTMLButtonElement
  fireEvent.change(field, { target: { value: minimumKey.slice(0, -1) } })
  expect(submit.disabled).toBe(true)
  fireEvent.change(field, { target: { value: minimumKey } })
  expect(submit.disabled).toBe(false)
  await act(async () => fireEvent.click(submit))
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('locked'))
  expect(calls).toEqual([`PUT /api/connections/${DEEPSEEK}/secret`])
  expect(field.value).toBe('')
  expect(screen.getByTestId(`connection-${DEEPSEEK}`)).toBeTruthy()
})

it('asks for confirmation in a dialog before DELETE and never uses window.confirm', async () => {
  setActiveLocale('en')
  const confirm = vi.fn()
  const calls: string[] = []
  vi.stubGlobal('confirm', confirm)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`)
    return Response.json({ id: DEEPSEEK })
  }))
  render(<ConnectionsView snapshot={snapshot([connection()])} mutate={run} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove DeepSeek' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Remove DeepSeek?')).toBeTruthy()
  expect(within(dialog).getByText(/Sessions, roles and leads bound to this connection will fail/u)).toBeTruthy()
  expect(calls).toEqual([])
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Remove connection' })))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'DeepSeek' })))
  expect(calls).toEqual([`DELETE /api/connections/${DEEPSEEK}`])
  expect(confirm).not.toHaveBeenCalled()
})

it('shows a failed removal once, inside its dialog instead of the page', async () => {
  setActiveLocale('en')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/connections' && (init.method ?? 'GET') === 'GET') return Response.json(snapshot([connection()]))
    if (url === `/api/connections/${DEEPSEEK}` && init.method === 'DELETE') return Response.json({ code: 'connection_in_use' }, { status: 409 })
    throw new Error(`Unexpected request ${url}`)
  }))
  render(<ConnectionsPage />)
  const row = await screen.findByTestId(`connection-${DEEPSEEK}`)
  fireEvent.click(within(row).getByRole('button', { name: 'Remove DeepSeek' }))
  const dialog = await screen.findByRole('dialog')
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Remove connection' })))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('running right now')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('alert')).toBe(alert)
})

it('shows one inline alert for a failed add and no page alert after the dialog closes', async () => {
  setActiveLocale('en')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/connections' && (init.method ?? 'GET') === 'GET') return Response.json(empty)
    if (url === '/api/connections' && init.method === 'POST') return Response.json(connection({ secretRef: null }))
    if (url.endsWith('/secret') && init.method === 'PUT') return Response.json({ code: 'validation_failed' }, { status: 400 })
    if (url === `/api/connections/${DEEPSEEK}` && init.method === 'DELETE') return Response.json({ id: DEEPSEEK })
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`)
  }))
  render(<ConnectionsPage />)
  const card = await screen.findByRole('article', { name: 'DeepSeek' })
  fireEvent.click(within(card).getByRole('button', { name: 'Add key' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'sk-test-rejected-key' } })
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Add key' })))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('invalid')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('alert')).toBe(alert)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows one inline alert for a failed rotation and no page alert after the dialog closes', async () => {
  setActiveLocale('en')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/connections' && (init.method ?? 'GET') === 'GET') return Response.json(snapshot([connection()]))
    if (url.endsWith('/secret') && init.method === 'PUT') return Response.json({ code: 'vault_locked' }, { status: 423 })
    throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`)
  }))
  render(<ConnectionsPage />)
  const card = await screen.findByRole('article', { name: 'DeepSeek' })
  fireEvent.click(within(card).getByRole('button', { name: 'Replace the key for DeepSeek' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'sk-test-rejected-key' } })
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Replace key' })))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('locked')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('alert')).toBe(alert)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('alert')).toBeNull()
})

it('lists models with search and marks a local runtime error inline without a Retry button', async () => {
  setActiveLocale('en')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'alpha:latest', facts: {} }, { id: 'beta:latest', facts: {} }])))
  const view = render(<ConnectionsView snapshot={snapshot([connection()])} mutate={run} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show models for DeepSeek' }))
  const search = await screen.findByLabelText('Search models')
  await screen.findByText('alpha:latest')
  expect(screen.getByText('beta:latest')).toBeTruthy()
  fireEvent.change(search, { target: { value: 'BET' } })
  expect(screen.queryByText('alpha:latest')).toBeNull()
  expect(screen.getByText('beta:latest')).toBeTruthy()
  expect(screen.queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
  view.unmount()

  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'provider_failed' }, { status: 502 })))
  render(<ConnectionsView snapshot={snapshot([local])} mutate={run} />)
  fireEvent.click(screen.getByRole('button', { name: /Local runtimes/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Show models for Ollama' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Models could not be listed.')
  expect(alert.textContent).toContain('provider request failed')
  expect(screen.queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
})

it('a failed read recovers by itself, keeps the alert until a read succeeds and offers no Retry', async () => {
  setActiveLocale('en')
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(Response.json(snapshot([connection()])))
  vi.stubGlobal('fetch', fetchMock)
  render(<ConnectionsPage />)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('could not be read')
  expect(screen.queryAllByRole('button', { name: /retry|refresh/iu })).toHaveLength(0)
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await screen.findByRole('article', { name: 'DeepSeek' })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows one vault action in the header and unlocks from a failed initial load', async () => {
  setActiveLocale('en')
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push(`${init.method ?? 'GET'} ${url}`)
    if (url === '/api/connections/vault/unlock') return Response.json({ ok: true })
    return Response.json(snapshot([connection()]))
  }))
  render(<ConnectionsView snapshot={{ ...snapshot([connection()]), vault: { unlocked: false, unattendedAvailable: false } }} mutate={run} />)
  const unlock = screen.getAllByRole('button', { name: 'Unlock vault' })
  expect(unlock).toHaveLength(1)
  await act(async () => fireEvent.click(unlock[0]!))
  expect(requests).toEqual(['POST /api/connections/vault/unlock'])
})

it('keeps the Russian removal copy on redacting old logs, not editing them', async () => {
  setActiveLocale('ru')
  render(<ConnectionsView snapshot={snapshot([connection()])} mutate={run} />)
  fireEvent.click(screen.getByRole('button', { name: 'Удалить DeepSeek' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/только чтобы скрывать ключ в старых журналах/u)).toBeTruthy()
  expect(within(dialog).queryByText(/редактирования старых журналов/u)).toBeNull()
})

it.each([
  ['en', 'in use by a call that is running right now'], ['ru', 'используется вызовом, который выполняется прямо сейчас'],
] as const)('renders the typed in-use refusal in %s', (locale, copy) => {
  setActiveLocale(locale)
  render(<ConnectionsView snapshot={null} error errorCode="connection_in_use" mutate={run} />)
  expect(screen.getByRole('alert').textContent).toContain(copy)
  expect(screen.queryAllByRole('button', { name: /retry/iu })).toHaveLength(0)
})

it('names the offline state while keeping the last snapshot', () => {
  setActiveLocale('en')
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
  try {
    render(<ConnectionsView snapshot={snapshot([connection()])} offline mutate={run} />)
    expect(screen.getByText(/This browser is offline/)).toBeTruthy()
    expect(screen.getByRole('article', { name: 'DeepSeek' })).toBeTruthy()
  } finally {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  }
})

it('formats an observed balance with its literal amount-space-currency', () => {
  setActiveLocale('en')
  render(<ConnectionsView snapshot={snapshot([connection({ balance: { amount: 1234.5, currency: 'USD', source: 'fixture', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } })])} mutate={run} />)
  expect(screen.getByTestId('connection-balance').textContent).toBe('1,234.5 USD')
})

it('shows only the immutable API host for a compatible connection', () => {
  setActiveLocale('en')
  const view = render(<ConnectionsView snapshot={snapshot([connection({ provider: 'openai', name: 'OpenAI-compatible (api.example.invalid)', baseUrl: 'https://api.example.invalid:9443/private-api/v1' })])} mutate={run} />)
  expect(screen.getByText('OpenAI-compatible (api.example.invalid)')).toBeTruthy()
  expect(view.container.textContent).not.toContain('/private-api/v1')
})
