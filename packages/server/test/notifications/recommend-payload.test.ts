import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recommend } from '../../src/notifications/recommend.ts'
import { osPayload } from '../../src/notifications/payload.ts'
import type { NotificationAction, NotificationState, StoredNotification } from '../../src/notifications/store.ts'
import type { Alert, QuotaFact } from '../../src/notifications/types.ts'

const T0 = Date.parse('2026-10-21T00:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function fact(overrides: Partial<QuotaFact> = {}): QuotaFact {
  return {
    connectionId: 'conn-1',
    window: 'five_hour',
    remainingPercent: 10,
    remainingAbsolute: null,
    resetsAt: at(120),
    source: 'claude-statusline',
    observedAt: at(0),
    confidence: 'observed',
    ...overrides,
  }
}

function forecastAlert(exhaustsAt: string, overrides: Partial<Alert> = {}): Alert {
  return {
    kind: 'forecast',
    severity: 'warning',
    connectionId: 'conn-1',
    window: 'five_hour',
    instanceKey: at(120),
    threshold: null,
    idempotencyKey: `conn-1|five_hour|${at(120)}|forecast|-`,
    facts: {
      remainingPercent: 10,
      resetsAt: at(120),
      source: 'claude-statusline',
      observedAt: at(0),
      confidence: 'observed',
    },
    forecast: { exhaustsAt, before: 'reset' },
    ...overrides,
  }
}

function notification(overrides: Partial<StoredNotification> = {}): StoredNotification {
  return {
    id: 'ntf_default',
    accountId: 'acct-a',
    kind: 'threshold',
    severity: 'warning',
    subject: { type: 'connection', id: 'conn-1' },
    idempotencyKey: 'conn-1|five_hour|no-reset|threshold|10',
    facts: {
      window: 'five_hour',
      threshold: 10,
      instanceKey: 'no-reset',
      remainingPercent: 10,
      resetsAt: null,
      source: 'claude-statusline',
      observedAt: at(0),
      confidence: 'observed',
    },
    actions: ['open', 'snooze'],
    state: 'unread',
    snoozedUntil: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

test('recommendations are deterministic, ordered and do not mutate the input', () => {
  const alerts = [forecastAlert(at(240))]
  const input = {
    fact: fact(),
    alerts,
    dependentLeads: 2,
    fallbacks: ['fallback-a', 'fallback-b'],
    resetsInMs: 120 * 60_000,
  }
  const snapshot = structuredClone(input)
  const first = recommend(input)
  const second = recommend(input)

  assert.deepEqual(first, second)
  assert.deepEqual(input, snapshot)
  assert.deepEqual(first, [
    { action: 'snooze', reason: 'Defer lead wakes until the window resets' },
    { action: 'switch_connection', reason: 'Switch to fallback-a for future steps' },
  ])
})

test('a reset sooner than projected exhaustion defers lead wakes', () => {
  const deferred = recommend({
    fact: fact({ resetsAt: at(120) }),
    alerts: [forecastAlert(at(240))],
    dependentLeads: 1,
    fallbacks: [],
    resetsInMs: 120 * 60_000,
  })
  assert.deepEqual(deferred, [{ action: 'snooze', reason: 'Defer lead wakes until the window resets' }])

  const noLeads = recommend({
    fact: fact({ resetsAt: at(120) }),
    alerts: [forecastAlert(at(240))],
    dependentLeads: 0,
    fallbacks: [],
    resetsInMs: 120 * 60_000,
  })
  assert.deepEqual(noLeads, [{ action: 'snooze', reason: 'Snooze until the window resets' }])

  const exhaustionFirst = recommend({
    fact: fact({ resetsAt: at(240) }),
    alerts: [forecastAlert(at(120))],
    dependentLeads: 2,
    fallbacks: [],
    resetsInMs: 240 * 60_000,
  })
  assert.deepEqual(exhaustionFirst, [{ action: 'snooze', reason: 'Snooze until the window resets' }])
})

test('a fallback recommends the first fallback connection', () => {
  const recommendations = recommend({
    fact: fact({ resetsAt: null }),
    alerts: [],
    dependentLeads: 0,
    fallbacks: ['fallback-a', 'fallback-b'],
    resetsInMs: null,
  })
  assert.deepEqual(recommendations, [
    { action: 'switch_connection', reason: 'Switch to fallback-a for future steps' },
  ])
})

test('snooze is offered until reset when a reset is known and omitted otherwise', () => {
  assert.deepEqual(
    recommend({ fact: fact(), alerts: [], dependentLeads: 0, fallbacks: [], resetsInMs: 120 * 60_000 }),
    [{ action: 'snooze', reason: 'Snooze until the window resets' }],
  )
  assert.deepEqual(
    recommend({ fact: fact({ resetsAt: null }), alerts: [], dependentLeads: 0, fallbacks: [], resetsInMs: null }),
    [],
  )

  const relativeReset = recommend({
    fact: fact({ resetsAt: null }),
    alerts: [forecastAlert(at(240))],
    dependentLeads: 1,
    fallbacks: [],
    resetsInMs: 120 * 60_000,
  })
  assert.deepEqual(relativeReset, [{ action: 'snooze', reason: 'Defer lead wakes until the window resets' }])

  const offsetless = recommend({
    fact: fact({ resetsAt: '2026-10-21T04:00:00', observedAt: '2026-10-21T00:00:00' }),
    alerts: [forecastAlert('2026-10-21T06:00:00')],
    dependentLeads: 1,
    fallbacks: [],
    resetsInMs: 240 * 60_000,
  })
  assert.deepEqual(offsetless, [{ action: 'snooze', reason: 'Defer lead wakes until the window resets' }],
    'offsetless ISO timestamps are interpreted as UTC')
})

test('recommendation validation rejects malformed rules input', () => {
  const valid = { fact: fact(), alerts: [], dependentLeads: 0, fallbacks: [], resetsInMs: null }
  assert.throws(() => recommend({ ...valid, dependentLeads: -1 }), TypeError)
  assert.throws(() => recommend({ ...valid, dependentLeads: 1.5 }), TypeError)
  assert.throws(() => recommend({ ...valid, fallbacks: [''] }), TypeError)
  assert.throws(() => recommend({ ...valid, resetsInMs: Number.NaN }), TypeError)
  assert.throws(() => recommend({ ...valid, fact: { ...valid.fact, observedAt: 'not-a-time' } }), TypeError)
  assert.throws(
    () => recommend({ ...valid, alerts: [forecastAlert('not-a-time')] }),
    TypeError,
  )
})

test('OS payload titles are fixed templates and expose only title and tag', () => {
  assert.deepEqual(osPayload(notification()), { title: 'Quota 10% left', tag: 'quota:five_hour' })

  const forecast = notification({
    kind: 'forecast',
    facts: { ...notification().facts, window: 'balance', threshold: null },
  })
  assert.deepEqual(osPayload(forecast), { title: 'Balance running out', tag: 'quota:balance' })

  const exhausted = notification({
    kind: 'exhausted',
    severity: 'critical',
    facts: { ...notification().facts, window: 'balance', threshold: null },
  })
  assert.deepEqual(osPayload(exhausted), { title: 'Balance exhausted', tag: 'quota:balance' })

  assert.deepEqual(Object.keys(osPayload(notification())).sort(), ['tag', 'title'])
})

test('OS payloads never contain subjects, facts, provenance, run ids or session content', () => {
  const secret = 'sk-live-SECRET-looking-value-42'
  const privatePayload = notification({
    id: secret,
    accountId: secret,
    subject: { type: secret, id: secret },
    idempotencyKey: secret,
    facts: {
      window: 'five_hour',
      threshold: 10,
      instanceKey: secret,
      remainingPercent: 87,
      resetsAt: secret,
      source: secret,
      observedAt: secret,
      confidence: 'observed',
      forecast: { exhaustsAt: secret, before: 'dependent_run_eta', runId: secret },
    },
    actions: [secret as NotificationAction],
    state: secret as NotificationState,
    snoozedUntil: 1,
    createdAt: 2,
    updatedAt: 3,
  })

  const payload = osPayload(privatePayload)
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('87'), false, 'the remaining-percent fact must not reach the payload')
  assert.equal(serialized.includes('runId'), false)
  assert.equal(serialized.includes('remainingPercent'), false)
  assert.equal(serialized.includes('observedAt'), false)
  assert.deepEqual(payload, { title: 'Quota 10% left', tag: 'quota:five_hour' })
})
