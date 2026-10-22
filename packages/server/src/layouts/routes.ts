import { bodyLimit } from 'hono/body-limit'
import { Hono } from 'hono'
import { layoutGeometryBody, layoutGeometryQuerySchema, layoutQuerySchema, saveLayoutBody } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import { LayoutStore } from './store.ts'
import type { ReplicatedLayouts, LayoutRepository } from './replication.ts'
import { FederationError } from '../federation/crypto.ts'

export function layoutsRoutes(db: Db | (() => Db), allowedOrigins: readonly string[] = [], replicated?: () => ReplicatedLayouts | null): Hono {
  const routes = new Hono()
  let store: LayoutStore | undefined
  const getStore = (): LayoutRepository => replicated?.() ?? (store ??= new LayoutStore(typeof db === 'function' ? db() : db))
  routes.onError((error, context) => {
    if (error instanceof FederationError) return context.json({ code: 'validation_failed', message: error.code, details: null }, error.status as 403)
    if (error.message === 'layout_clock_collision') return context.json({ code: 'layout_conflict', message: 'Different layouts have the same writer clock', details: null }, 409)
    throw error
  })
  routes.use('*', bodyLimit({ maxSize: 1_048_576, onError: context => context.json({ code: 'validation_failed', message: 'Layout request exceeds the node JSON budget', details: null }, 413) }))
  routes.use('*', async (context, next) => {
    if (context.req.method !== 'GET') {
      const origin = context.req.header('origin')
      const site = context.req.header('sec-fetch-site')
      const url = new URL(context.req.url)
      if (!/^application\/json\b/i.test(context.req.header('content-type') ?? '') ||
        (origin && origin !== url.origin && !allowedOrigins.includes(origin)) ||
        (site === 'cross-site')) return context.json({ code: 'validation_failed', message: 'Same-origin JSON required', details: null }, 403)
    }
    await next()
  })
  const invalid = { code: 'validation_failed', message: 'Invalid layout request', details: null }
  routes.get('/context', context => {
    const repository = replicated?.()
    return context.json({ account: repository?.account ?? 'local', replication: repository !== null && repository !== undefined })
  })
  routes.get('/', context => {
    const query = layoutQuerySchema.safeParse(context.req.query())
    return query.success ? context.json(getStore().list(query.data)) : context.json(invalid, 400)
  })
  routes.put('/', async context => {
    const body = saveLayoutBody.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(invalid, 400)
    try { return context.json(getStore().save(body.data.document, body.data.activate, body.data.basedOn)) }
    catch (error) {
      if (error instanceof Error && error.message === 'layout_clock_collision') return context.json({ code: 'layout_conflict', message: 'Different layouts have the same writer clock', details: null }, 409)
      throw error
    }
  })
  routes.get('/geometry', context => {
    const parsed = layoutGeometryQuerySchema.safeParse(context.req.query())
    if (!parsed.success) return context.json(invalid, 400)
    const { scopeDevice, device, layoutId, ...scope } = parsed.data
    return context.json({ geometry: getStore().geometry({ ...scope, ...(scopeDevice ? { device: scopeDevice } : {}) }, device, layoutId) })
  })
  routes.put('/geometry', async context => {
    const parsed = layoutGeometryBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json(invalid, 400)
    const { scope, device, layoutId, geometry } = parsed.data
    getStore().saveGeometry(scope, device, layoutId, geometry)
    return context.json({ geometry })
  })
  return routes
}
