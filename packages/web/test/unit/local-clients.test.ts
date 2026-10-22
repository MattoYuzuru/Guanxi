import { afterEach, describe, expect, it, vi } from 'vitest'
import { glossaryApi } from '../../src/features/voice/api.ts'
import { newIdempotencyKey, notificationsApi } from '../../src/features/notifications/api.ts'
import { workApi } from '../../src/features/work/api.ts'
import { LocalApiError, LocalApiShapeError, localRequest } from '../../src/lib/local-api.ts'
import { notificationErrorSchema, notificationSchema } from '@guanxi/contract'

const NID = `ntf_${'a'.repeat(40)}`
const notification = {
  id: NID, kind: 'threshold', severity: 'warning', subject: { type: 'connection', id: 'c1' },
  facts: { window: 'five_hour', threshold: 10, remainingPercent: 9, resetsAt: null, source: 'local-meter', observedAt: '2026-10-23T00:00:00.000Z', confidence: 'observed' },
  actions: ['open', 'snooze'], state: 'unread', snoozedUntil: null, createdAt: 1, updatedAt: 1,
}
const entry = { id: 'hono', canonical: 'Hono', variants: ['хоно'], language: 'en' }
const stored = { id: 'hono', scope: 'account', projectId: null, entry, active: true, revision: 1, createdAt: 1, updatedAt: 1 }
const item = { id: 'a', title: 'Do it', acceptance: null, dependsOn: [], estimateMinutes: null, ownerRole: null, protectedPaths: [] }
const plan = { projectId: 'p1', revision: 1, createdAt: '2026-10-23T00:00:00.000Z', author: 'user', items: [item] }

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function respond(status: number, body: unknown) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('local transport', () => {
  it('turns a stable error body into a typed code', async () => {
    respond(501, { code: 'not_configured' })
    const error = await notificationsApi.get(NID).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(LocalApiError)
    expect(error).toMatchObject({ status: 501, code: 'not_configured' })
    expect((error as Error).message).toBe('not_configured')
  })

  it('does not surface server message text: an error body with extra fields is unexpected', async () => {
    respond(501, { code: 'not_configured', message: 'secret prompt text' })
    const error = await notificationsApi.get(NID).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 501, code: 'unexpected_response' })
    expect(JSON.stringify(error)).not.toContain('secret prompt text')
    expect((error as Error).message).not.toContain('secret')
  })

  it('reports an unexpected_response for an error body outside the contract', async () => {
    respond(500, '<html>proxy</html>')
    await expect(notificationsApi.get(NID)).rejects.toMatchObject({ status: 500, code: 'unexpected_response' })
    respond(400, { code: 'definitely_not_a_code' })
    await expect(notificationsApi.get(NID)).rejects.toMatchObject({ code: 'unexpected_response' })
  })

  it('treats a 200 that breaks the contract as a shape error, not a result', async () => {
    respond(200, { ...notification, state: 'maybe' })
    await expect(notificationsApi.get(NID)).rejects.toBeInstanceOf(LocalApiShapeError)
    respond(200, { ...notification, accountId: 'local' })
    await expect(notificationsApi.get(NID)).rejects.toBeInstanceOf(LocalApiShapeError)
  })

  it('sends JSON content type only when there is a body', async () => {
    const { calls } = respond(200, notification)
    await localRequest('/x', notificationSchema, notificationErrorSchema)
    await localRequest('/x', notificationSchema, notificationErrorSchema, { method: 'POST', body: {} })
    expect(calls[0]!.headers['Content-Type']).toBeUndefined()
    expect(calls[1]!.headers['Content-Type']).toBe('application/json')
  })
})

describe('notificationsApi', () => {
  it('lists with a comma state filter, a limit and a cursor, and parses the page', async () => {
    const { calls } = respond(200, { notifications: [notification], nextCursor: NID })
    const page = await notificationsApi.list({ states: ['unread', 'snoozed'], limit: 20, before: NID })
    expect(calls[0]!.method).toBe('GET')
    const url = new URL(calls[0]!.url, 'http://x')
    expect(url.pathname).toBe('/api/notifications')
    expect(url.searchParams.get('state')).toBe('unread,snoozed')
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.get('before')).toBe(NID)
    expect(page.notifications[0]!.id).toBe(NID)
    expect(page.nextCursor).toBe(NID)
  })

  it('omits empty filters', async () => {
    const { calls } = respond(200, { notifications: [], nextCursor: null })
    await notificationsApi.list({ states: [] })
    expect(calls[0]!.url).toBe('/api/notifications')
  })

  it('reads, marks read and snoozes on the documented paths', async () => {
    const { calls } = respond(200, notification)
    await notificationsApi.get(NID)
    await notificationsApi.markRead(NID)
    await notificationsApi.snooze(NID, 1_900_000_000_000)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET /api/notifications/${NID}`,
      `POST /api/notifications/${NID}/read`,
      `POST /api/notifications/${NID}/snooze`,
    ])
    expect(calls[1]!.body).toEqual({})
    expect(calls[2]!.body).toEqual({ untilMs: 1_900_000_000_000 })
  })

  it('executes a content-free action with the idempotency header', async () => {
    const { calls } = respond(200, { notificationId: NID, action: 'wake_leads', status: 'done', result: { woken: 2 }, duplicate: false })
    const key = newIdempotencyKey()
    const response = await notificationsApi.execute(NID, { action: 'wake_leads', args: {} }, key)
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/notifications/${NID}/actions` })
    expect(calls[0]!.headers['Idempotency-Key']).toBe(key)
    expect(calls[0]!.body).toEqual({ action: 'wake_leads', args: {} })
    expect(response).toMatchObject({ status: 'done', duplicate: false })
  })

  it('never sends a content-bearing action or a bad key or id', async () => {
    const { fetchMock } = respond(200, {})
    const key = newIdempotencyKey()
    expect(() => notificationsApi.execute(NID, { action: 'add_prompt', args: { prompt: 'private words' } } as never, key)).toThrow()
    expect(() => notificationsApi.execute(NID, { action: 'switch_connection', args: { connectionId: 'c1', reason: 'because' } } as never, key)).toThrow()
    expect(() => notificationsApi.execute(NID, { action: 'open', args: {} }, 'short')).toThrow()
    expect(() => notificationsApi.get('../etc/passwd')).toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses the action availability table', async () => {
    respond(200, { actions: [{ action: 'wake_leads', availability: 'not_configured' }, { action: 'add_prompt', availability: 'not_exposed' }] })
    const table = await notificationsApi.actions()
    expect(table.actions.map((row) => row.availability)).toEqual(['not_configured', 'not_exposed'])
  })

  it('creates a distinct valid key per intent', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey())
  })
})

describe('glossaryApi', () => {
  it('lists with project and inactive filters', async () => {
    const { calls } = respond(200, { entries: [stored] })
    const result = await glossaryApi.list({ projectId: 'p1', includeInactive: true })
    const url = new URL(calls[0]!.url, 'http://x')
    expect(url.pathname).toBe('/api/voice/glossary')
    expect(url.searchParams.get('projectId')).toBe('p1')
    expect(url.searchParams.get('includeInactive')).toBe('true')
    expect(result.entries[0]!.entry.canonical).toBe('Hono')
  })

  it('creates, updates and runs lifecycle commands on the documented paths', async () => {
    const { calls } = respond(200, stored)
    await glossaryApi.create({ scope: 'account', entry: { canonical: 'Hono', variants: ['хоно'], language: 'en' } })
    await glossaryApi.update('hono', { entry: { canonical: 'Hono', variants: [], language: 'en' } })
    await glossaryApi.deactivate('hono')
    await glossaryApi.reactivate('hono')
    await glossaryApi.revert('hono')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/voice/glossary',
      'PUT /api/voice/glossary/hono',
      'POST /api/voice/glossary/hono/deactivate',
      'POST /api/voice/glossary/hono/reactivate',
      'POST /api/voice/glossary/hono/revert',
    ])
    expect(calls[2]!.body).toEqual({})
  })

  it('reads history and previews without storing', async () => {
    respond(200, { revisions: [{ entryId: 'hono', revision: 1, op: 'create', entry, source: 'user', createdAt: 1 }] })
    expect((await glossaryApi.history('hono')).revisions[0]!.op).toBe('create')
    const { calls } = respond(200, { text: 'Hono', replacements: [{ start: 0, end: 4, original: 'хоно', replacement: 'Hono', entryId: 'hono' }], glossaryRevision: 'f'.repeat(64), entryCount: 1 })
    const preview = await glossaryApi.preview({ text: 'хоно', projectId: null })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/voice/glossary/apply-preview', body: { text: 'хоно', projectId: null } })
    expect(preview.replacements).toHaveLength(1)
  })

  it('refuses invalid input before the network', async () => {
    const { fetchMock } = respond(200, {})
    expect(() => glossaryApi.create({ scope: 'project', entry: { canonical: 'X', variants: [], language: 'en' } })).toThrow()
    expect(() => glossaryApi.update('bad id', { entry: { canonical: 'X', variants: [], language: 'en' } })).toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('workApi', () => {
  it('reads the latest revision, possibly none', async () => {
    const { calls } = respond(200, { revision: null })
    expect((await workApi.latestRevision('p1')).revision).toBeNull()
    expect(calls[0]!.url).toBe('/api/work/projects/p1/revision')
    respond(200, { revision: plan })
    expect((await workApi.latestRevision('p1')).revision?.items).toHaveLength(1)
  })

  it('adds a revision and fills item defaults', async () => {
    const { calls } = respond(201, plan)
    await workApi.addRevision('p1', { items: [{ id: 'a', title: 'Do it' }] })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/work/projects/p1/revisions' })
    expect(calls[0]!.body).toEqual({ items: [item] })
  })

  it('appends only human events and never sends a producer or time', async () => {
    const { calls, fetchMock } = respond(201, { seq: 1, event: { type: 'human_decision', itemId: 'a', decision: 'done', at: '2026-10-23T00:00:00.000Z', source: 'user:local' } })
    const response = await workApi.appendEvent('p1', { type: 'human_decision', itemId: 'a', decision: 'done' })
    expect(calls[0]!.body).toEqual({ type: 'human_decision', itemId: 'a', decision: 'done' })
    expect(response.event.source).toBe('user:local')
    fetchMock.mockClear()
    expect(() => workApi.appendEvent('p1', { type: 'acceptance_result', itemId: 'a' } as never)).toThrow()
    expect(() => workApi.appendEvent('p1', { type: 'accepted', itemId: 'a', source: 'harness:acceptance' } as never)).toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pages items with status, cursor and limit', async () => {
    const { calls } = respond(200, { revision: 1, items: [{ ...item, status: 'ready', reason: 'ready', evidence: [] }], nextCursor: null, total: 1, warnings: [] })
    const page = await workApi.items('p1', { status: 'ready', cursor: 'abc_-', limit: 5 })
    const url = new URL(calls[0]!.url, 'http://x')
    expect(url.pathname).toBe('/api/work/projects/p1/items')
    expect([url.searchParams.get('status'), url.searchParams.get('cursor'), url.searchParams.get('limit')]).toEqual(['ready', 'abc_-', '5'])
    expect(page.items[0]!.status).toBe('ready')
  })

  it('gets and sets the mode, and exports Markdown', async () => {
    const { calls } = respond(200, { projectId: 'p1', mode: 'off', reason: 'default' })
    await workApi.mode('p1')
    await workApi.setMode('p1', { mode: 'project', reason: 'two executors' })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/work/projects/p1/mode', 'PUT /api/work/projects/p1/mode'])
    expect(calls[1]!.body).toEqual({ mode: 'project', reason: 'two executors' })
    respond(200, { projectId: 'p1', revision: 2, markdown: '# Work ledger\n' })
    expect((await workApi.exportMarkdown('p1')).markdown).toContain('# Work ledger')
  })

  it('maps a stable work error and refuses a bad project id before the network', async () => {
    respond(422, { code: 'dependency_cycle' })
    await expect(workApi.addRevision('p1', { items: [{ id: 'a', title: 'A', dependsOn: ['a'] }] })).rejects.toMatchObject({ status: 422, code: 'dependency_cycle' })
    const { fetchMock } = respond(200, {})
    expect(() => workApi.mode('p/../1')).toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
