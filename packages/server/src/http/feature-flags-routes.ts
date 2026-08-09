import { Hono } from 'hono'
import type { AppContext } from '../context.ts'

export function featureFlagsRoutes(app: AppContext): Hono {
  const routes = new Hono()
  routes.get('/', (context) => context.json(app.featureFlags.publicProjection()))
  return routes
}
