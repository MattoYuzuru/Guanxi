import { Hono } from 'hono'
import { createConnectionSchema, updateConnectionSchema, connectionSecretInputSchema } from '@guanxi/contract'
import type { Connections } from './service.ts'

/** Local owner scope only; account authentication replaces this binding in the account stage. */
export function connectionRoutes(resolveConnections: () => Connections, accountId: string, devOrigins: readonly string[] = []): Hono {
  const routes = new Hono()
  routes.onError((_error, c) => c.json({ code: 'connection_failed' }, 400))
  // Same-origin mutations only: a website cannot use the local owner's unlocked vault.
  routes.use('*', async (c, next) => {
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin')
      if (origin && new URL(origin).origin !== new URL(c.req.url).origin && !devOrigins.includes(origin)) return c.json({ code: 'origin_denied' }, 403)
      if (c.req.method !== 'DELETE' && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ code: 'json_required' }, 415)
    }
    c.header('Cache-Control', 'no-store')
    await next()
  })
  routes.get('/', c => c.json(resolveConnections().snapshot(accountId)))
  routes.post('/', async c => c.json(resolveConnections().create(accountId, createConnectionSchema.parse(await c.req.json())), 201))
  routes.patch('/:id', async c => {
    const input = updateConnectionSchema.parse(await c.req.json())
    return c.json(resolveConnections().setUnattended(accountId, c.req.param('id'), input.unattended))
  })
  routes.post('/vault/unlock', async c => { await resolveConnections().unlockVault(accountId); return c.json({ ok: true }) })
  routes.post('/vault/lock', c => { resolveConnections().lockVault(accountId); return c.json({ ok: true }) })
  routes.put('/:id/secret', async c => {
    const input = connectionSecretInputSchema.parse(await c.req.json())
    return c.json(resolveConnections().saveSecret(accountId, c.req.param('id'), input.value))
  })
  routes.get('/:id/models', c => c.json(resolveConnections().models(accountId, c.req.param('id'))))
  routes.post('/:id/probe', async c => c.json(await resolveConnections().probe(accountId, c.req.param('id'), c.req.raw.signal)))
  return routes
}
