import { Hono } from 'hono'
import { z } from 'zod'
import { relayStartInputSchema, relayStartStatusSchema } from '@guanxi/contract'
import { isLoopbackPeer } from '../session-log/routes.ts'
import { relayStartCode, type RelayStarts } from './start.ts'

export function relayStartRoutes(service: () => RelayStarts, devOrigins: readonly string[] = []) {
  const routes = new Hono()
  routes.onError((error, c) => {
    const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'validation_failed' : relayStartCode(error)
    return c.json({ code }, code === 'validation_failed' ? 400 : code === 'relay_not_found' ? 404 : code === 'relay_idempotency_conflict' || code === 'stale_lease' ? 409 : 503)
  })
  routes.use('*', async (c, next) => {
    if (!isLoopbackPeer(c)) return c.json({ code: 'loopback_only' }, 403)
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin')
      if (origin && origin !== new URL(c.req.url).origin && !devOrigins.includes(origin)) return c.json({ code: 'origin_denied' }, 403)
      if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ code: 'json_required' }, 415)
    }
    await next()
  })
  const key = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
  routes.post('/', async c => c.json(relayStartStatusSchema.parse(await service().start(relayStartInputSchema.parse(await c.req.json()))), 202))
  routes.get('/starts/:key', c => c.json(relayStartStatusSchema.parse(service().status(key.parse(c.req.param('key'))))))
  routes.get('/starts/:key/result', c => c.json(relayStartStatusSchema.parse(service().status(key.parse(c.req.param('key'))))))
  routes.post('/starts/:key/stop', async c => {
    z.object({}).strict().parse(await c.req.json())
    return c.json(relayStartStatusSchema.parse(await service().stop(key.parse(c.req.param('key')))))
  })
  routes.get('/:runId', c => c.json(service().status(service().keyForRun(key.parse(c.req.param('runId'))))))
  routes.get('/:runId/result', c => c.json(service().status(service().keyForRun(key.parse(c.req.param('runId'))))))
  routes.post('/:runId/stop', async c => {
    z.object({}).strict().parse(await c.req.json())
    return c.json(await service().stop(service().keyForRun(key.parse(c.req.param('runId')))))
  })
  return routes
}
