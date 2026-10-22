import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planDelivery, validateDeliverySettings } from '../../src/notifications/delivery.ts'
import type {
  DeliveryDecision,
  DeliveryNotification,
  DeliverySettings,
} from '../../src/notifications/delivery.ts'

const MOSCOW = 'Europe/Moscow'
const NEW_YORK = 'America/New_York'
const T0 = Date.parse('2026-10-21T20:30:00.000Z')
const at = (iso: string) => Date.parse(iso)

interface ClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localParts(instant: number, timeZone: string): ClockParts {
  const fields: Record<string, string> = {}
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  }
}

function localStamp(instant: number, timeZone: string): string {
  const parts = localParts(instant, timeZone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
}

/** Offset of the zone at an instant, in minutes. Used only to confirm DST transitions in tests. */
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = localParts(instant, timeZone)
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return (wall - Math.floor(instant / 1000) * 1000) / 60_000
}

/**
 * Independent expectation for a deferral: scan Intl's local clock forward to the first
 * occurrence of the requested `HH:MM`. This does not reuse the production resolution code.
 */
function nextLocalEnd(now: number, timeZone: string, end: string): number {
  const [hour, minute] = end.split(':').map(Number)
  let cursor = Math.ceil(now / 60_000) * 60_000
  if (cursor <= now) cursor += 60_000
  for (let step = 0; step < 2 * 24 * 60; step += 1) {
    const parts = localParts(cursor, timeZone)
    if (parts.hour === hour && parts.minute === minute) return cursor
    cursor += 60_000
  }
  throw new Error(`no local ${end} found within two days`)
}

/**
 * Independent quiet-hours predicate over Intl's local clock. Used to assert that a deferred
 * instant is not quiet, without reusing the production `inQuietHours`.
 */
function isQuiet(instant: number, timeZone: string, quietHours: { start: string; end: string }): boolean {
  const parts = localParts(instant, timeZone)
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
  const start = minutes(quietHours.start)
  const end = minutes(quietHours.end)
  if (start === end) return false
  const current = parts.hour * 60 + parts.minute
  return start < end ? current >= start && current < end : current >= start || current < end
}

/** Scan forward minute by minute for the first local instant outside quiet hours. */
function firstNonQuiet(
  now: number,
  timeZone: string,
  quietHours: { start: string; end: string },
): number {
  let cursor = Math.ceil(now / 60_000) * 60_000
  if (cursor <= now) cursor += 60_000
  for (let step = 0; step < 4 * 24 * 60; step += 1) {
    if (!isQuiet(cursor, timeZone, quietHours)) return cursor
    cursor += 60_000
  }
  throw new Error('no non-quiet instant found within four days')
}

function settings(overrides: Partial<DeliverySettings> = {}): DeliverySettings {
  return {
    timeZone: MOSCOW,
    channelsByKind: {},
    defaults: ['in_app', 'os', 'push'],
    quietHours: null,
    criticalBypassesQuietHours: false,
    mutedKinds: [],
    ...overrides,
  }
}

function note(overrides: Partial<DeliveryNotification> = {}): DeliveryNotification {
  return { kind: 'threshold', severity: 'info', createdAt: T0, ...overrides }
}

function planAt(
  now: number,
  overrides: Partial<DeliverySettings> = {},
  notificationOverrides: Partial<DeliveryNotification> = {},
): DeliveryDecision[] {
  return planDelivery(
    note({ createdAt: now, ...notificationOverrides }),
    settings(overrides),
    now,
  )
}

const channelsOf = (decisions: DeliveryDecision[]) => decisions.map(decision => decision.channel)
const reasonsOf = (decisions: DeliveryDecision[]) => decisions.map(decision => decision.reason)

test('in_app is always immediate and cannot be removed by the channel list', () => {
  const now = at('2026-10-21T20:30:00.000Z') // 23:30 in Moscow
  const decisions = planAt(now, {
    channelsByKind: { threshold: ['os'] },
    quietHours: { start: '22:00', end: '07:00' },
  })

  assert.deepEqual(decisions, [
    { channel: 'in_app', deliverAt: now, reason: 'immediate' },
    { channel: 'os', deliverAt: at('2026-10-22T04:00:00.000Z'), reason: 'deferred_quiet_hours' },
  ])
})

test('a muted kind gets only in_app, even for critical with bypass enabled', () => {
  const now = at('2026-10-21T20:30:00.000Z')
  const decisions = planAt(
    now,
    {
      quietHours: { start: '22:00', end: '07:00' },
      criticalBypassesQuietHours: true,
      mutedKinds: ['threshold'],
    },
    { severity: 'critical' },
  )

  assert.deepEqual(decisions, [{ channel: 'in_app', deliverAt: now, reason: 'immediate' }])
  assert.equal(decisions.length, 1)
})

test('per-kind channels replace defaults, de-duplicate and keep canonical order', () => {
  const now = at('2026-10-21T12:00:00.000Z')
  const overridden = planAt(now, {
    channelsByKind: { threshold: ['push', 'os', 'push', 'in_app'] },
  })
  assert.deepEqual(channelsOf(overridden), ['in_app', 'os', 'push'])
  assert.equal(overridden.length, 3, 'duplicates and input order must not affect decisions')
  assert.ok(overridden.every(decision => decision.deliverAt === now && decision.reason === 'immediate'))

  const fallback = planAt(now, { defaults: ['os', 'os'] }, { kind: 'forecast' })
  assert.deepEqual(channelsOf(fallback), ['in_app', 'os'])
  assert.equal(fallback.length, 2)

  const explicitEmpty = planAt(now, { channelsByKind: { threshold: [] } })
  assert.deepEqual(explicitEmpty, [{ channel: 'in_app', deliverAt: now, reason: 'immediate' }])
})

test('inherited object names do not shadow the defaults lookup', () => {
  const now = at('2026-10-21T12:00:00.000Z')
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const decisions = planAt(now, { defaults: ['os'] }, { kind })
    assert.deepEqual(channelsOf(decisions), ['in_app', 'os'], kind)
    assert.equal(decisions.length, 2, kind)
  }
})

test('non-wrapping quiet hours defer inside and release exactly at the end', () => {
  const quietHours = { start: '09:00', end: '17:00' }
  const end = at('2026-10-21T14:00:00.000Z') // 17:00 in Moscow

  const before = planAt(at('2026-10-21T05:59:00.000Z'), { quietHours })
  assert.deepEqual(reasonsOf(before), ['immediate', 'immediate', 'immediate'])

  const atStart = planAt(at('2026-10-21T06:00:00.000Z'), { quietHours }) // exactly 09:00
  assert.deepEqual(atStart, [
    { channel: 'in_app', deliverAt: at('2026-10-21T06:00:00.000Z'), reason: 'immediate' },
    { channel: 'os', deliverAt: end, reason: 'deferred_quiet_hours' },
    { channel: 'push', deliverAt: end, reason: 'deferred_quiet_hours' },
  ])

  const inside = planAt(at('2026-10-21T09:00:00.000Z'), { quietHours }) // 12:00
  assert.equal(inside[1]?.deliverAt, end)
  assert.equal(inside[2]?.deliverAt, end)

  const atEnd = planAt(end, { quietHours }) // exactly 17:00
  assert.deepEqual(reasonsOf(atEnd), ['immediate', 'immediate', 'immediate'])

  const after = planAt(end + 60_000, { quietHours })
  assert.deepEqual(reasonsOf(after), ['immediate', 'immediate', 'immediate'])
})

test('wrapping quiet hours defer across midnight and release exactly at the end', () => {
  const quietHours = { start: '22:00', end: '07:00' }
  const nextEnd = at('2026-10-22T04:00:00.000Z') // 07:00 in Moscow on the next local day

  const before = planAt(at('2026-10-21T18:59:00.000Z'), { quietHours }) // 21:59
  assert.deepEqual(reasonsOf(before), ['immediate', 'immediate', 'immediate'])

  const quietInstants = [
    '2026-10-21T19:00:00.000Z', // exactly 22:00, the start
    '2026-10-21T20:30:00.000Z', // 23:30
    '2026-10-21T21:00:00.000Z', // 00:00 on the next local day
    '2026-10-22T03:59:00.000Z', // 06:59
  ]
  for (const iso of quietInstants) {
    const decisions = planAt(at(iso), { quietHours })
    assert.deepEqual(decisions.slice(1), [
      { channel: 'os', deliverAt: nextEnd, reason: 'deferred_quiet_hours' },
      { channel: 'push', deliverAt: nextEnd, reason: 'deferred_quiet_hours' },
    ], iso)
  }

  const atEnd = planAt(nextEnd, { quietHours }) // exactly 07:00
  assert.deepEqual(reasonsOf(atEnd), ['immediate', 'immediate', 'immediate'])
  const after = planAt(nextEnd + 60_000, { quietHours })
  assert.deepEqual(reasonsOf(after), ['immediate', 'immediate', 'immediate'])
})

test('equal quiet-hour bounds mean no quiet hours', () => {
  const now = at('2026-10-21T20:30:00.000Z')
  for (const start of ['00:00', '07:00', '22:00', '23:59']) {
    const decisions = planAt(now, { quietHours: { start, end: start } })
    assert.deepEqual(reasonsOf(decisions), ['immediate', 'immediate', 'immediate'], start)
    assert.deepEqual(decisions.map(decision => decision.deliverAt), [now, now, now], start)
  }
})

test('the deferral is the next local 07:00 in Europe/Moscow', () => {
  const now = at('2026-10-21T20:30:00.000Z')
  const deferred = planAt(now, { quietHours: { start: '22:00', end: '07:00' } })
    .find(decision => decision.channel === 'os')
  assert.ok(deferred)

  assert.equal(localStamp(now, MOSCOW), '2026-10-21 23:30:00')
  assert.equal(deferred.deliverAt, at('2026-10-22T04:00:00.000Z'))
  assert.equal(localStamp(deferred.deliverAt, MOSCOW), '2026-10-22 07:00:00')
  assert.equal(nextLocalEnd(now, MOSCOW, '07:00'), deferred.deliverAt)
})

test('Intl confirms the 2026 New York DST transition dates used by these tests', () => {
  const beforeSpring = at('2026-03-08T06:59:00.000Z')
  const afterSpring = at('2026-03-08T07:00:00.000Z')
  assert.equal(localStamp(beforeSpring, NEW_YORK), '2026-03-08 01:59:00')
  assert.equal(localStamp(afterSpring, NEW_YORK), '2026-03-08 03:00:00')
  assert.equal(offsetMinutes(afterSpring, NEW_YORK) - offsetMinutes(beforeSpring, NEW_YORK), 60)

  const beforeFall = at('2026-11-01T05:59:00.000Z')
  const afterFall = at('2026-11-01T06:00:00.000Z')
  assert.equal(localStamp(beforeFall, NEW_YORK), '2026-11-01 01:59:00')
  assert.equal(localStamp(afterFall, NEW_YORK), '2026-11-01 01:00:00')
  assert.equal(offsetMinutes(afterFall, NEW_YORK) - offsetMinutes(beforeFall, NEW_YORK), -60)
})

test('spring forward: deferral is the local end after the 2026-03-08 transition', () => {
  const quietHours = { start: '22:00', end: '07:00' }
  const now = at('2026-03-08T04:30:00.000Z') // 23:30 on March 7, EST
  const decisions = planAt(now, { timeZone: NEW_YORK, quietHours })
  const deferred = decisions.find(decision => decision.channel === 'os')
  assert.ok(deferred)

  const expected = nextLocalEnd(now, NEW_YORK, '07:00')
  assert.equal(localStamp(now, NEW_YORK), '2026-03-07 23:30:00')
  assert.equal(deferred.deliverAt, expected)
  assert.equal(localStamp(expected, NEW_YORK), '2026-03-08 07:00:00')
  assert.equal(localStamp(expected - 1, NEW_YORK), '2026-03-08 06:59:59')
  assert.equal(offsetMinutes(expected, NEW_YORK) - offsetMinutes(now, NEW_YORK), 60)

  const insideAfterTransition = planAt(at('2026-03-08T07:30:00.000Z'), { timeZone: NEW_YORK, quietHours })
    .find(decision => decision.channel === 'os')
  assert.ok(insideAfterTransition)
  assert.equal(insideAfterTransition.deliverAt, expected)
  assert.equal(localStamp(at('2026-03-08T07:30:00.000Z'), NEW_YORK), '2026-03-08 03:30:00')
})

test('a quiet end inside the spring-forward gap ends at the transition instant', () => {
  const quietHours = { start: '23:00', end: '02:30' }
  const now = at('2026-03-08T06:30:00.000Z') // 01:30 EST
  const deferred = planAt(now, { timeZone: NEW_YORK, quietHours })
    .find(decision => decision.channel === 'os')
  assert.ok(deferred)

  // 02:30 never exists; the first real local time after it is 03:00 EDT.
  assert.equal(deferred.deliverAt, at('2026-03-08T07:00:00.000Z'))
  assert.equal(localStamp(deferred.deliverAt, NEW_YORK), '2026-03-08 03:00:00')
  assert.equal(localStamp(deferred.deliverAt - 1, NEW_YORK), '2026-03-08 01:59:59')
  assert.equal(offsetMinutes(deferred.deliverAt, NEW_YORK) - offsetMinutes(now, NEW_YORK), 60)
})

test('fall back: deferral is the local end after the 2026-11-01 transition', () => {
  const quietHours = { start: '22:00', end: '07:00' }
  const now = at('2026-11-01T03:30:00.000Z') // 23:30 on October 31, EDT
  const deferred = planAt(now, { timeZone: NEW_YORK, quietHours })
    .find(decision => decision.channel === 'os')
  assert.ok(deferred)

  const expected = nextLocalEnd(now, NEW_YORK, '07:00')
  assert.equal(localStamp(now, NEW_YORK), '2026-10-31 23:30:00')
  assert.equal(deferred.deliverAt, expected)
  assert.equal(localStamp(expected, NEW_YORK), '2026-11-01 07:00:00')
  assert.equal(localStamp(expected - 1, NEW_YORK), '2026-11-01 06:59:59')
  assert.equal(offsetMinutes(expected, NEW_YORK) - offsetMinutes(now, NEW_YORK), -60)

  const insideAfterFallback = planAt(at('2026-11-01T06:30:00.000Z'), { timeZone: NEW_YORK, quietHours })
    .find(decision => decision.channel === 'os')
  assert.ok(insideAfterFallback)
  assert.equal(insideAfterFallback.deliverAt, expected)
  assert.equal(localStamp(at('2026-11-01T06:30:00.000Z'), NEW_YORK), '2026-11-01 01:30:00')
})

test('an overlapped local end resolves to its next occurrence, not the past one', () => {
  const quietHours = { start: '00:30', end: '01:30' }
  const first = planAt(at('2026-11-01T05:15:00.000Z'), { timeZone: NEW_YORK, quietHours })
    .find(decision => decision.channel === 'os') // 01:15 EDT
  const second = planAt(at('2026-11-01T06:15:00.000Z'), { timeZone: NEW_YORK, quietHours })
    .find(decision => decision.channel === 'os') // 01:15 EST
  assert.ok(first)
  assert.ok(second)

  assert.equal(first.deliverAt, at('2026-11-01T05:30:00.000Z'))
  assert.equal(second.deliverAt, at('2026-11-01T06:30:00.000Z'))
  assert.equal(localStamp(first.deliverAt, NEW_YORK), '2026-11-01 01:30:00')
  assert.equal(localStamp(second.deliverAt, NEW_YORK), '2026-11-01 01:30:00')
  assert.ok(first.deliverAt < second.deliverAt)
})

test('a London quiet end in the spring gap does not land back inside quiet hours', () => {
  const timeZone = 'Europe/London'
  const quietHours = { start: '02:00', end: '01:30' } // 23.5-hour window
  const now = at('2026-03-28T12:00:00.000Z')
  const deferred = planAt(now, { timeZone, quietHours })
    .find(decision => decision.channel === 'os')
  assert.ok(deferred)

  // 01:30 on 2026-03-29 never exists; the transition lands on 02:00 BST, the quiet start.
  assert.equal(localStamp(now, timeZone), '2026-03-28 12:00:00')
  assert.equal(deferred.deliverAt, at('2026-03-30T00:30:00.000Z'))
  assert.equal(localStamp(deferred.deliverAt, timeZone), '2026-03-30 01:30:00')
  assert.equal(isQuiet(deferred.deliverAt, timeZone, quietHours), false)
  assert.equal(deferred.deliverAt, firstNonQuiet(now, timeZone, quietHours))
})

test('a skipped Apia day does not defer into quiet hours again', () => {
  const timeZone = 'Pacific/Apia'
  const quietHours = { start: '22:00', end: '07:00' }
  const now = at('2011-12-30T09:30:00.000Z') // 2011-12-29 23:30, before the skipped day
  const deferred = planAt(now, { timeZone, quietHours })
    .find(decision => decision.channel === 'os')
  assert.ok(deferred)

  // 2011-12-30 does not exist locally; 07:00 on it resolves to 2011-12-31 00:00, still quiet.
  assert.equal(localStamp(now, timeZone), '2011-12-29 23:30:00')
  assert.equal(deferred.deliverAt, at('2011-12-30T17:00:00.000Z'))
  assert.equal(localStamp(deferred.deliverAt, timeZone), '2011-12-31 07:00:00')
  assert.equal(isQuiet(deferred.deliverAt, timeZone, quietHours), false)
  assert.equal(deferred.deliverAt, firstNonQuiet(now, timeZone, quietHours))
})

test('critical bypasses quiet hours only when the user allows it', () => {
  const now = at('2026-10-21T20:30:00.000Z')
  const quietHours = { start: '22:00', end: '07:00' }

  const allowed = planAt(
    now,
    { quietHours, criticalBypassesQuietHours: true },
    { severity: 'critical' },
  )
  assert.deepEqual(allowed, [
    { channel: 'in_app', deliverAt: now, reason: 'immediate' },
    { channel: 'os', deliverAt: now, reason: 'critical_bypass' },
    { channel: 'push', deliverAt: now, reason: 'critical_bypass' },
  ])

  const disallowed = planAt(
    now,
    { quietHours, criticalBypassesQuietHours: false },
    { severity: 'critical' },
  )
  assert.deepEqual(reasonsOf(disallowed), ['immediate', 'deferred_quiet_hours', 'deferred_quiet_hours'])

  const warning = planAt(
    now,
    { quietHours, criticalBypassesQuietHours: true },
    { severity: 'warning' },
  )
  assert.deepEqual(reasonsOf(warning), ['immediate', 'deferred_quiet_hours', 'deferred_quiet_hours'])

  const outside = planAt(
    at('2026-10-21T12:00:00.000Z'),
    { quietHours, criticalBypassesQuietHours: true },
    { severity: 'critical' },
  )
  assert.deepEqual(reasonsOf(outside), ['immediate', 'immediate', 'immediate'])
})

test('validation fills safe defaults and preserves explicit settings', () => {
  const full = validateDeliverySettings({
    timeZone: 'UTC',
    defaults: ['in_app', 'os'],
    quietHours: { start: '22:00', end: '07:00' },
    channelsByKind: { threshold: ['push', 'push'] },
    criticalBypassesQuietHours: true,
    mutedKinds: ['bench'],
  })
  assert.deepEqual(full, {
    timeZone: 'UTC',
    defaults: ['in_app', 'os'],
    quietHours: { start: '22:00', end: '07:00' },
    channelsByKind: { threshold: ['push', 'push'] },
    criticalBypassesQuietHours: true,
    mutedKinds: ['bench'],
  })

  const minimal = validateDeliverySettings({ timeZone: 'UTC', defaults: [] })
  assert.deepEqual(minimal, {
    timeZone: 'UTC',
    defaults: [],
    quietHours: null,
    channelsByKind: {},
    criticalBypassesQuietHours: false,
    mutedKinds: [],
  })

  const equalBounds = validateDeliverySettings({
    timeZone: 'UTC',
    defaults: ['in_app'],
    quietHours: { start: '07:00', end: '07:00' },
  })
  assert.deepEqual(equalBounds.quietHours, { start: '07:00', end: '07:00' })
})

test('an explicit undefined channelsByKind entry means defaults, not a validation failure', () => {
  const partial: DeliverySettings = settings({
    channelsByKind: { threshold: undefined },
    defaults: ['in_app', 'os'],
  })

  const validated = validateDeliverySettings(partial)
  assert.deepEqual(validated.channelsByKind, {})
  assert.equal(Object.hasOwn(validated.channelsByKind, 'threshold'), false)
  assert.deepEqual(validated.defaults, ['in_app', 'os'])

  const now = at('2026-10-21T12:00:00.000Z')
  const decisions = planDelivery(note({ kind: 'threshold' }), partial, now)
  assert.deepEqual(channelsOf(decisions), ['in_app', 'os'])
  assert.deepEqual(reasonsOf(decisions), ['immediate', 'immediate'])
})

test('unknown IANA time zones are TypeErrors with a path', () => {
  for (const timeZone of ['Mars/Olympus', 'Not/AZone', '', '+03:00', '−03:00']) {
    assert.throws(
      () => validateDeliverySettings({ timeZone, defaults: ['in_app'] }),
      (error: unknown) => error instanceof TypeError && /deliverySettings\.timeZone/.test(error.message),
      timeZone,
    )
  }

  assert.throws(
    () => planDelivery(note(), { ...settings(), timeZone: 'Not/AZone' } as DeliverySettings, T0),
    (error: unknown) => error instanceof TypeError && /deliverySettings\.timeZone/.test(error.message),
  )
})

test('invalid HH:MM clock values are TypeErrors with a path', () => {
  const base = { timeZone: 'UTC', defaults: ['in_app'] }
  for (const start of ['7:00', '24:00', '09:60', '09:00:00', '', ' 09:00', '09:0']) {
    assert.throws(
      () => validateDeliverySettings({ ...base, quietHours: { start, end: '07:00' } }),
      (error: unknown) => error instanceof TypeError && /quietHours\.start/.test(error.message),
      start,
    )
  }
  assert.throws(
    () => validateDeliverySettings({ ...base, quietHours: { start: '22:00', end: '7:00' } }),
    (error: unknown) => error instanceof TypeError && /quietHours\.end/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({ ...base, quietHours: { start: '22:00' } }),
    (error: unknown) => error instanceof TypeError && /quietHours\.end/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({ ...base, quietHours: [] }),
    (error: unknown) => error instanceof TypeError && /quietHours/.test(error.message),
  )
})

test('unknown channels are TypeErrors with a path', () => {
  const base = { timeZone: 'UTC', defaults: ['in_app'] }
  for (const channels of [['email'], ['in_app', 'sms'], [42], ['IN_APP']]) {
    assert.throws(
      () => validateDeliverySettings({ ...base, defaults: channels }),
      (error: unknown) => error instanceof TypeError && /deliverySettings\.defaults/.test(error.message),
      String(channels),
    )
  }
  assert.throws(
    () => validateDeliverySettings({ ...base, channelsByKind: { threshold: ['telegram'] } }),
    (error: unknown) => error instanceof TypeError && /channelsByKind\.threshold/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({ ...base, defaults: 'in_app' }),
    (error: unknown) => error instanceof TypeError && /deliverySettings\.defaults/.test(error.message),
  )
})

test('malformed settings are TypeErrors and validation is pure', () => {
  for (const value of [null, undefined, 'settings', [], 42]) {
    assert.throws(
      () => validateDeliverySettings(value),
      (error: unknown) => error instanceof TypeError,
      String(value),
    )
  }

  assert.throws(
    () => validateDeliverySettings({ timeZone: 'UTC' }),
    (error: unknown) => error instanceof TypeError && /deliverySettings\.defaults/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({ timeZone: 'UTC', defaults: ['in_app'], channelsByKind: [] }),
    (error: unknown) => error instanceof TypeError && /channelsByKind/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({ timeZone: 'UTC', defaults: ['in_app'], mutedKinds: 'threshold' }),
    (error: unknown) => error instanceof TypeError && /mutedKinds/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({ timeZone: 'UTC', defaults: ['in_app'], mutedKinds: [1] }),
    (error: unknown) => error instanceof TypeError && /mutedKinds\[0\]/.test(error.message),
  )
  assert.throws(
    () => validateDeliverySettings({
      timeZone: 'UTC',
      defaults: ['in_app'],
      criticalBypassesQuietHours: 'yes',
    }),
    (error: unknown) => error instanceof TypeError && /criticalBypassesQuietHours/.test(error.message),
  )

  const input = {
    timeZone: 'UTC',
    defaults: ['in_app', 'os'],
    channelsByKind: { threshold: ['push'] },
    quietHours: { start: '22:00', end: '07:00' },
  }
  const snapshot = structuredClone(input)
  validateDeliverySettings(input)
  assert.deepEqual(input, snapshot)
})

test('planDelivery rejects malformed notifications and a non-finite now', () => {
  assert.throws(
    () => planDelivery(
      { kind: 'threshold', severity: 'notice' as never, createdAt: T0 },
      settings(),
      T0,
    ),
    (error: unknown) => error instanceof TypeError && /notification\.severity/.test(error.message),
  )
  assert.throws(
    () => planDelivery(
      { kind: 'threshold', severity: 'info', createdAt: Number.NaN },
      settings(),
      T0,
    ),
    (error: unknown) => error instanceof TypeError && /notification\.createdAt/.test(error.message),
  )
  assert.throws(
    () => planDelivery(note(), settings(), Number.NaN),
    (error: unknown) => error instanceof TypeError && /now/.test(error.message),
  )
  assert.throws(
    () => planDelivery(note(), {
      ...settings(),
      quietHours: { start: '25:00', end: '07:00' },
    } as DeliverySettings, T0),
    (error: unknown) => error instanceof TypeError && /quietHours\.start/.test(error.message),
  )
})

test('decisions are anchored to now, not the notification creation time', () => {
  const now = at('2026-10-21T20:30:00.000Z') // quiet hours in Moscow
  const quietSettings = { quietHours: { start: '22:00', end: '07:00' } }
  const current = planDelivery(note({ createdAt: now }), settings(quietSettings), now)
  const past = planDelivery(
    note({ createdAt: at('2026-10-20T10:00:00.000Z') }),
    settings(quietSettings),
    now,
  )
  const future = planDelivery(
    note({ createdAt: at('2026-10-23T10:00:00.000Z') }),
    settings(quietSettings),
    now,
  )

  assert.deepEqual(past, current)
  assert.deepEqual(future, current)
  assert.equal(current[1]?.deliverAt, at('2026-10-22T04:00:00.000Z'))
})

test('planning is deterministic, does not mutate inputs and never reads the wall clock', () => {
  const now = at('2026-03-08T04:30:00.000Z')
  const input = settings({
    timeZone: NEW_YORK,
    quietHours: { start: '22:00', end: '07:00' },
    channelsByKind: { threshold: ['push', 'os', 'os'] },
    criticalBypassesQuietHours: true,
  })
  const notification = note({ createdAt: now, severity: 'critical' })
  const settingsSnapshot = structuredClone(input)
  const notificationSnapshot = structuredClone(notification)
  const realNow = Date.now
  Date.now = () => {
    throw new Error('Date.now must not be called by planDelivery')
  }
  try {
    const first = planDelivery(notification, input, now)
    const second = planDelivery(notification, input, now)
    assert.deepEqual(first, second)

    planDelivery(notification, settings({ timeZone: MOSCOW }), now)
    assert.deepEqual(planDelivery(notification, input, now), first)

    assert.deepEqual(input, settingsSnapshot)
    assert.deepEqual(notification, notificationSnapshot)
  } finally {
    Date.now = realNow
  }
})
