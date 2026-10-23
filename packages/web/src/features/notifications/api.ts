import {
  NOTIFICATION_IDEMPOTENCY_HEADER,
  listNotificationsResponseSchema,
  notificationActionResponseSchema,
  notificationActionsResponseSchema,
  notificationErrorSchema,
  notificationIdSchema,
  notificationIdempotencyKeySchema,
  notificationSchema,
  executeNotificationActionBodySchema,
  snoozeNotificationBodySchema,
  type ExecuteNotificationActionBody,
  type NotificationErrorCode,
  type NotificationWire,
} from '@guanxi/contract'
import { LocalApiError, localRequest } from '../../lib/local-api.ts'

const BASE = '/api/notifications'
const call = <S extends Parameters<typeof localRequest>[1]>(path: string, schema: S, init?: Parameters<typeof localRequest>[3]) =>
  localRequest(`${BASE}${path}`, schema, notificationErrorSchema, init)

export type NotificationRequestError = LocalApiError<NotificationErrorCode>

export interface ListNotificationsParams {
  states?: ReadonlyArray<NotificationWire['state']>
  limit?: number
  /** A `nextCursor` from the previous page. */
  before?: string
}

const id = (value: string) => encodeURIComponent(notificationIdSchema.parse(value))

/**
 * A fresh key for one user intent; reuse it only to retry that same intent. It uses
 * `getRandomValues`, which exists outside secure contexts too (a LAN address over plain HTTP has
 * no `randomUUID`).
 */
export function newIdempotencyKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return notificationIdempotencyKeySchema.parse(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

export const notificationsApi = {
  list: (params: ListNotificationsParams = {}, signal?: AbortSignal) =>
    call('', listNotificationsResponseSchema, {
      query: {
        state: params.states === undefined || params.states.length === 0 ? undefined : params.states.join(','),
        limit: params.limit,
        before: params.before,
      },
      signal,
    }),
  get: (notificationId: string, signal?: AbortSignal) => call(`/${id(notificationId)}`, notificationSchema, { signal }),
  markRead: (notificationId: string) =>
    call(`/${id(notificationId)}/read`, notificationSchema, { method: 'POST', body: {} }),
  snooze: (notificationId: string, untilMs: number) =>
    call(`/${id(notificationId)}/snooze`, notificationSchema, {
      method: 'POST',
      body: snoozeNotificationBodySchema.parse({ untilMs }),
    }),
  /** Which actions this node can execute; refused actions are `not_configured`, never faked. */
  actions: (signal?: AbortSignal) => call('/actions', notificationActionsResponseSchema, { signal }),
  /** The body is validated before it leaves the browser, so a content-bearing action is never sent. */
  execute: (notificationId: string, body: ExecuteNotificationActionBody, idempotencyKey: string) =>
    call(`/${id(notificationId)}/actions`, notificationActionResponseSchema, {
      method: 'POST',
      headers: { [NOTIFICATION_IDEMPOTENCY_HEADER]: notificationIdempotencyKeySchema.parse(idempotencyKey) },
      body: executeNotificationActionBodySchema.parse(body),
    }),
}
