import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { PRODUCT_NAME } from '@guanxi/contract'
import { DeliveryDispatcher } from '../../src/notifications/dispatcher.ts'
import type { DeliverySettings } from '../../src/notifications/delivery.ts'
import { NotificationInbox } from '../../src/notifications/inbox.ts'
import type { OsNotifier } from '../../src/notifications/os-adapter.ts'
import { osPayload } from '../../src/notifications/payload.ts'
import { NotificationService } from '../../src/notifications/service.ts'
import { NotificationStore, notificationIdFor } from '../../src/notifications/store.ts'
import type { QuotaFact } from '../../src/notifications/types.ts'
import { start } from '../../src/index.ts'
import { NOTIFICATIONS_SERVICE } from '../../src/notifications/plugin.ts'

const MOSCOW = 'Europe/Moscow'
/** 2026-10-21T12:00:00.000Z = 15:00 in Moscow, outside the quiet window below. */
const T0 = Date.parse('2026-10-21T12:00:00.000Z')
/** 2026-10-21T20:30:00.000Z = 23:30 in Moscow, inside 22:00–07:00. */
const QUIET_T0 = Date.parse('2026-10-21T20:30:00.000Z')

interface Call {
  title: string
  tag: string
}

interface RunnerCall {
  file: string
  args: string[]
  opts: { timeoutMs: number }
}

function settings(overrides: Partial<DeliverySettings> = {}): DeliverySettings {
  return {
    timeZone: MOSCOW,
    channelsByKind: {},
    defaults: ['in_app', 'os'],
    quietHours: null,
    criticalBypassesQuietHours: false,
    mutedKinds: [],
    ...overrides,
  }
}

function quotaFact(connectionId = 'conn-1', remainingPercent = 19, overrides: Partial<QuotaFact> = {}): QuotaFact {
  return {
    connectionId,
    window: 'five_hour',
    remainingPercent,
    remainingAbsolute: null,
    resetsAt: null,
    source: 'test',
    observedAt: new Date(T0).toISOString(),
    confidence: 'observed',
    ...overrides,
  }
}

function recordingNotifier(
  outcome: { delivered: boolean; code: string } | Error = { delivered: true, code: 'delivered' },
): { notifier: OsNotifier; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    notifier: {
      async notify(payload) {
        calls.push({ title: payload.title, tag: payload.tag })
        if (outcome instanceof Error) throw outcome
        return { ...outcome }
      },
    },
  }
}

interface DeliveryRow {
  notification_id: string
  channel: string
  deliver_at: number
  status: string
  code: string | null
  attempted_at: number | null
}

function deliveries(store: NotificationStore, notificationId?: string): DeliveryRow[] {
  const sql = notificationId === undefined
    ? 'SELECT * FROM notification_deliveries ORDER BY notification_id, channel'
    : 'SELECT * FROM notification_deliveries WHERE notification_id=? ORDER BY channel'
  return (notificationId === undefined
    ? store.db.prepare(sql).all()
    : store.db.prepare(sql).all(notificationId)) as unknown as DeliveryRow[]
}

function localClock(instant: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MOSCOW,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const fields: Record<string, string> = {}
  for (const part of parts) if (part.type !== 'literal') fields[part.type] = part.value
  return `${fields['hour']}:${fields['minute']}`
}

interface FixtureOptions {
  /** `false` leaves the inbox without a dispatcher, like a plugin with no delivery config. */
  delivery?: boolean
  settings?: DeliverySettings | ((accountId: string) => DeliverySettings)
  os?: OsNotifier | { unavailable: string }
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nc1f-dispatch-'))
  const clock = { now: T0 }
  const now = () => clock.now
  const store = new NotificationStore(join(directory, 'notifications.sqlite'), now)
  const service = new NotificationService(store, { now })
  const supplied = options.settings ?? settings()
  const dispatcher = options.delivery === false
    ? undefined
    : new DeliveryDispatcher(store, {
        now,
        settings: typeof supplied === 'function' ? supplied : () => supplied,
        ...(options.os === undefined ? {} : { os: options.os }),
      })
  const inbox = new NotificationInbox(store, service, {
    now,
    ...(dispatcher === undefined ? {} : { delivery: dispatcher }),
  })
  t.after(async () => {
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, clock, store, service, dispatcher, inbox }
}

test('opt-out writes no delivery rows and never calls an adapter', async (t) => {
  const f = await fixture(t, { delivery: false })
  const fake = recordingNotifier()

  const inserted = f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  assert.equal(inserted.length, 1)
  assert.equal(f.dispatcher, undefined)
  assert.deepEqual(await f.inbox.deliverDue(T0), { delivered: 0, failed: 0, unavailable: 0, pending: 0 })
  assert.equal(deliveries(f.store).length, 0)
  assert.equal(fake.calls.length, 0)
  assert.equal(f.inbox.ingest.store.list('acct-a').length, 1, 'the inbox row still exists')
})

test('opt-in records the OS plan and delivers each new notification once', async (t) => {
  const fake = recordingNotifier()
  const f = await fixture(t, { os: fake.notifier })

  const [inserted] = f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  if (!inserted) assert.fail('fixture did not insert')
  await f.inbox.deliverDue(T0)

  const rows = deliveries(f.store, inserted.id)
  assert.deepEqual(rows.map(row => row.channel), ['in_app', 'os'])
  assert.deepEqual(rows.map(row => row.status), ['delivered', 'delivered'])
  assert.deepEqual(fake.calls, [osPayload(inserted)])
  assert.equal(fake.calls[0]?.title, 'Quota 20% left')
  assert.equal(fake.calls[0]?.tag, 'quota:five_hour')

  // Re-ingesting the same fact inserts no notification and must not call the adapter again.
  assert.deepEqual(f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact()), [])
  await f.inbox.deliverDue(T0 + 1_000)
  assert.equal(fake.calls.length, 1)
  assert.equal(deliveries(f.store).filter(row => row.channel === 'os').length, 1)
})

test('push is recorded as not configured and is never attempted', async (t) => {
  const fake = recordingNotifier()
  const f = await fixture(t, {
    os: fake.notifier,
    settings: settings({ defaults: ['in_app', 'os', 'push'] }),
  })
  const [inserted] = f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  if (!inserted) assert.fail('fixture did not insert')
  await f.inbox.deliverDue(T0)

  assert.deepEqual(
    deliveries(f.store, inserted.id).map(row => [row.channel, row.status, row.code]),
    [
      ['in_app', 'delivered', 'in_app'],
      ['os', 'delivered', 'delivered'],
      ['push', 'unavailable', 'push_not_configured'],
    ],
  )
  await f.inbox.deliverDue(T0 + 60_000)
  assert.equal(fake.calls.length, 1)
  assert.equal(deliveries(f.store, inserted.id).find(row => row.channel === 'push')?.status, 'unavailable')
})

test('a muted kind keeps only the in-app delivery and records no OS row', async (t) => {
  const fake = recordingNotifier()
  const f = await fixture(t, { os: fake.notifier, settings: settings({ mutedKinds: ['threshold'] }) })

  const [inserted] = f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  if (!inserted) assert.fail('fixture did not insert')
  await f.inbox.deliverDue(T0)

  assert.deepEqual(deliveries(f.store, inserted.id).map(row => [row.channel, row.status]), [['in_app', 'delivered']])
  assert.equal(fake.calls.length, 0)
  assert.equal(f.inbox.ingest.store.list('acct-a').length, 1)
})

test('quiet hours leave an OS row pending until deliverDue reaches its planned time', async (t) => {
  const fake = recordingNotifier()
  const f = await fixture(t, {
    os: fake.notifier,
    settings: settings({ quietHours: { start: '22:00', end: '07:00' } }),
  })
  f.clock.now = QUIET_T0

  const [inserted] = f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  if (!inserted) assert.fail('fixture did not insert')
  await f.inbox.deliverDue(QUIET_T0)

  const [pending] = deliveries(f.store, inserted.id).filter(row => row.channel === 'os')
  if (!pending) assert.fail('no OS delivery row')
  assert.equal(pending.status, 'pending')
  assert.equal(pending.attempted_at, null)
  assert.ok(pending.deliver_at > QUIET_T0)
  assert.equal(localClock(pending.deliver_at), '07:00')
  assert.equal(fake.calls.length, 0)

  assert.equal((await f.inbox.deliverDue(pending.deliver_at - 1)).delivered, 0)
  assert.equal(fake.calls.length, 0, 'a row before its planned time is not attempted')

  f.clock.now = pending.deliver_at
  const [first, second] = await Promise.all([
    f.inbox.deliverDue(pending.deliver_at),
    f.inbox.deliverDue(pending.deliver_at),
  ])
  assert.equal(first.delivered + second.delivered, 1, 'one of two concurrent calls wins')
  assert.equal(fake.calls.length, 1)
  assert.deepEqual(deliveries(f.store, inserted.id).map(row => [row.channel, row.status]), [
    ['in_app', 'delivered'],
    ['os', 'delivered'],
  ])

  assert.deepEqual(await f.inbox.deliverDue(pending.deliver_at + 60_000), {
    delivered: 0,
    failed: 0,
    unavailable: 0,
    pending: 0,
  })
  assert.equal(fake.calls.length, 1, 'the second deliverDue is a no-op')
})

test('critical bypasses quiet hours only when the settings allow it', async (t) => {
  const bypassed = recordingNotifier()
  const allowed = await fixture(t, {
    os: bypassed.notifier,
    settings: settings({
      quietHours: { start: '22:00', end: '07:00' },
      criticalBypassesQuietHours: true,
    }),
  })
  allowed.clock.now = QUIET_T0
  allowed.inbox.ingest.ingestQuotaFact('acct-a', quotaFact('conn-bypass', 50), { refusal: true })
  await allowed.inbox.deliverDue(QUIET_T0)
  const [critical] = deliveries(allowed.store)
  assert.equal(critical?.channel, 'in_app')
  const osRow = deliveries(allowed.store).find(row => row.channel === 'os')
  assert.equal(osRow?.status, 'delivered')
  assert.equal(osRow?.deliver_at, QUIET_T0)
  assert.equal(bypassed.calls.length, 1)

  const held = recordingNotifier()
  const denied = await fixture(t, {
    os: held.notifier,
    settings: settings({ quietHours: { start: '22:00', end: '07:00' } }),
  })
  denied.clock.now = QUIET_T0
  denied.inbox.ingest.ingestQuotaFact('acct-a', quotaFact('conn-hold', 50), { refusal: true })
  await denied.inbox.deliverDue(QUIET_T0)
  const heldRow = deliveries(denied.store).find(row => row.channel === 'os')
  assert.equal(heldRow?.status, 'pending')
  assert.ok((heldRow?.deliver_at ?? 0) > QUIET_T0)
  assert.equal(held.calls.length, 0)
})

test('an adapter failure is terminal and is not retried', async (t) => {
  const fake = recordingNotifier({ delivered: false, code: 'os_notify_failed' })
  const f = await fixture(t, { os: fake.notifier })
  f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  await f.inbox.deliverDue(T0)

  const osRow = deliveries(f.store).find(row => row.channel === 'os')
  assert.equal(osRow?.status, 'failed')
  assert.equal(osRow?.code, 'os_notify_failed')
  assert.ok(osRow?.attempted_at !== null)
  assert.equal(fake.calls.length, 1)

  assert.deepEqual(await f.inbox.deliverDue(T0 + 3_600_000), {
    delivered: 0,
    failed: 0,
    unavailable: 0,
    pending: 0,
  })
  assert.equal(fake.calls.length, 1, 'a failed row stays terminal')
  assert.equal(deliveries(f.store).find(row => row.channel === 'os')?.status, 'failed')
})

test('a throwing adapter becomes a failed row without surfacing its message', async (t) => {
  const fake = recordingNotifier(new Error('provider said: quota 4% on conn-secret'))
  const f = await fixture(t, { os: fake.notifier })
  f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  await f.inbox.deliverDue(T0)

  const osRow = deliveries(f.store).find(row => row.channel === 'os')
  assert.equal(osRow?.status, 'failed')
  assert.equal(osRow?.code, 'os_notify_failed')
  assert.equal(JSON.stringify(osRow).includes('conn-secret'), false)
  assert.equal(fake.calls.length, 1)
})

test('an unavailable adapter records its reason without attempting delivery', async (t) => {
  const fake = recordingNotifier()
  const f = await fixture(t, { os: { unavailable: 'platform_unsupported' } })
  f.inbox.ingest.ingestQuotaFact('acct-a', quotaFact())
  await f.inbox.deliverDue(T0)

  const osRow = deliveries(f.store).find(row => row.channel === 'os')
  assert.equal(osRow?.status, 'unavailable')
  assert.equal(osRow?.code, 'platform_unsupported')
  assert.equal(fake.calls.length, 0)

  const missing = await fixture(t)
  missing.inbox.ingest.ingestQuotaFact('acct-a', quotaFact('conn-missing'))
  await missing.inbox.deliverDue(T0)
  const missingRow = deliveries(missing.store).find(row => row.channel === 'os')
  assert.equal(missingRow?.status, 'unavailable')
  assert.equal(missingRow?.code, 'os_not_configured')
})

test('migration v2 applies to an existing v1 database without touching v1 rows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nc1f-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'notifications.sqlite')

  // The exact v1 schema created by the old code path. v1 is append-only and never rewritten.
  const v1 = `
    CREATE TABLE nc1_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE quota_window_state(
      connection_id TEXT NOT NULL,
      window TEXT NOT NULL,
      account_id TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY(connection_id, window)
    );
    CREATE TABLE notifications(
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      facts TEXT NOT NULL,
      actions TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('unread','read','acted','snoozed','expired')),
      snoozed_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX notifications_account_state_created
      ON notifications(account_id, state, created_at);
    CREATE TABLE notification_actions(
      notification_id TEXT NOT NULL REFERENCES notifications(id),
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('started','done','failed')),
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO nc1_migrations VALUES(1);
  `
  const original = new DatabaseSync(path)
  original.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`)
  original.exec(v1)
  const facts = JSON.stringify({
    window: 'five_hour',
    threshold: 20,
    instanceKey: 'no-reset',
    remainingPercent: 19,
    resetsAt: null,
    source: 'old-test',
    observedAt: new Date(T0).toISOString(),
    confidence: 'observed',
  })
  original.prepare(`
    INSERT INTO quota_window_state(connection_id, window, account_id, state)
    VALUES('conn-v1','five_hour','acct-a','{"connectionId":"conn-v1"}')
  `).run()
  original.prepare(`
    INSERT INTO notifications(
      id, account_id, kind, severity, subject_type, subject_id, idempotency_key,
      facts, actions, state, snoozed_until, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'unread',NULL,?,?)
  `).run(
    notificationIdFor('acct-a', 'old-key'),
    'acct-a',
    'threshold',
    'info',
    'connection',
    'conn-v1',
    'old-key',
    facts,
    JSON.stringify(['open']),
    T0,
    T0,
  )
  original.prepare(`
    INSERT INTO notification_actions(notification_id, action, idempotency_key, status, result, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(notificationIdFor('acct-a', 'old-key'), 'open', 'old-action', 'done', '{"acknowledged":true}', T0, T0)
  const snapshot = {
    window: original.prepare('SELECT * FROM quota_window_state').all(),
    notifications: original.prepare('SELECT * FROM notifications').all(),
    actions: original.prepare('SELECT * FROM notification_actions').all(),
  }
  original.close()

  const reopened = new NotificationStore(path, () => T0)
  t.after(() => reopened.close())

  assert.deepEqual(
    reopened.db.prepare('SELECT version FROM nc1_migrations ORDER BY version').all().map(row => Number(row.version)),
    [1, 2],
  )
  assert.deepEqual(reopened.db.prepare('SELECT * FROM quota_window_state').all(), snapshot.window)
  assert.deepEqual(reopened.db.prepare('SELECT * FROM notifications').all(), snapshot.notifications)
  assert.deepEqual(reopened.db.prepare('SELECT * FROM notification_actions').all(), snapshot.actions)
  assert.deepEqual(
    reopened.db.prepare('PRAGMA table_info(notification_deliveries)').all().map(row => String(row.name)),
    ['notification_id', 'channel', 'deliver_at', 'status', 'code', 'attempted_at'],
  )
  assert.deepEqual(
    reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_deliveries'").all()
      .map(row => String(row.name)),
    ['notification_deliveries'],
  )

  const insert = reopened.db.prepare(`
    INSERT INTO notification_deliveries(notification_id, channel, deliver_at, status, code, attempted_at)
    VALUES(?,?,?,?,?,?)
  `)
  const id = notificationIdFor('acct-a', 'old-key')
  insert.run(id, 'os', T0, 'pending', null, null)
  assert.throws(() => insert.run(id, 'os', T0, 'pending', null, null), /UNIQUE|constraint/i)
  assert.throws(() => insert.run(id, 'push', T0, 'queued', null, null), /CHECK|constraint/i)
})

test('start() opts into OS delivery only when notificationDelivery.os is true', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nc1f-boot-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const runnerCalls: RunnerCall[] = []
  const runner = {
    async run(file: string, args: string[], opts: { timeoutMs: number }) {
      runnerCalls.push({ file, args: [...args], opts: { ...opts } })
      return { code: 0, signal: null }
    },
  }
  const boot = (delivery?: { os: boolean }) => start({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: dataDir,
    devOrigins: [],
    ...(delivery === undefined ? {} : {
      notificationDelivery: { ...delivery, platform: 'darwin' as const, runner },
    }),
  })
  const countDeliveries = (inbox: NotificationInbox): number =>
    Number(inbox.store.db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').get()?.n ?? 0)

  const optedOut = await boot()
  try {
    const inbox = optedOut.kernel.node.service<NotificationInbox>(NOTIFICATIONS_SERVICE)
    assert.ok(inbox)
    inbox.ingest.ingestQuotaFact('local', quotaFact('conn-off', 19))
    await inbox.deliverDue(T0)
    assert.equal(countDeliveries(inbox), 0)
    assert.equal(runnerCalls.length, 0)
  } finally {
    await optedOut.close()
  }

  const optedIn = await boot({ os: true })
  try {
    const inbox = optedIn.kernel.node.service<NotificationInbox>(NOTIFICATIONS_SERVICE)
    assert.ok(inbox)
    inbox.ingest.ingestQuotaFact('local', quotaFact('conn-on', 19))
    await inbox.deliverDue(Date.now())
    assert.equal(countDeliveries(inbox), 2, 'one in-app and one OS row')
    assert.equal(runnerCalls.length, 1, 'the injected runner handled the only notification')
    assert.equal(runnerCalls[0]?.file, '/usr/bin/osascript')
    assert.equal(runnerCalls[0]?.args.at(-2), 'Quota 20% left')
    assert.equal(runnerCalls[0]?.args.at(-1), PRODUCT_NAME)
    const status = inbox.store.db.prepare(
      "SELECT status FROM notification_deliveries WHERE channel='os'",
    ).get()?.status
    assert.equal(status, 'delivered')
  } finally {
    await optedIn.close()
  }
})
