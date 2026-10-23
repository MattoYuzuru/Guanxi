import { NOTIFICATION_WIRE_ACTIONS, type NotificationWire } from '@guanxi/contract'
import { formatDateTime } from '../../lib/format.ts'
import { getActiveLocale, translate as t, type LocaleKey } from '../../lib/locale.ts'
import type { Availability, AvailabilitySlice, Failure, InboxSnapshot, ListFilter, NotificationActionName } from './inbox-store.ts'

/** Shape, not colour, tells severities apart; each also has a text label. */
export const SEVERITY_GLYPH = { info: '●', warning: '◆', critical: '▲' } as const satisfies Record<NotificationWire['severity'], string>
export const SEVERITY_TONE = { info: 'text-info', warning: 'text-warning', critical: 'text-danger' } as const satisfies Record<NotificationWire['severity'], string>

/** Actions that have their own control instead of a generic button. */
export const OWN_CONTROL: ReadonlySet<NotificationActionName> = new Set<NotificationActionName>(['snooze'])

type PluralBase = 'notifications.count' | 'notifications.unread' | 'notifications.new'

/** Picks `.one/.few/.many/.other` for the active locale; English `few`/`many` read as plural. */
export function pluralText(base: PluralBase, count: number): string {
  const category = new Intl.PluralRules(getActiveLocale()).select(count)
  const form = category === 'one' || category === 'few' || category === 'many' ? category : 'other'
  return t(`${base}.${form}` as LocaleKey, { count })
}

/**
 * A percentage with at most one decimal. It does not use the shared `formatPercent`, which drops
 * the zero of a whole number ("10%" becomes "1%"); see the NC1-ui hand-off.
 */
export function percentText(value: number): string {
  return `${new Intl.NumberFormat(getActiveLocale(), { maximumFractionDigits: 1 }).format(value)}%`
}

export function windowLabel(window: NotificationWire['facts']['window']): string {
  return t(`notifications.window.${window}`)
}

export function notificationTitle(row: NotificationWire): string {
  const { facts } = row
  const window = windowLabel(facts.window)
  if (row.kind === 'exhausted') return t('notifications.title.exhausted', { window })
  if (row.kind === 'forecast' && facts.forecast) {
    return t('notifications.title.forecast', { window, time: formatDateTime(facts.forecast.exhaustsAt) })
  }
  const threshold = facts.threshold === null ? t('notifications.fact.unknown') : percentText(facts.threshold)
  // An unknown remaining amount is shown as unknown, never as 0.
  if (facts.remainingPercent === null) return t('notifications.title.thresholdUnknown', { window, threshold })
  return t('notifications.title.threshold', { window, remaining: percentText(facts.remainingPercent), threshold })
}

export function subjectLabel(subject: NotificationWire['subject']): string {
  return subject.type === 'connection'
    ? t('notifications.subject.connection', { id: subject.id })
    : t('notifications.subject.other', { type: subject.type, id: subject.id })
}

export function stateLabel(row: NotificationWire): string {
  return row.state === 'snoozed' && row.snoozedUntil !== null
    ? t('notifications.state.snoozedUntil', { time: formatDateTime(new Date(row.snoozedUntil).toISOString()) })
    : t(`notifications.state.${row.state}`)
}

export function failureText(failure: Failure): string {
  return t(`notifications.error.${failure.code}`)
}

export interface ActionStatus {
  enabled: boolean
  reason: { key: LocaleKey; values?: Record<string, string | number> } | null
}

/**
 * Why an action button is on or off. The order is the order of precedence: no connection to the
 * node, then what the row itself allows, then what the node reports it can run.
 */
export function actionStatus(input: {
  action: NotificationActionName
  row: NotificationWire
  availability: AvailabilitySlice
  offline: boolean
  busy: boolean
}): ActionStatus {
  const { action, row, availability, offline, busy } = input
  const name = t(`notifications.action.${action}`)
  const off = (key: LocaleKey, values?: Record<string, string | number>): ActionStatus => ({ enabled: false, reason: { key, ...(values ? { values } : {}) } })
  if (offline) return off('notifications.reason.offline')
  if (row.state === 'acted') return off('notifications.reason.acted')
  if (row.state === 'expired') return off('notifications.reason.expired')
  if (!availability.loaded) {
    return availability.failure
      ? off('notifications.reason.unchecked', { code: availability.failure.code })
      : off('notifications.reason.checking')
  }
  // Only the wire actions can be sent; anything else is shown as not exposed whatever the node says.
  if (!(NOTIFICATION_WIRE_ACTIONS as readonly string[]).includes(action)) return off('notifications.reason.not_exposed', { action: name })
  const known: Availability | undefined = availability.map[action]
  if (known === undefined) return off('notifications.reason.unknownAction', { action: name })
  if (known === 'not_configured') return off('notifications.reason.not_configured', { action: name })
  if (known === 'not_exposed') return off('notifications.reason.not_exposed', { action: name })
  if (busy) return off('notifications.reason.busy')
  return { enabled: true, reason: null }
}

export interface SnoozePreset {
  id: 'hour' | 'fourHours' | 'tomorrow' | 'reset'
  untilMs: number
}

export function snoozePresets(now: number, resetsAt: string | null): SnoozePreset[] {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const presets: SnoozePreset[] = [
    { id: 'hour', untilMs: now + 3_600_000 },
    { id: 'fourHours', untilMs: now + 4 * 3_600_000 },
    { id: 'tomorrow', untilMs: tomorrow.getTime() },
  ]
  const reset = resetsAt === null ? Number.NaN : Date.parse(resetsAt)
  if (Number.isFinite(reset) && reset > now) presets.push({ id: 'reset', untilMs: reset })
  return presets
}

/** `<input type="datetime-local">` value (local wall time) to epoch ms; NaN when incomplete. */
export const parseLocalDateTime = (value: string): number => (value === '' ? Number.NaN : new Date(value).getTime())

/**
 * Offline means a read of this node got no answer. The browser's own `onLine` flag is not used:
 * the node is on loopback and stays reachable with the network off.
 */
export function isOffline(snapshot: InboxSnapshot, filter: ListFilter): boolean {
  return snapshot.lists[filter].failure?.kind === 'offline' || snapshot.lists.unread.failure?.kind === 'offline'
}
