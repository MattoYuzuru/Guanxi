import { Hono } from 'hono'
import type { AppContext } from '../context.ts'
import { fail } from './errors.ts'

export function runtimeRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', async (context) => {
    try {
      return context.json(
        await app.runtime.snapshot({ signal: context.req.raw.signal }),
      )
    } catch (error) {
      return fail(context, error)
    }
  })

  return routes
}
