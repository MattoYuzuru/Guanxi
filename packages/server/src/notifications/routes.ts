import { Hono } from 'hono'
import {
  NOTIFICATION_IDEMPOTENCY_HEADER,
  executeNotificationActionBodySchema,
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  notificationActionsResponseSchema,
  notificationIdSchema,
  notificationIdempotencyKeySchema,
  snoozeNotificationBodySchema,
  type NotificationErrorCode,
} from '@guanxi/contract'
import { ServiceUnavailableError, failureResponse, localGuard, wire } from '../http/local-guard.ts'
import type { NotificationInbox } from './inbox.ts'
import { notificationFailure, toActionResponse, toNotificationWire } from './wire.ts'

/**
 * REST surface of the notification inbox. `accountId` is the single local owner today; every
 * handler passes it explicitly so a U3 `can()` check becomes one call per handler.
 *
 * Ingestion is not exposed: quota facts enter through the kernel service, never over HTTP.
 */
export function notificationRoutes(resolve: () => NotificationInbox | undefined, accountId: string, devOrigins: readonly string[] = []): Hono {
  const routes = new Hono()
  const inbox = (): NotificationInbox => {
    const current = resolve()
    if (current === undefined) throw new ServiceUnavailableError()
    return current
  }
  routes.onError((error, c) => {
    if (error instanceof ServiceUnavailableError) {
      return failureResponse(c, { code: 'notifications_unavailable' satisfies NotificationErrorCode, status: 503 })
    }
    return failureResponse(c, notificationFailure(error))
  })
  routes.use('*', localGuard(devOrigins))

  routes.get('/', (c) => {
    const query = listNotificationsQuerySchema.parse(c.req.query())
    const page = inbox().list(accountId, { states: query.state, limit: query.limit, before: query.before })
    return c.json(wire(listNotificationsResponseSchema, {
      notifications: page.items.map(toNotificationWire),
      nextCursor: page.nextCursor,
    }))
  })
  routes.get('/actions', (c) => c.json(wire(notificationActionsResponseSchema, { actions: inbox().availability() })))
  routes.get('/:id', (c) => c.json(toNotificationWire(inbox().get(accountId, notificationIdSchema.parse(c.req.param('id'))))))
  routes.post('/:id/read', async (c) => {
    const id = notificationIdSchema.parse(c.req.param('id'))
    emptyBody(await c.req.json())
    return c.json(toNotificationWire(inbox().markRead(accountId, id)))
  })
  routes.post('/:id/snooze', async (c) => {
    const id = notificationIdSchema.parse(c.req.param('id'))
    const body = snoozeNotificationBodySchema.parse(await c.req.json())
    return c.json(toNotificationWire(inbox().snooze(accountId, id, body.untilMs)))
  })
  routes.post('/:id/actions', async (c) => {
    const id = notificationIdSchema.parse(c.req.param('id'))
    const key = notificationIdempotencyKeySchema.safeParse(c.req.header(NOTIFICATION_IDEMPOTENCY_HEADER))
    if (!key.success) return failureResponse(c, { code: 'idempotency_key_required' satisfies NotificationErrorCode, status: 400 })
    const body = executeNotificationActionBodySchema.parse(await c.req.json())
    const execution = await inbox().execute(accountId, id, body.action, body.args, key.data)
    return c.json(toActionResponse(execution))
  })
  return routes
}

function emptyBody(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new SyntaxError('empty object required')
  }
}
