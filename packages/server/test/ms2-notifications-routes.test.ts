import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import {
  NOTIFICATION_ERROR_CODES,
  listNotificationsResponseSchema,
  notificationActionResponseSchema,
  notificationActionsResponseSchema,
  notificationErrorSchema,
  notificationSchema,
  type NotificationErrorCode,
} from '@guanxi/contract'
import { NotificationActionError, type ActionPorts } from '../src/notifications/actions.ts'
import { NotificationStoreError } from '../src/notifications/store.ts'
import { notificationFailure } from '../src/notifications/wire.ts'
import { InboxError } from '../src/notifications/inbox.ts'
import { REMOTE_PEER, T0, call, ms2Fixture, quotaFact, type Ms2Options } from './ms2-fixture.ts'

const KEY = 'key-aaaaaaaa-0001'
const actionHeaders = (key: string) => ({ 'idempotency-key': key })

async function withNotifications(t: TestContext, connections: string[] = ['conn-a'], options: Ms2Options = {}) {
  const fixture = await ms2Fixture(t, options)
  const ids: string[] = []
  for (const connection of connections) {
    const [created] = fixture.inbox()!.ingest.ingestQuotaFact('local', quotaFact(connection, 19))
    assert.ok(created, 'a 19% fact crosses the 20% threshold')
    ids.push(created.id)
  }
  return { ...fixture, ids }
}

/** Every failing response must be exactly `{ code }` with a code from the contract enum. */
function assertError(response: { status: number; json: unknown; text: string }, status: number, code: NotificationErrorCode) {
  assert.equal(response.status, status, response.text)
  assert.deepEqual(response.json, { code })
  assert.doesNotThrow(() => notificationErrorSchema.parse(response.json))
}

function spyPorts(overrides: Partial<ActionPorts> = {}) {
  const calls: string[] = []
  const record = (name: string, result: unknown = { ok: true }) => async () => { calls.push(name); return result }
  const done = new Set<string>()
  const ports: ActionPorts = {
    open: record('open'), addPrompt: record('addPrompt'), acceptRecommendation: record('acceptRecommendation'),
    chooseAction: record('chooseAction'), wakeLeads: record('wakeLeads', { woken: 2 }),
    switchConnection: record('switchConnection'), pauseRuns: record('pauseRuns'), resumeRuns: record('resumeRuns'),
    snooze: record('snooze'), raiseBudget: record('raiseBudget'),
    hasCompleted: (key) => done.has(key),
    ...overrides,
  }
  return { ports, calls, done }
}

test('lists newest first with contract-shaped, account-free rows', async (t) => {
  const f = await withNotifications(t)
  const empty = await call(f.other, '/api/notifications')
  assert.deepEqual(empty.json, { notifications: [], nextCursor: null })
  const response = await call(f.app, '/api/notifications')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const page = listNotificationsResponseSchema.parse(response.json)
  assert.equal(page.notifications.length, 1)
  assert.equal(page.notifications[0]!.id, f.ids[0])
  assert.equal(page.notifications[0]!.state, 'unread')
  assert.deepEqual(page.notifications[0]!.facts.confidence, 'observed')
  for (const internal of ['accountId', 'account_id', 'idempotencyKey', 'instanceKey', '"local"', '|']) {
    assert.ok(!response.text.includes(internal), `${internal} must not cross the wire`)
  }
})

test('pages by notification id without losing or repeating rows that share a millisecond', async (t) => {
  const f = await withNotifications(t, ['c1', 'c2', 'c3', 'c4', 'c5'])
  const seen: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const query: string = `limit=2${cursor === null ? '' : `&before=${cursor}`}`
    const response = await call(f.app, `/api/notifications?${query}`)
    const page = listNotificationsResponseSchema.parse(response.json)
    assert.ok(page.notifications.length <= 2)
    seen.push(...page.notifications.map((row) => row.id))
    cursor = page.nextCursor
    pages += 1
  } while (cursor !== null && pages < 10)
  assert.equal(pages, 3, 'five rows at two per page')
  assert.equal(new Set(seen).size, 5, 'no repeats')
  assert.deepEqual([...seen].sort(), [...f.ids].sort(), 'no losses')
  const exact = listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications?limit=5')).json)
  assert.equal(exact.nextCursor, null, 'a page that holds every row has no next page')
})

test('rejects bad list queries and foreign cursors', async (t) => {
  const f = await withNotifications(t)
  const [foreign] = f.inbox()!.ingest.ingestQuotaFact('other-account', quotaFact('conn-z', 19))
  for (const query of ['state=bogus', 'state=unread,nope', 'limit=0', 'limit=201', 'limit=abc', 'before=not-an-id', 'extra=1']) {
    assertError(await call(f.app, `/api/notifications?${query}`), 400, 'validation_failed')
  }
  assertError(await call(f.app, `/api/notifications?before=${foreign!.id}`), 404, 'notification_not_found')
  const mine = listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications')).json)
  assert.ok(mine.notifications.every((row) => row.id !== foreign!.id), 'another account row never appears')
})

test('filters by state', async (t) => {
  const f = await withNotifications(t, ['c1', 'c2'])
  await call(f.app, `/api/notifications/${f.ids[0]}/read`, { json: {} })
  const unread = listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications?state=unread')).json)
  assert.deepEqual(unread.notifications.map((row) => row.id), [f.ids[1]])
  const both = listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications?state=unread,read')).json)
  assert.equal(both.notifications.length, 2)
})

test('gets and marks read; another account sees a missing row', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json).state, 'unread')
  const read = await call(f.app, `/api/notifications/${id}/read`, { json: {} })
  assert.equal(notificationSchema.parse(read.json).state, 'read')
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}/read`, { json: {} })).json).state, 'read', 'idempotent')
  assertError(await call(f.app, `/api/notifications/ntf_${'0'.repeat(40)}`), 404, 'notification_not_found')
  assertError(await call(f.app, '/api/notifications/not-an-id'), 400, 'validation_failed')
  assertError(await call(f.app, `/api/notifications/${id}/read`, { json: { extra: true } }), 400, 'validation_failed')
  // Account isolation on every id-addressed route.
  assertError(await call(f.other, `/api/notifications/${id}`), 404, 'notification_not_found')
  assertError(await call(f.other, `/api/notifications/${id}/read`, { json: {} }), 404, 'notification_not_found')
  assertError(await call(f.other, `/api/notifications/${id}/snooze`, { json: { untilMs: T0 + 60_000 } }), 404, 'notification_not_found')
  assertError(await call(f.other, `/api/notifications/${id}/actions`, { json: { action: 'open', args: {} }, headers: actionHeaders(KEY) }), 404, 'notification_not_found')
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json).state, 'read', 'the other account changed nothing')
})

test('snoozes into the future, refuses the past, and returns after the deadline without a timer', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  const until = T0 + 60 * 60_000
  const snoozed = notificationSchema.parse((await call(f.app, `/api/notifications/${id}/snooze`, { json: { untilMs: until } })).json)
  assert.equal(snoozed.state, 'snoozed')
  assert.equal(snoozed.snoozedUntil, until)
  assertError(await call(f.app, `/api/notifications/${id}/snooze`, { json: { untilMs: T0 } }), 422, 'invalid_snooze_time')
  assertError(await call(f.app, `/api/notifications/${id}/snooze`, { json: { untilMs: T0 - 1 } }), 422, 'invalid_snooze_time')
  for (const bad of [1.5, -1, 'soon', null]) {
    assertError(await call(f.app, `/api/notifications/${id}/snooze`, { json: { untilMs: bad } }), 400, 'validation_failed')
  }
  assert.equal(listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications?state=unread')).json).notifications.length, 0)
  f.clock.now = until + 1
  const after = listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications?state=unread')).json)
  assert.deepEqual(after.notifications.map((row) => row.id), [id], 'the deadline passed, so the next read brings it back')
  assert.equal(after.notifications[0]!.snoozedUntil, null)
})

test('reports which actions exist without pretending', async (t) => {
  const f = await withNotifications(t)
  const table = notificationActionsResponseSchema.parse((await call(f.app, '/api/notifications/actions')).json)
  const availability = Object.fromEntries(table.actions.map((row) => [row.action, row.availability]))
  assert.deepEqual(availability, {
    open: 'available', snooze: 'available',
    accept_recommendation: 'not_configured', wake_leads: 'not_configured', switch_connection: 'not_configured',
    pause_runs: 'not_configured', resume_runs: 'not_configured',
    add_prompt: 'not_exposed', choose_action: 'not_exposed', raise_budget: 'not_exposed',
  })
  const configured = await withNotifications(t, ['conn-a'], { ports: spyPorts().ports })
  const live = notificationActionsResponseSchema.parse((await call(configured.app, '/api/notifications/actions')).json)
  assert.equal(live.actions.find((row) => row.action === 'wake_leads')!.availability, 'available')
  assert.equal(live.actions.find((row) => row.action === 'add_prompt')!.availability, 'not_exposed', 'a configured port is still not exposed')
})

test('refuses an unconfigured action as not_configured without writing a reservation', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  for (const [action, args] of [['wake_leads', {}], ['switch_connection', { connectionId: 'conn-b' }], ['pause_runs', {}], ['accept_recommendation', {}]] as const) {
    const response = await call(f.app, `/api/notifications/${id}/actions`, { json: { action, args }, headers: actionHeaders(`key-${action}-0001`) })
    assertError(response, 501, 'not_configured')
  }
  const rows = f.inbox()!.store.db.prepare('SELECT COUNT(*) AS n FROM notification_actions').get() as { n: number }
  assert.equal(rows.n, 0, 'a refusal leaves no started row behind')
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json).state, 'unread', 'the notification stays actionable')
  assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'wake_leads', args: {} }, headers: actionHeaders('key-wake-0002') }), 501, 'not_configured')
})

test('executes the built-in open action once and marks the notification read', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  const first = await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'open', args: {} }, headers: actionHeaders(KEY) })
  assert.equal(first.status, 200, first.text)
  assert.deepEqual(notificationActionResponseSchema.parse(first.json), {
    notificationId: id, action: 'open', status: 'done', result: { acknowledged: true }, duplicate: false,
  })
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json).state, 'read')
  const again = notificationActionResponseSchema.parse((await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'open', args: {} }, headers: actionHeaders(KEY) })).json)
  assert.equal(again.duplicate, true)
  assert.equal(again.status, 'done')
})

test('the snooze action snoozes through the same guard as the dedicated route', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  const until = T0 + 5 * 60_000
  const response = await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'snooze', args: { untilMs: until } }, headers: actionHeaders(KEY) })
  assert.equal(response.status, 200, response.text)
  const row = notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json)
  assert.equal(row.state, 'snoozed')
  assert.equal(row.snoozedUntil, until)
  assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'snooze', args: { untilMs: T0 - 5 } }, headers: actionHeaders('key-past-0002') }), 422, 'invalid_snooze_time')
})

test('a configured port runs exactly once per key, across duplicates and concurrent retries', async (t) => {
  const { ports, calls } = spyPorts()
  const f = await withNotifications(t, ['conn-a'], { ports })
  const id = f.ids[0]!
  const send = () => call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'wake_leads', args: {} }, headers: actionHeaders(KEY) })
  const [one, two] = await Promise.all([send(), send()])
  assert.equal(one.status, 200, one.text)
  assert.equal(two.status, 200, two.text)
  const third = notificationActionResponseSchema.parse((await send()).json)
  assert.equal(third.duplicate, true)
  assert.deepEqual(calls, ['wakeLeads'], 'three requests, one effect')
  assert.deepEqual(third.result, { woken: 2 })
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json).state, 'acted')
  assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'pause_runs', args: {} }, headers: actionHeaders('key-second-0002') }), 409, 'notification_acted')
  assert.deepEqual(calls, ['wakeLeads'], 'an acted notification takes no second action')
})

test('refuses an action the notification does not offer before any port runs', async (t) => {
  const { ports, calls } = spyPorts()
  const f = await withNotifications(t, ['conn-a'], { ports })
  const id = f.ids[0]!
  // A threshold alert offers no resume_runs (only an exhausted alert does).
  assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'resume_runs', args: {} }, headers: actionHeaders(KEY) }), 409, 'action_not_offered')
  assert.deepEqual(calls, [])
})

test('the wire never carries prompts, free text or money intent, even when a host port exists', async (t) => {
  const { ports, calls } = spyPorts()
  const f = await withNotifications(t, ['conn-a'], { ports })
  const id = f.ids[0]!
  const hostile: unknown[] = [
    { action: 'add_prompt', args: { prompt: 'summarise my private notes' } },
    { action: 'choose_action', args: { choice: 'x', reason: 'because' } },
    { action: 'raise_budget', args: { capMicros: 1_000_000 } },
    { action: 'open', args: { url: 'https://example.invalid/?q=private' } },
    { action: 'open', args: { target: 'x' } },
    { action: 'accept_recommendation', args: { reason: 'free text' } },
    { action: 'accept_recommendation', args: { recommendation: 'drop table' } },
    { action: 'switch_connection', args: { connectionId: 'conn b with spaces and words' } },
    { action: 'switch_connection', args: { connectionId: 'conn-b', note: 'free text' } },
    { action: 'pause_runs', args: { runIds: [] } },
    { action: 'wake_leads', args: { prompt: 'wake up' } },
    { action: 'snooze', args: { untilMs: T0 + 1000, reason: 'later' } },
    { action: 'unknown', args: {} },
    { args: {} },
    { action: 'open', args: {}, accountId: 'other-account' },
  ]
  for (const [index, body] of hostile.entries()) {
    assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: body, headers: actionHeaders(`key-hostile-${String(index).padStart(3, '0')}`) }), 400, 'validation_failed')
  }
  assert.deepEqual(calls, [], 'no port ran')
  const rows = f.inbox()!.store.db.prepare('SELECT COUNT(*) AS n FROM notification_actions').get() as { n: number }
  assert.equal(rows.n, 0)
})

test('requires a well-formed idempotency key', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  for (const headers of [{}, actionHeaders('short'), actionHeaders('has spaces in it'), actionHeaders('x'.repeat(129))]) {
    assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'open', args: {} }, headers }), 400, 'idempotency_key_required')
  }
})

test('a key reused for another action conflicts and never reaches another account', async (t) => {
  const f = await withNotifications(t)
  const id = f.ids[0]!
  assert.equal((await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'open', args: {} }, headers: actionHeaders(KEY) })).status, 200)
  assertError(await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'snooze', args: { untilMs: T0 + 1000 } }, headers: actionHeaders(KEY) }), 409, 'idempotency_conflict')
  const [foreign] = f.inbox()!.ingest.ingestQuotaFact('other-account', quotaFact('conn-z', 19))
  assertError(await call(f.other, `/api/notifications/${foreign!.id}/actions`, { json: { action: 'open', args: {} }, headers: actionHeaders(KEY) }), 404, 'notification_not_found')
})

test('a failing port answers port_failed with no detail and the failure is replayed, not retried', async (t) => {
  const secret = 'SECRET-PROMPT-TEXT-12345'
  let attempts = 0
  const { ports } = spyPorts({ wakeLeads: async () => { attempts += 1; throw new Error(secret) } })
  const f = await withNotifications(t, ['conn-a'], { ports })
  const id = f.ids[0]!
  const failed = await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'wake_leads', args: {} }, headers: actionHeaders(KEY) })
  assertError(failed, 502, 'port_failed')
  assert.ok(!failed.text.includes(secret))
  const stored = f.inbox()!.store.db.prepare('SELECT status, result FROM notification_actions WHERE idempotency_key=?').get(KEY) as { status: string; result: string }
  assert.equal(stored.status, 'failed')
  assert.ok(!stored.result.includes(secret), 'the stored failure holds a code only')
  const replay = await call(f.app, `/api/notifications/${id}/actions`, { json: { action: 'wake_leads', args: {} }, headers: actionHeaders(KEY) })
  assert.equal(replay.status, 200)
  assert.deepEqual(notificationActionResponseSchema.parse(replay.json), { notificationId: id, action: 'wake_leads', status: 'failed', result: { code: 'port_failed' }, duplicate: true })
  assert.equal(attempts, 1, 'the same key never retries a failed effect')
  assert.equal(notificationSchema.parse((await call(f.app, `/api/notifications/${id}`)).json).state, 'unread', 'a failed action does not consume the notification')
})

test('port results cross the wire as flat scalars only', async (t) => {
  const { ports } = spyPorts({ wakeLeads: async () => ({ woken: 2, nested: { prompt: 'leak' }, list: ['leak'], token: 'x'.repeat(500), flag: true, none: null }) })
  const f = await withNotifications(t, ['conn-a'], { ports })
  const response = await call(f.app, `/api/notifications/${f.ids[0]}/actions`, { json: { action: 'wake_leads', args: {} }, headers: actionHeaders(KEY) })
  assert.equal(response.status, 200, response.text)
  const result = notificationActionResponseSchema.parse(response.json).result!
  assert.deepEqual(Object.keys(result).sort(), ['flag', 'none', 'token', 'woken'])
  assert.equal((result['token'] as string).length, 200)
  assert.ok(!response.text.includes('leak'))
})

test('guards: non-JSON, cross-origin, non-loopback, oversize and malformed bodies', async (t) => {
  const f = await withNotifications(t, ['conn-a'], { devOrigins: ['http://localhost:5173'] })
  const id = f.ids[0]!
  const post = `/api/notifications/${id}/read`
  assertError(await call(f.app, post, { raw: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'json_required')
  assertError(await call(f.app, post, { raw: '{}', headers: { 'content-type': 'application/jsonx' } }), 415, 'json_required')
  assertError(await call(f.app, post, { method: 'POST' }), 415, 'json_required')
  assertError(await call(f.app, post, { json: {}, origin: 'https://evil.example' }), 403, 'origin_denied')
  assertError(await call(f.app, post, { json: {}, origin: 'null' }), 403, 'origin_denied')
  assertError(await call(f.app, '/api/notifications', { origin: 'https://evil.example' }), 403, 'origin_denied')
  assertError(await call(f.app, post, { json: {}, peer: REMOTE_PEER }), 403, 'loopback_only')
  assertError(await call(f.app, '/api/notifications', { peer: REMOTE_PEER }), 403, 'loopback_only')
  assertError(await call(f.app, '/api/notifications', { peer: null }), 403, 'loopback_only')
  assertError(await call(f.app, post, { raw: '{not json' }), 400, 'validation_failed')
  assertError(await call(f.app, post, { raw: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 1) }) }), 413, 'body_too_large')
  assert.equal((await call(f.app, post, { json: {}, origin: 'http://localhost:5173' })).status, 200, 'a configured dev origin passes')
  assert.equal((await call(f.app, post, { json: {}, origin: 'http://localhost' })).status, 200, 'the request origin itself passes')
  assert.equal((await call(f.app, post, { json: {}, headers: { 'content-type': 'Application/JSON; charset=utf-8' } })).status, 200)
})

test('answers notifications_unavailable once the service is gone', async (t) => {
  const f = await withNotifications(t)
  await f.handles.notifications.dispose()
  assertError(await call(f.app, '/api/notifications'), 503, 'notifications_unavailable')
  assertError(await call(f.app, `/api/notifications/${f.ids[0]}/read`, { json: {} }), 503, 'notifications_unavailable')
})

test('every library failure code maps to a documented wire code', () => {
  const storeCodes = ['invalid_input', 'invalid_action', 'notification_not_found', 'account_mismatch', 'action_not_offered', 'action_not_found', 'action_in_progress', 'notification_acted', 'state_conflict', 'idempotency_conflict', 'stored_data_invalid'] as const
  const actionCodes = ['invalid_action', 'invalid_args', 'action_not_offered', 'notification_not_found', 'notification_acted', 'action_in_progress', 'account_mismatch', 'idempotency_conflict', 'action_not_found', 'port_failed', 'action_outcome_unknown'] as const
  const inboxCodes = ['not_configured', 'action_not_offered', 'invalid_snooze_time', 'validation_failed'] as const
  const failures = [
    ...storeCodes.map((code) => notificationFailure(new NotificationStoreError(code, 'quoted user content'))),
    ...actionCodes.map((code) => notificationFailure(new NotificationActionError(code, 'quoted user content'))),
    ...inboxCodes.map((code) => notificationFailure(new InboxError(code))),
    notificationFailure(new Error('quoted user content')),
    notificationFailure('not even an error'),
  ]
  for (const failure of failures) {
    assert.ok((NOTIFICATION_ERROR_CODES as readonly string[]).includes(failure.code), failure.code)
  }
  assert.equal(notificationFailure(new NotificationStoreError('account_mismatch', 'x')).code, 'notification_not_found', 'a foreign row is reported as missing')
  assert.equal(notificationFailure(new Error('x')).status, 500)
})

test('forecast and exhausted rows from the rule engine round-trip the contract', async (t) => {
  const f = await ms2Fixture(t)
  const ingest = f.inbox()!.ingest
  const iso = (ms: number) => new Date(ms).toISOString()
  const resetsAt = iso(T0 + 5 * 3_600_000)
  f.clock.now = T0
  ingest.ingestQuotaFact('local', quotaFact('c1', 80, { resetsAt, observedAt: iso(T0) }))
  f.clock.now = T0 + 30 * 60_000
  ingest.ingestQuotaFact('local', quotaFact('c1', 50, { resetsAt, observedAt: iso(f.clock.now) }))
  f.clock.now = T0 + 40 * 60_000
  ingest.ingestQuotaFact('local', quotaFact('c1', 0, { resetsAt, observedAt: iso(f.clock.now) }), { refusal: true })
  const page = listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications')).json)
  const kinds = page.notifications.map((row) => row.kind)
  assert.ok(kinds.includes('forecast'), kinds.join())
  assert.ok(kinds.includes('exhausted'), kinds.join())
  const forecast = page.notifications.find((row) => row.kind === 'forecast')!
  assert.equal(forecast.facts.forecast?.before, 'reset')
  assert.ok(page.notifications.find((row) => row.kind === 'exhausted')!.actions.includes('resume_runs'))
  for (const row of page.notifications) {
    assert.ok(row.facts.source.length > 0 && row.facts.observedAt.length > 0, 'provenance is on every row')
    const single = await call(f.app, `/api/notifications/${row.id}`)
    assert.deepEqual(notificationSchema.parse(single.json), row)
  }
})

test('the inbox itself refuses the three library-only actions even when a host port exists', async (t) => {
  const { ports, calls } = spyPorts()
  const f = await withNotifications(t, ['conn-a'], { ports })
  const id = f.ids[0]!
  for (const [index, action] of (['add_prompt', 'choose_action', 'raise_budget'] as const).entries()) {
    await assert.rejects(
      f.inbox()!.execute('local', id, action, { prompt: 'p', choice: 'c' }, `key-direct-${index}-0001`),
      { code: 'validation_failed' },
    )
  }
  assert.deepEqual(calls, [])
})
