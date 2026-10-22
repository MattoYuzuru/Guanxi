import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NotificationStore,
  NotificationStoreError,
  notificationIdFor,
  type NotificationSubject,
} from '../../src/notifications/store.ts'
import { NotificationService } from '../../src/notifications/service.ts'
import type { Alert, QuotaFact, QuotaWindowKind, WindowState } from '../../src/notifications/types.ts'

const T0 = Date.parse('2026-10-21T00:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const subject: NotificationSubject = { type: 'connection', id: 'conn-1' }

async function tempStore(t: TestContext, clock: () => number = () => T0) {
  const directory = await mkdtemp(join(tmpdir(), 'nc1b-inbox-'))
  const path = join(directory, 'notifications.sqlite')
  const store = new NotificationStore(path, clock)
  t.after(() => {
    store.close()
    return rm(directory, { recursive: true, force: true })
  })
  return { store, path, directory }
}

function fact(overrides: Partial<QuotaFact> = {}): QuotaFact {
  return {
    connectionId: 'conn-1',
    window: 'five_hour',
    remainingPercent: 50,
    remainingAbsolute: null,
    resetsAt: null,
    source: 'claude-statusline',
    observedAt: at(0),
    confidence: 'observed',
    ...overrides,
  }
}

function windowState(overrides: Partial<WindowState> = {}): WindowState {
  return {
    connectionId: 'conn-1',
    window: 'five_hour',
    instanceKey: 'no-reset',
    fired: [],
    armedBelow: [],
    lastPercent: 50,
    lastObservedAt: at(0),
    forecastFired: false,
    exhaustedFired: false,
    ...overrides,
  }
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    kind: 'threshold',
    severity: 'info',
    connectionId: 'conn-1',
    window: 'five_hour',
    instanceKey: 'no-reset',
    threshold: 20,
    idempotencyKey: 'conn-1|five_hour|no-reset|threshold|20',
    facts: {
      remainingPercent: 19,
      resetsAt: null,
      source: 'claude-statusline',
      observedAt: at(0),
      confidence: 'observed',
    },
    ...overrides,
  }
}

test('migration v1 is idempotent when the sidecar database is reopened', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nc1b-migration-'))
  const path = join(directory, 'notifications.sqlite')
  const first = new NotificationStore(path, () => T0)
  first.recordEvaluation('acct-a', windowState(), [alert()], subject)
  first.close()

  const reopened = new NotificationStore(path, () => T0)
  t.after(() => {
    reopened.close()
    return rm(directory, { recursive: true, force: true })
  })

  assert.deepEqual(
    reopened.db.prepare('SELECT version FROM nc1_migrations ORDER BY version').all().map(row => Number(row.version)),
    [1],
  )
  assert.equal(String(reopened.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase(), 'wal')
  assert.equal(Number(reopened.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys), 1)
  assert.equal(
    reopened.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='notifications_account_state_created'",
    ).get()?.name,
    'notifications_account_state_created',
  )
  assert.equal(reopened.list('acct-a').length, 1)
  assert.deepEqual(reopened.windowState('conn-1', 'five_hour')?.fired, [])
  assert.equal(reopened.list('acct-a')[0]?.idempotencyKey, alert().idempotencyKey)
})

test('a failed open closes the sqlite handle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nc1b-bad-open-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'not-a-database.sqlite')
  await writeFile(path, 'this is not a sqlite database')
  const close = t.mock.method(DatabaseSync.prototype, 'close')

  assert.throws(() => new NotificationStore(path), /not a database/i)
  assert.equal(close.mock.callCount(), 1, 'the failed open must close its DatabaseSync')
})

test('state and notification writes roll back atomically on a duplicate notification id', async (t) => {
  const { store } = await tempStore(t)
  const before = windowState({ lastPercent: 50 })
  store.recordEvaluation('acct-a', before, [], subject)

  const pending = alert({ idempotencyKey: 'conn-1|five_hour|no-reset|threshold|10', threshold: 10 })
  const now = T0 + 1_000
  store.db.prepare(`
    INSERT INTO notifications(
      id, account_id, kind, severity, subject_type, subject_id, idempotency_key,
      facts, actions, state, snoozed_until, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'unread',NULL,?,?)
  `).run(
    notificationIdFor('acct-a', pending.idempotencyKey),
    'acct-a',
    'threshold',
    'warning',
    'connection',
    'conn-1',
    'planted-collision-key',
    JSON.stringify({ source: 'planted', observedAt: at(0), confidence: 'observed' }),
    '[]',
    now,
    now,
  )

  const after = windowState({ lastPercent: 4, fired: [20, 10] })
  assert.throws(
    () => store.recordEvaluation('acct-a', after, [pending], subject),
    /UNIQUE|constraint/i,
  )
  assert.deepEqual(store.windowState('conn-1', 'five_hour'), before, 'the window state must roll back')
  assert.equal(store.list('acct-a').length, 1, 'no partial notification row is visible')
})

test('recordEvaluation rejects a stale expected previous observation', async (t) => {
  const { store } = await tempStore(t)
  const first = windowState({ lastPercent: 50, lastObservedAt: at(0) })
  store.recordEvaluation('acct-a', first, [], subject)
  const fresh = windowState({ lastPercent: 40, lastObservedAt: at(1) })
  store.recordEvaluation('acct-a', fresh, [], subject)

  const staleCandidate = windowState({ lastPercent: 30, lastObservedAt: at(2) })
  assert.throws(
    () => store.recordEvaluation('acct-a', staleCandidate, [], subject, { expectedObservedAt: first.lastObservedAt }),
    (error: unknown) => error instanceof NotificationStoreError && error.code === 'state_conflict',
  )
  assert.deepEqual(store.windowState('conn-1', 'five_hour'), fresh)
})

test('ADR-0033 scenario through ingestion yields exactly three alerts then one after reset', async (t) => {
  let now = T0
  const { store } = await tempStore(t, () => now)
  const service = new NotificationService(store, { now: () => now })

  const percents = [100, 25, 19, 11, 9, 11, 9.5, 10.5, 8, 4, 3]
  const insertedCounts: number[] = []
  for (const [index, remainingPercent] of percents.entries()) {
    now = T0 + (index + 1) * 60_000
    insertedCounts.push(service.ingestQuotaFact('acct-a', fact({ remainingPercent, observedAt: at(index) })).length)
  }
  assert.equal(insertedCounts.reduce((total, count) => total + count, 0), 3)
  assert.equal(store.list('acct-a').length, 3)

  const resetAt = new Date(T0 + 12 * 60_000 + 5_000).toISOString()
  now = T0 + 12 * 60_000
  const reset = service.ingestQuotaFact('acct-a', fact({ remainingPercent: 100, resetsAt: resetAt, observedAt: at(11) }))
  assert.equal(reset.length, 0)
  now = T0 + 13 * 60_000
  const rearmed = service.ingestQuotaFact('acct-a', fact({ remainingPercent: 15, resetsAt: resetAt, observedAt: at(12) }))
  assert.equal(rearmed.length, 1)
  assert.equal(rearmed[0]?.facts.threshold, 20)

  const all = store.list('acct-a')
  assert.equal(all.length, 4)
  assert.deepEqual(all.map(item => item.facts.threshold), [20, 5, 10, 20])
  assert.ok(all.every(item => item.kind === 'threshold' && item.state === 'unread'))
  assert.ok(all.every(item => item.subject.type === 'connection' && item.subject.id === 'conn-1'))
  assert.deepEqual(all[0]?.actions, ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation'])
})

test('duplicate fact ingestion inserts nothing and preserves one notification', async (t) => {
  const { store } = await tempStore(t)
  const service = new NotificationService(store, { now: () => T0 + 60_000 })
  const input = fact({ remainingPercent: 19, observedAt: at(0) })

  const first = service.ingestQuotaFact('acct-a', input)
  assert.equal(first.length, 1)
  const second = service.ingestQuotaFact('acct-a', input)
  assert.deepEqual(second, [])
  assert.equal(store.list('acct-a').length, 1)
  assert.equal(
    Number(store.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE account_id=?').get('acct-a')?.count),
    1,
  )
})

test('every notification-id read and mutation is scoped to its account', async (t) => {
  const { store } = await tempStore(t)
  const service = new NotificationService(store, { now: () => T0 + 60_000 })
  const a = service.ingestQuotaFact('acct-a', fact({ remainingPercent: 19 }))[0]
  const b = service.ingestQuotaFact('acct-b', fact({ connectionId: 'conn-2', remainingPercent: 19 }))[0]
  if (!a || !b) assert.fail('fixtures did not insert')

  assert.throws(() => store.get('acct-b', a.id), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(() => store.markRead('acct-b', a.id), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(() => store.snooze('acct-b', a.id, T0 + 2_000), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(() => store.beginAction('acct-b', a.id, 'open', 'key-cross-account'), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(() => store.windowState('conn-1', 'five_hour', 'acct-b'), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(
    () => store.recordEvaluation('acct-b', windowState(), [], subject),
    (error: unknown) => error instanceof NotificationStoreError && error.code === 'account_mismatch',
  )
  assert.deepEqual(store.list('acct-b').map(item => item.id), [b.id])

  assert.equal(store.beginAction('acct-a', a.id, 'open', 'key-a'), 'started')
  assert.throws(() => store.actionRecord('acct-b', 'key-a'), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(() => store.finishAction('key-a', 'done', {}, 'acct-b'), (error: unknown) =>
    error instanceof NotificationStoreError && error.code === 'account_mismatch')
  assert.throws(
    () => store.finishAction('key-a', 'done', {}, undefined as unknown as string),
    (error: unknown) => error instanceof NotificationStoreError && error.code === 'invalid_input',
  )
})

test('another account cannot use a notification id as its pagination cursor', async (t) => {
  const { store } = await tempStore(t)
  const service = new NotificationService(store, { now: () => T0 + 60_000 })
  const a = service.ingestQuotaFact('acct-a', fact({ remainingPercent: 19 }))[0]
  const b = service.ingestQuotaFact('acct-b', fact({ connectionId: 'conn-2', remainingPercent: 19 }))[0]
  if (!a || !b) assert.fail('fixtures did not insert')

  assert.throws(
    () => store.list('acct-b', { before: a.id }),
    (error: unknown) => error instanceof NotificationStoreError && error.code === 'notification_not_found',
  )
  assert.throws(
    () => store.list('acct-b', { before: { createdAt: a.createdAt, id: a.id } }),
    (error: unknown) => error instanceof NotificationStoreError && error.code === 'notification_not_found',
  )
  assert.deepEqual(store.list('acct-b').map(item => item.id), [b.id])
})

test('snooze returns to unread only when its time passes', async (t) => {
  const { store } = await tempStore(t)
  const service = new NotificationService(store, { now: () => T0 + 60_000 })
  const item = service.ingestQuotaFact('acct-a', fact({ remainingPercent: 19 }))[0]
  if (!item) assert.fail('fixture did not insert')

  const until = T0 + 120_000
  const snoozed = store.snooze('acct-a', item.id, until)
  assert.equal(snoozed.state, 'snoozed')
  assert.equal(snoozed.snoozedUntil, until)
  assert.equal(store.expireSnoozed(until - 1), 0)
  assert.equal(store.get('acct-a', item.id).state, 'snoozed')
  assert.equal(store.expireSnoozed(until), 1)

  const expired = store.get('acct-a', item.id)
  assert.equal(expired.state, 'unread')
  assert.equal(expired.snoozedUntil, null)
  assert.equal(store.markRead('acct-a', item.id).state, 'read')
  assert.deepEqual(store.list('acct-a', { states: ['read'] }).map(entry => entry.id), [item.id])
})

test('list is newest first, pages with before, and filters by state', async (t) => {
  let now = T0
  const { store } = await tempStore(t, () => now)
  const windows: QuotaWindowKind[] = ['five_hour', 'seven_day', 'daily', 'monthly', 'balance']
  for (const [index, window] of windows.entries()) {
    now = T0 + (index + 1) * 10_000
    store.recordEvaluation('acct-a', windowState({ window, lastPercent: 19 }), [
      alert({
        window,
        threshold: 20,
        idempotencyKey: `conn-1|${window}|no-reset|threshold|20`,
        facts: { remainingPercent: 19, resetsAt: null, source: 'test', observedAt: at(index), confidence: 'observed' },
      }),
    ], subject)
  }

  const firstPage = store.list('acct-a', { limit: 2 })
  assert.deepEqual(firstPage.map(item => item.facts.window), ['balance', 'monthly'])
  const secondPage = store.list('acct-a', { limit: 2, before: firstPage[1]?.id })
  assert.deepEqual(secondPage.map(item => item.facts.window), ['daily', 'seven_day'])
  const lastPage = store.list('acct-a', { limit: 2, before: secondPage[1]?.id })
  assert.deepEqual(lastPage.map(item => item.facts.window), ['five_hour'])

  store.markRead('acct-a', firstPage[0]?.id ?? '')
  assert.deepEqual(store.list('acct-a', { states: ['unread'] }).length, 4)
  assert.deepEqual(store.list('acct-a', { states: ['read'] }).map(item => item.facts.window), ['balance'])
})

test('list pages rows sharing one timestamp with an id or composite cursor', async (t) => {
  const { store } = await tempStore(t)
  const alerts = [0, 1, 2].map(index => alert({
    idempotencyKey: `conn-1|five_hour|no-reset|threshold|${20 + index}`,
    threshold: 20 + index,
  }))
  store.recordEvaluation('acct-a', windowState(), alerts, subject)

  const firstPage = store.list('acct-a', { limit: 2 })
  const secondItem = firstPage[1]
  if (!secondItem) assert.fail('first page is short')
  const secondPage = store.list('acct-a', { limit: 2, before: secondItem.id })
  const compositePage = store.list('acct-a', {
    limit: 2,
    before: { createdAt: secondItem.createdAt, id: secondItem.id },
  })
  assert.equal(firstPage.length, 2)
  assert.equal(secondPage.length, 1)
  assert.deepEqual(compositePage.map(item => item.id), secondPage.map(item => item.id))
  assert.equal(new Set([...firstPage, ...secondPage].map(item => item.id)).size, 3)
})

test('list breaks same-timestamp ties by id so paging does not depend on rowid', async (t) => {
  const { store } = await tempStore(t)
  const insert = (id: string): void => {
    store.db.prepare(`
      INSERT INTO notifications(
        id, account_id, kind, severity, subject_type, subject_id, idempotency_key,
        facts, actions, state, snoozed_until, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'unread',NULL,?,?)
    `).run(
      id,
      'acct-a',
      'threshold',
      'warning',
      'connection',
      'conn-1',
      id,
      JSON.stringify({ window: 'five_hour', threshold: 20, instanceKey: 'no-reset', ...alert().facts }),
      JSON.stringify(['open']),
      T0,
      T0,
    )
  }
  // Insertion order (rowid) differs from id order, so a rowid tie-break would page differently.
  for (const id of ['ntf_bbb', 'ntf_aaa', 'ntf_ccc']) insert(id)

  const firstPage = store.list('acct-a', { limit: 2 })
  assert.deepEqual(firstPage.map(item => item.id), ['ntf_ccc', 'ntf_bbb'])
  const secondPage = store.list('acct-a', { limit: 2, before: firstPage[1]?.id })
  assert.deepEqual(secondPage.map(item => item.id), ['ntf_aaa'])
})

test('actions columns list exactly the actions offered by each quota alert kind', async (t) => {
  const { store } = await tempStore(t)
  const alerts: Alert[] = [
    alert({ kind: 'threshold', idempotencyKey: 'a|threshold' }),
    alert({ kind: 'forecast', threshold: null, idempotencyKey: 'a|forecast' }),
    alert({ kind: 'exhausted', severity: 'critical', threshold: null, idempotencyKey: 'a|exhausted' }),
  ]
  const inserted = store.recordEvaluation('acct-a', windowState(), alerts, subject)
  assert.equal(inserted.length, 3)

  const byKind = new Map(inserted.map(item => [item.kind, item.actions]))
  assert.deepEqual(byKind.get('threshold'), ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation'])
  assert.deepEqual(byKind.get('forecast'), ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation'])
  assert.deepEqual(byKind.get('exhausted'), ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation', 'resume_runs'])
})
