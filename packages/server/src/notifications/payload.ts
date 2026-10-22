import type { StoredNotification } from './store.ts'

export interface OsPayload {
  title: string
  tag: string
}

const WINDOWS = new Set(['five_hour', 'seven_day', 'daily', 'monthly', 'balance', 'rate_requests', 'rate_tokens'])

/**
 * Content-free OS notification payload. Only a fixed title and an enum-derived tag leave the
 * node: no subject id, fact value, source, timestamp, run id, prompt or session content.
 */
export function osPayload(notification: StoredNotification): OsPayload {
  const window = String(notification.facts.window)
  const isBalance = window === 'balance'
  const label = isBalance ? 'Balance' : 'Quota'
  const threshold = notification.facts.threshold
  const thresholdText = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 100
    ? String(threshold)
    : null

  let title: string
  switch (notification.kind) {
    case 'threshold':
      title = thresholdText === null ? `${label} running low` : `${label} ${thresholdText}% left`
      break
    case 'forecast':
      title = `${label} running out`
      break
    case 'exhausted':
      title = `${label} exhausted`
      break
    default:
      title = 'Notification'
      break
  }

  return {
    title,
    tag: WINDOWS.has(window) ? `quota:${window}` : 'quota',
  }
}
