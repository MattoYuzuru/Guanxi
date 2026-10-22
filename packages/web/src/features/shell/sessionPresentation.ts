import type { SessionPageItem } from '@guanxi/contract'

// Machine discriminants stay explicit typed references; only their locale keys render them.
const SESSION_STATUS = {
  unknown: 'unknown',
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  sleeping: 'sleeping',
  finished: 'finished',
  error: 'error',
  stopped: 'stopped',
} as const
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS]

/** Durable observations describe their recorded state, never inferred process liveness. */
export function sessionStatus(session: SessionPageItem): SessionStatus {
  const observation = session.execution
  if (!observation) return SESSION_STATUS.unknown
  if (observation.state === 'input_required') return SESSION_STATUS.waiting
  if (observation.state === 'completed') return SESSION_STATUS.finished
  if (observation.state === 'failed' || observation.state === 'interrupted' || observation.state === 'rejected') return SESSION_STATUS.error
  if (observation.state === 'canceled') return SESSION_STATUS.stopped
  if (observation.attemptState === 'sleeping') return SESSION_STATUS.sleeping
  if (observation.state === 'submitted') return SESSION_STATUS.queued
  return SESSION_STATUS.running
}

const SESSION_DATE_GROUP = {
  today: 'today',
  yesterday: 'yesterday',
  earlier: 'earlier',
} as const
export type SessionDateGroup = (typeof SESSION_DATE_GROUP)[keyof typeof SESSION_DATE_GROUP]

export function sessionDateGroup(createdAt: string, now = new Date()): SessionDateGroup {
  const created = new Date(createdAt), yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const sameDay = (date: Date) => date.getFullYear() === created.getFullYear() && date.getMonth() === created.getMonth() && date.getDate() === created.getDate()
  return sameDay(now) ? SESSION_DATE_GROUP.today : sameDay(yesterday) ? SESSION_DATE_GROUP.yesterday : SESSION_DATE_GROUP.earlier
}
