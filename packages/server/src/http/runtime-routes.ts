import { Hono } from 'hono'
import { estimatedParallelAdmissionBody } from '@guanxi/contract'
import type { AppContext } from '../context.ts'
import { fail } from './errors.ts'

export function runtimeRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.post('/estimated-parallel-admission', async (context) => {
    const body = estimatedParallelAdmissionBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) {
      return context.json(
        {
          code: 'validation_failed' as const,
          message: 'Invalid estimated parallel-admission request',
          details: body.error.flatten(),
        },
        400,
      )
    }
    try {
      return context.json(
        await app.estimatedParallelAdmission.estimate(
          body.data,
          context.req.raw.signal,
        ),
      )
    } catch (error) {
      return fail(context, error)
    }
  })

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
