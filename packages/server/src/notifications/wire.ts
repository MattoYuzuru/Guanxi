/** Maps stored notifications and failures to the `@guanxi/contract` wire shapes. */
import {
  notificationActionResponseSchema,
  notificationSchema,
  type NotificationActionResponse,
  type NotificationErrorCode,
  type NotificationWire,
} from '@guanxi/contract'
import { commonFailure, wire, type RouteFailure } from '../http/local-guard.ts'
import { NotificationActionError, type ActionExecution } from './actions.ts'
import { InboxError } from './inbox.ts'
import { NotificationStoreError, type StoredNotification } from './store.ts'

/** Account ids, idempotency keys and window instance keys stay on the node. */
export function toNotificationWire(row: StoredNotification): NotificationWire {
  return wire(notificationSchema, {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    subject: { type: row.subject.type, id: row.subject.id },
    facts: {
      window: row.facts.window,
      threshold: row.facts.threshold,
      remainingPercent: row.facts.remainingPercent,
      resetsAt: row.facts.resetsAt,
      source: row.facts.source,
      observedAt: row.facts.observedAt,
      confidence: row.facts.confidence,
      ...(row.facts.forecast === undefined ? {} : { forecast: row.facts.forecast }),
    },
    actions: row.actions,
    state: row.state,
    snoozedUntil: row.snoozedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

/** Keep flat scalars only: a port result can never smuggle nested or free-form content out. */
function scalarResult(result: unknown): Record<string, string | number | boolean | null> | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const flat: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(result)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') flat[key] = value
    else if (typeof value === 'string') flat[key] = value.slice(0, 200)
  }
  return flat
}

export function toActionResponse(execution: ActionExecution): NotificationActionResponse {
  return wire(notificationActionResponseSchema, {
    notificationId: execution.notificationId,
    action: execution.action,
    status: execution.status,
    result: scalarResult(execution.result),
    duplicate: execution.duplicate,
  })
}

const FAILURES: Record<string, RouteFailure> = {
  // Another account's id is indistinguishable from a missing one.
  notification_not_found: { code: 'notification_not_found', status: 404 },
  account_mismatch: { code: 'notification_not_found', status: 404 },
  action_not_found: { code: 'notification_not_found', status: 404 },
  action_not_offered: { code: 'action_not_offered', status: 409 },
  notification_acted: { code: 'notification_acted', status: 409 },
  action_in_progress: { code: 'action_in_progress', status: 409 },
  idempotency_conflict: { code: 'idempotency_conflict', status: 409 },
  action_outcome_unknown: { code: 'action_outcome_unknown', status: 409 },
  port_failed: { code: 'port_failed', status: 502 },
  not_configured: { code: 'not_configured', status: 501 },
  invalid_snooze_time: { code: 'invalid_snooze_time', status: 422 },
  invalid_args: { code: 'validation_failed', status: 400 },
  invalid_action: { code: 'validation_failed', status: 400 },
  invalid_input: { code: 'validation_failed', status: 400 },
  validation_failed: { code: 'validation_failed', status: 400 },
}

/** Codes only: no message, id, argument or port detail is ever copied into a response. */
export function notificationFailure(error: unknown): RouteFailure {
  const common = commonFailure(error)
  if (common !== null) return common
  if (error instanceof NotificationStoreError || error instanceof NotificationActionError || error instanceof InboxError) {
    return FAILURES[error.code] ?? { code: 'internal_error' satisfies NotificationErrorCode, status: 500 }
  }
  return { code: 'internal_error', status: 500 }
}
