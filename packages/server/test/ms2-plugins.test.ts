import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createKernel } from '@guanxi/kernel'
import {
  listNotificationsResponseSchema,
  notificationActionResponseSchema,
} from '@guanxi/contract'
import { start } from '../src/index.ts'
import type { NotificationInbox } from '../src/notifications/inbox.ts'
import { NOTIFICATIONS_SERVICE, notificationsPlugin } from '../src/notifications/plugin.ts'
import { VOICE_SERVICE, voicePlugin, type VoiceGlossary } from '../src/voice/plugin.ts'
import type { WorkLedger } from '../src/work/ledger.ts'
import { WORK_SERVICE, workPlugin } from '../src/work/plugin.ts'
import { T0, call, ms2Fixture, quotaFact } from './ms2-fixture.ts'

const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout' || name === 'Immediate').length

test('each plugin opens its own private sidecar with its own migration table', async (t) => {
  const f = await ms2Fixture(t)
  const expectations = [
    [f.paths.notifications, f.inbox()!.store.db, 'nc1_migrations'],
    [f.paths.voice, f.glossary()!.store.db, 'v1_migrations'],
    [f.paths.work, f.ledger()!.store.db, 'wg1_migrations'],
  ] as const
  for (const [path, db, table] of expectations) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, `${path} is owner-only`)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!['n'], 1)
    assert.equal(db.prepare('PRAGMA journal_mode').get()!['journal_mode'], 'wal')
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!['foreign_keys'], 1)
  }
  assert.equal(new Set(expectations.map(([, db]) => db)).size, 3, 'three databases, not one shared handle')
})

test('loading starts no timer, interval or background effect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-ms2-load-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const kernel = createKernel()
  t.after(() => kernel.dispose())
  const baseline = { effects: kernel.counters().effects, services: kernel.counters().services }
  const before = timers()
  await kernel.plugin(notificationsPlugin, { databasePath: join(dir, 'notifications.sqlite') })
  await kernel.plugin(voicePlugin, { databasePath: join(dir, 'voice.sqlite') })
  await kernel.plugin(workPlugin, { databasePath: join(dir, 'work.sqlite') })
  const counters = kernel.counters()
  assert.equal(counters.effects - baseline.effects, 4, 'exactly the four close effects: one, two and one')
  assert.equal(counters.services - baseline.services, 3)
  assert.equal(counters.listeners, 0)
  assert.equal(counters.failed + counters.pending, 0)
  assert.equal(timers(), before, 'no timer resource appeared')
  // Idle for a moment: nothing writes, nothing fires.
  const inbox = kernel.service<NotificationInbox>(NOTIFICATIONS_SERVICE)!
  const rows = () => inbox.store.db.prepare('SELECT (SELECT COUNT(*) FROM notifications) + (SELECT COUNT(*) FROM quota_window_state) AS n').get()!['n']
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(rows(), 0)
})

test('unload closes every database and withdraws the service', async (t) => {
  const f = await ms2Fixture(t)
  const baseline = f.kernel.counters()
  const inbox = f.inbox()!, voice = f.glossary()!, ledger = f.ledger()!
  await f.handles.notifications.dispose()
  await f.handles.voice.dispose()
  await f.handles.work.dispose()
  assert.equal(f.kernel.service(NOTIFICATIONS_SERVICE), undefined)
  assert.equal(f.kernel.service(VOICE_SERVICE), undefined)
  assert.equal(f.kernel.service(WORK_SERVICE), undefined)
  assert.throws(() => inbox.store.db.prepare('SELECT 1').get(), /not open/i)
  assert.throws(() => voice.store.db.prepare('SELECT 1').get(), /not open/i)
  assert.throws(() => ledger.store.db.prepare('SELECT 1').get(), /not open/i)
  assert.throws(() => voice.store.list('local'), { code: 'store_closed' }, 'the glossary store refuses use after close')
  assert.equal(f.kernel.counters().effects, baseline.effects - 4)
  assert.equal(f.kernel.counters().services, baseline.services - 3)
  // The files are released: a second kernel opens them and sees committed data.
  const again = createKernel()
  t.after(() => again.dispose())
  await again.plugin(workPlugin, { databasePath: f.paths.work })
  assert.ok(again.service<WorkLedger>(WORK_SERVICE))
})

test('data survives unload and reload', async (t) => {
  const f = await ms2Fixture(t)
  f.inbox()!.ingest.ingestQuotaFact('local', quotaFact('conn-a', 19))
  assert.equal((await call(f.app, '/api/voice/glossary', { json: { id: 'hono', scope: 'account', entry: { canonical: 'Hono', variants: ['хоно'], language: 'en' } } })).status, 201)
  await call(f.app, '/api/work/projects/p1/revisions', { json: { items: [{ id: 'a', title: 'A' }] } })
  await call(f.app, '/api/work/projects/p1/mode', { method: 'PUT', json: { mode: 'project', reason: 'test' } })
  await f.handles.notifications.dispose(); await f.handles.voice.dispose(); await f.handles.work.dispose()
  assert.equal((await call(f.app, '/api/notifications')).status, 503)
  await f.kernel.plugin(notificationsPlugin, { databasePath: f.paths.notifications, now: () => f.clock.now })
  await f.kernel.plugin(voicePlugin, { databasePath: f.paths.voice, now: () => f.clock.now })
  await f.kernel.plugin(workPlugin, { databasePath: f.paths.work, now: () => f.clock.now })
  assert.equal(listNotificationsResponseSchema.parse((await call(f.app, '/api/notifications')).json).notifications.length, 1)
  assert.equal(((await call(f.app, '/api/voice/glossary')).json as { entries: unknown[] }).entries.length, 1)
  assert.equal(((await call(f.app, '/api/work/projects/p1/mode')).json as { mode: string }).mode, 'project')
  assert.equal(((await call(f.app, '/api/work/projects/p1/items')).json as { total: number }).total, 1)
})

test('a failed open leaves no plugin, service or handle behind', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-ms2-fail-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const blocker = join(dir, 'a-file')
  await writeFile(blocker, 'not a directory')
  const kernel = createKernel()
  t.after(() => kernel.dispose())
  for (const [plugin, name] of [[notificationsPlugin, 'notifications'], [voicePlugin, 'voice'], [workPlugin, 'work']] as const) {
    await assert.rejects(kernel.plugin(plugin as never, { databasePath: join(blocker, `${name}.sqlite`) } as never))
  }
  const counters = kernel.counters()
  assert.deepEqual([counters.fibers, counters.effects, counters.failed, counters.pending], [0, 0, 0, 0])
  assert.equal(kernel.service(NOTIFICATIONS_SERVICE), undefined)
})

test('a sidecar that is not a database fails the load cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-ms2-garbage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const kernel = createKernel()
  t.after(() => kernel.dispose())
  for (const [plugin, name] of [[notificationsPlugin, 'notifications'], [voicePlugin, 'voice'], [workPlugin, 'work']] as const) {
    const path = join(dir, `${name}.sqlite`)
    await writeFile(path, 'this is not a sqlite database, '.repeat(200))
    await assert.rejects(kernel.plugin(plugin as never, { databasePath: path } as never), (error: unknown) => error instanceof Error, name)
  }
  const counters = kernel.counters()
  assert.deepEqual([counters.fibers, counters.effects, counters.failed, counters.pending, counters.services], [0, 0, 0, 0, 1], 'only the kernel slots service remains')
})

test('after a crash, an unprobed host effect is never replayed; a built-in is', async (t) => {
  const calls: string[] = []
  const f = await ms2Fixture(t, { ports: { wakeLeads: async () => { calls.push('wake'); return { woken: 1 } } } })
  const store = f.inbox()!.store
  const [one, two] = ['conn-a', 'conn-b'].map((id) => f.inbox()!.ingest.ingestQuotaFact('local', quotaFact(id, 19))[0]!)
  // Simulate processes that died after reserving the key and before finishing.
  store.beginAction('local', one!.id, 'wake_leads', 'key-crashed-wake')
  store.beginAction('local', two!.id, 'open', 'key-crashed-open')
  const wake = await call(f.app, `/api/notifications/${one!.id}/actions`, { json: { action: 'wake_leads', args: {} }, headers: { 'idempotency-key': 'key-crashed-wake' } })
  assert.equal(wake.status, 409, wake.text)
  assert.deepEqual(wake.json, { code: 'action_outcome_unknown' })
  assert.deepEqual(calls, [], 'no probe means no second effect')
  const open = await call(f.app, `/api/notifications/${two!.id}/actions`, { json: { action: 'open', args: {} }, headers: { 'idempotency-key': 'key-crashed-open' } })
  assert.equal(notificationActionResponseSchema.parse(open.json).status, 'done', 'open has no effect outside the store, so replay is safe')
})

test('a host probe that says the effect happened completes the action without a second call', async (t) => {
  const calls: string[] = []
  const f = await ms2Fixture(t, { ports: {
    wakeLeads: async () => { calls.push('wake'); return { woken: 1 } },
    hasCompleted: (key) => key === 'key-already-done',
  } })
  const [row] = f.inbox()!.ingest.ingestQuotaFact('local', quotaFact('conn-a', 19))
  f.inbox()!.store.beginAction('local', row!.id, 'wake_leads', 'key-already-done')
  const response = await call(f.app, `/api/notifications/${row!.id}/actions`, { json: { action: 'wake_leads', args: {} }, headers: { 'idempotency-key': 'key-already-done' } })
  assert.deepEqual(notificationActionResponseSchema.parse(response.json), { notificationId: row!.id, action: 'wake_leads', status: 'done', result: { recovered: true }, duplicate: true })
  assert.deepEqual(calls, [])
})

test('start() boots all three plugins, mounts their routes and persists across a restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'guanxi-ms2-boot-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const boot = () => start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [] })
  const json = (url: string, init?: RequestInit) => fetch(url, init).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }))
  const post = (url: string, body: unknown, method = 'POST', headers: Record<string, string> = {}) =>
    json(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  let server = await boot()
  try {
    for (const name of ['notifications.sqlite', 'voice.sqlite', 'work.sqlite']) assert.ok((await stat(join(dataDir, name))).isFile(), name)
    const node = server.kernel.node
    for (const service of [NOTIFICATIONS_SERVICE, VOICE_SERVICE, WORK_SERVICE]) assert.ok(node.service(service), service)
    assert.deepEqual(await json(`${server.url}/api/notifications`), { status: 200, body: { notifications: [], nextCursor: null } })
    node.service<NotificationInbox>(NOTIFICATIONS_SERVICE)!.ingest.ingestQuotaFact('local', quotaFact('conn-boot', 19, { observedAt: new Date(T0).toISOString() }))
    const listed = await json(`${server.url}/api/notifications`)
    assert.equal((listed.body['notifications'] as unknown[]).length, 1, 'a kernel-side ingest is visible over HTTP')
    const created = await post(`${server.url}/api/voice/glossary`, { id: 'hono', scope: 'account', entry: { canonical: 'Hono', variants: ['хоно'], language: 'en' } })
    assert.equal(created.status, 201)
    assert.equal((await post(`${server.url}/api/work/projects/p1/mode`, { mode: 'project', reason: 'boot test' }, 'PUT')).status, 200)
    // The real listener enforces the shared guard and the Host boundary.
    assert.equal((await post(`${server.url}/api/voice/glossary`, {}, 'POST', { origin: 'https://evil.example' })).status, 403)
    const plain = await fetch(`${server.url}/api/voice/glossary`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(plain.status, 415)
    assert.deepEqual(await json(`${server.url}/api/work/nope`), { status: 404, body: { code: 'internal_error', message: 'API-маршрут не найден', details: null } }, 'unknown work paths fall to the API 404, not the SPA')
    const hosts = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ hostname: '127.0.0.1', port: server.port, path: '/api/notifications', headers: { Host: 'evil.example' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
        req.on('error', reject); req.end()
      }, reject)
    })
    assert.equal(hosts, 403, 'host_denied covers the new routes')
  } finally {
    await server.close()
  }

  server = await boot()
  try {
    assert.equal((await json(`${server.url}/api/notifications`)).body['notifications'] instanceof Array, true)
    assert.equal(((await json(`${server.url}/api/notifications`)).body['notifications'] as unknown[]).length, 1, 'the notification survived the restart')
    assert.equal(((await json(`${server.url}/api/voice/glossary`)).body['entries'] as unknown[]).length, 1)
    assert.equal((await json(`${server.url}/api/work/projects/p1/mode`)).body['mode'], 'project')
    const node = server.kernel.node
    await node.dispose()
    assert.equal((await json(`${server.url}/api/notifications`)).status, 503)
    assert.equal((await json(`${server.url}/api/voice/glossary`)).status, 503)
    assert.equal((await json(`${server.url}/api/work/projects/p1/mode`)).status, 503)
  } finally {
    await server.close().catch(() => undefined)
  }
})
