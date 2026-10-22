/**
 * Delivery planning for ADR-0033 decision 8. The module is pure: the caller supplies `now`
 * and the user's IANA time zone; no clock, I/O, timer or process state is consulted.
 *
 * `in_app` is the durable inbox row, so it is always planned immediately and is never hidden
 * by quiet hours or muting. Only `os` and `push` can be deferred.
 */

export type Channel = 'in_app' | 'os' | 'push'

export interface DeliverySettings {
  /** IANA zone, e.g. `Europe/Moscow`; validated through `Intl.DateTimeFormat`. */
  timeZone: string
  /** Kind → channels. A missing kind falls back to `defaults`; `in_app` is always added. */
  channelsByKind: Partial<Record<string, Channel[]>>
  /** Channels used when `channelsByKind` has no entry for the notification kind. */
  defaults: Channel[]
  /** `HH:MM` local time. May wrap midnight. `start === end` means no quiet hours. */
  quietHours: { start: string; end: string } | null
  /** The user must opt in; critical notifications bypass quiet hours only when this is true. */
  criticalBypassesQuietHours: boolean
  /** Kinds that suppress `os` and `push`, leaving only the in-app inbox row. */
  mutedKinds: string[]
}

export type DeliveryReason = 'immediate' | 'deferred_quiet_hours' | 'critical_bypass'

export interface DeliveryDecision {
  channel: Channel
  /** Millisecond epoch. Immediate decisions use `now`; deferrals use the next local quiet end. */
  deliverAt: number
  reason: DeliveryReason
}

export interface DeliveryNotification {
  kind: string
  severity: 'info' | 'warning' | 'critical'
  /** Record creation time; validated here, while `now` is the planning anchor. */
  createdAt: number
}

const CHANNELS: readonly Channel[] = ['in_app', 'os', 'push']
const CHANNEL_SET: ReadonlySet<string> = new Set(CHANNELS)
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const MAX_QUIET_END_ATTEMPTS = 8

interface ClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function invalid(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateTimeZone(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path, 'expected an IANA time zone string')
  // Node's Intl also accepts offset strings such as `+03:00`; the settings contract is IANA.
  if (value.startsWith('+') || value.startsWith('-')) {
    invalid(path, `unknown IANA time zone ${JSON.stringify(value)}`)
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    invalid(path, `unknown IANA time zone ${JSON.stringify(value)}`)
  }
  return value
}

function validateChannels(value: unknown, path: string): Channel[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array of channels')
  return Array.from(value, (channel, index) => {
    if (typeof channel !== 'string' || !CHANNEL_SET.has(channel)) {
      invalid(`${path}[${index}]`, `unknown channel ${describe(channel)}`)
    }
    return channel as Channel
  })
}

function validateMutedKinds(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array of strings')
  return Array.from(value, (kind, index) => {
    if (typeof kind !== 'string') invalid(`${path}[${index}]`, 'expected a string')
    return kind
  })
}

function validateClock(value: unknown, path: string): string {
  if (typeof value !== 'string' || !CLOCK.test(value)) {
    invalid(path, 'expected HH:MM in 00:00–23:59')
  }
  return value
}

function validateQuietHours(value: unknown, path: string): DeliverySettings['quietHours'] {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) invalid(path, 'expected null or an object with start and end')
  return {
    start: validateClock(value.start, `${path}.start`),
    end: validateClock(value.end, `${path}.end`),
  }
}

/**
 * Runtime validation for settings loaded from disk or a route. Missing optional pieces take
 * their safe defaults (`channelsByKind: {}`, `quietHours: null`, bypass `false`,
 * `mutedKinds: []`); `timeZone` and `defaults` are required. Arrays keep their order and
 * duplicates; planning canonicalises and de-duplicates them.
 */
export function validateDeliverySettings(value: unknown): DeliverySettings {
  if (!isRecord(value)) invalid('deliverySettings', 'expected an object')

  const timeZone = validateTimeZone(value.timeZone, 'deliverySettings.timeZone')
  const defaults = validateChannels(value.defaults, 'deliverySettings.defaults')

  let channelsByKind: Partial<Record<string, Channel[]>> = {}
  if (value.channelsByKind !== undefined) {
    if (!isRecord(value.channelsByKind)) {
      invalid('deliverySettings.channelsByKind', 'expected an object')
    }
    channelsByKind = Object.fromEntries(
      Object.entries(value.channelsByKind).map(([kind, channels]) => [
        kind,
        validateChannels(channels, `deliverySettings.channelsByKind.${kind}`),
      ]),
    )
  }

  let criticalBypassesQuietHours = false
  if (value.criticalBypassesQuietHours !== undefined) {
    if (typeof value.criticalBypassesQuietHours !== 'boolean') {
      invalid('deliverySettings.criticalBypassesQuietHours', 'expected a boolean')
    }
    criticalBypassesQuietHours = value.criticalBypassesQuietHours
  }

  return {
    timeZone,
    channelsByKind,
    defaults,
    quietHours: validateQuietHours(value.quietHours, 'deliverySettings.quietHours'),
    criticalBypassesQuietHours,
    mutedKinds: value.mutedKinds === undefined
      ? []
      : validateMutedKinds(value.mutedKinds, 'deliverySettings.mutedKinds'),
  }
}

function validateNotification(value: unknown): DeliveryNotification {
  if (!isRecord(value)) invalid('notification', 'expected an object')
  if (typeof value.kind !== 'string') invalid('notification.kind', 'expected a string')
  if (value.severity !== 'info' && value.severity !== 'warning' && value.severity !== 'critical') {
    invalid('notification.severity', 'expected info, warning or critical')
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    invalid('notification.createdAt', 'expected a finite millisecond timestamp')
  }
  return { kind: value.kind, severity: value.severity, createdAt: value.createdAt }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

function localParts(formatter: Intl.DateTimeFormat, instant: number): ClockParts {
  const fields: Record<string, string> = {}
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

/** The wall time expressed as if it were UTC; subtracting an instant gives the zone offset. */
function wallTimeUtc(parts: ClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const wholeSecond = Math.floor(instant / 1000) * 1000
  return wallTimeUtc(localParts(formatter, wholeSecond)) - wholeSecond
}

function sameWallTime(left: ClockParts, right: ClockParts): boolean {
  return left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
}

/** First instant in (low, high] whose local wall time is at or after `targetUtc`. */
function firstWallTimeAtOrAfter(
  formatter: Intl.DateTimeFormat,
  targetUtc: number,
  low: number,
  high: number,
): number {
  let lo = low
  let hi = high
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000
    if (mid <= lo || mid >= hi) break
    if (wallTimeUtc(localParts(formatter, mid)) >= targetUtc) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Resolve a local wall time to an instant without a time-zone dependency. Around a DST
 * overlap, pick the earliest matching instant at or after `lowerBound`. A nonexistent wall
 * time (spring-forward gap) resolves to the transition instant at which the local clock
 * passes it, so quiet hours end at the first real local time after their end.
 */
function resolveWallTime(formatter: Intl.DateTimeFormat, target: ClockParts, lowerBound: number): number {
  const targetUtc = wallTimeUtc(target)
  const offsets = new Set<number>()
  for (let hours = -48; hours <= 48; hours += 12) {
    offsets.add(offsetAt(formatter, targetUtc + hours * 3_600_000))
  }
  for (const offset of [...offsets]) {
    offsets.add(offsetAt(formatter, targetUtc - offset))
  }
  const candidates = [...offsets].map(offset => targetUtc - offset)

  const matches = candidates.filter(candidate => sameWallTime(localParts(formatter, candidate), target))
  if (matches.length > 0) {
    const future = matches.filter(candidate => candidate >= lowerBound).sort((left, right) => left - right)
    const firstFuture = future[0]
    if (firstFuture !== undefined) return firstFuture
    return Math.max(...matches)
  }

  const decorated = candidates
    .map(candidate => ({ candidate, local: wallTimeUtc(localParts(formatter, candidate)) }))
    .sort((left, right) => left.candidate - right.candidate)
  const before = decorated.filter(item => item.local < targetUtc)
  const after = decorated.filter(item => item.local > targetUtc)

  for (const later of after) {
    const earlier = before.filter(item => item.candidate < later.candidate).at(-1)
    if (earlier === undefined) continue
    const transition = firstWallTimeAtOrAfter(formatter, targetUtc, earlier.candidate, later.candidate)
    if (transition >= lowerBound) return transition
  }

  const future = after.filter(item => item.candidate >= lowerBound)
  const firstFuture = future[0]
  if (firstFuture !== undefined) return firstFuture.candidate
  const firstAfter = after[0]
  if (firstAfter !== undefined) return firstAfter.candidate
  return Math.max(...candidates)
}

function clockMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
}

function inQuietHours(localNow: ClockParts, quietHours: DeliverySettings['quietHours']): boolean {
  if (quietHours === null) return false
  const start = clockMinutes(quietHours.start)
  const end = clockMinutes(quietHours.end)
  if (start === end) return false
  const current = localNow.hour * 60 + localNow.minute
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

/** The first local `end` strictly after `now`, including across midnight and DST changes. */
function nextQuietEnd(
  formatter: Intl.DateTimeFormat,
  now: number,
  localNow: ClockParts,
  quietHours: NonNullable<DeliverySettings['quietHours']>,
): number {
  const start = clockMinutes(quietHours.start)
  const end = clockMinutes(quietHours.end)
  const current = localNow.hour * 60 + localNow.minute
  const daysAhead = start < end ? 0 : (current >= start ? 1 : 0)
  const date = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + daysAhead))
  const target: ClockParts = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: Math.floor(end / 60),
    minute: end % 60,
    second: 0,
  }

  let instant = resolveWallTime(formatter, target, now)
  for (let attempt = 0; ; attempt += 1) {
    // A gap can resolve the end to the transition instant, which may itself be quiet again
    // (or another skipped day), so advance until the candidate is a real non-quiet instant.
    if (instant > now && !inQuietHours(localParts(formatter, instant), quietHours)) return instant
    if (attempt === MAX_QUIET_END_ATTEMPTS) {
      throw new Error(`quiet hours end was still quiet after ${MAX_QUIET_END_ATTEMPTS + 1} attempts`)
    }
    const nextDate = new Date(Date.UTC(target.year, target.month - 1, target.day + 1))
    target.year = nextDate.getUTCFullYear()
    target.month = nextDate.getUTCMonth() + 1
    target.day = nextDate.getUTCDate()
    instant = resolveWallTime(formatter, target, now)
  }
}

/**
 * Plan the channels and times for one notification. Decisions are ordered `in_app`, `os`,
 * `push`, regardless of the order in the settings. Equal input produces an equal array.
 */
export function planDelivery(
  notification: DeliveryNotification,
  settings: DeliverySettings,
  now: number,
): DeliveryDecision[] {
  const n = validateNotification(notification)
  const s = validateDeliverySettings(settings)
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('now: expected a finite millisecond timestamp')
  }

  const formatter = formatterFor(s.timeZone)
  const localNow = localParts(formatter, now)
  const quiet = inQuietHours(localNow, s.quietHours)
  const quietEnd = quiet && s.quietHours !== null
    ? nextQuietEnd(formatter, now, localNow, s.quietHours)
    : null

  const muted = s.mutedKinds.includes(n.kind)
  const configured = Object.hasOwn(s.channelsByKind, n.kind)
    ? s.channelsByKind[n.kind] ?? s.defaults
    : s.defaults
  const enabled = new Set<Channel>(configured)

  const decisions: DeliveryDecision[] = []
  for (const channel of CHANNELS) {
    if (channel !== 'in_app' && (muted || !enabled.has(channel))) continue

    if (channel === 'in_app' || !quiet) {
      decisions.push({ channel, deliverAt: now, reason: 'immediate' })
    } else if (n.severity === 'critical' && s.criticalBypassesQuietHours) {
      decisions.push({ channel, deliverAt: now, reason: 'critical_bypass' })
    } else {
      if (quietEnd === null) throw new Error('quiet hours end was not resolved')
      decisions.push({ channel, deliverAt: quietEnd, reason: 'deferred_quiet_hours' })
    }
  }
  return decisions
}
