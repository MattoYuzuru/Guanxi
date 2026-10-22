import type { SessionPageItem } from '@guanxi/contract'

export type SessionStatus = 'unknown' | 'queued' | 'running' | 'waiting' | 'sleeping' | 'finished' | 'error' | 'stopped'
/** Durable observations describe their recorded state, never inferred process liveness. */
export function sessionStatus(session: SessionPageItem): SessionStatus {
  const observation = session.execution
  if (!observation) return 'unknown'
  if (observation.state === 'input_required') return 'waiting'
  if (observation.state === 'completed') return 'finished'
  if (observation.state === 'failed' || observation.state === 'interrupted' || observation.state === 'rejected') return 'error'
  if (observation.state === 'canceled') return 'stopped'
  if (observation.attemptState === 'sleeping') return 'sleeping'
  if (observation.state === 'submitted') return 'queued'
  return 'running'
}

export type SessionDateGroup = 'today' | 'yesterday' | 'earlier'
export function sessionDateGroup(createdAt: string, now = new Date()): SessionDateGroup {
  const created = new Date(createdAt), yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const sameDay = (date: Date) => date.getFullYear() === created.getFullYear() && date.getMonth() === created.getMonth() && date.getDate() === created.getDate()
  return sameDay(now) ? 'today' : sameDay(yesterday) ? 'yesterday' : 'earlier'
}
