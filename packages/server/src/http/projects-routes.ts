import { createProjectBody, updateProjectBody } from '@alamo/contract'
import { Hono } from 'hono'
import type { AppContext } from '../context.ts'
import { notFound } from './errors.ts'

export function projectsRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', (context) => context.json({ projects: app.projects.list() }))

  routes.post('/', async (context) => {
    const parsed = createProjectBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Project name must contain 1–120 characters', details: null },
        400,
      )
    }
    return context.json(app.projects.create(parsed.data.name), 201)
  })

  routes.get('/:id', (context) => {
    const project = app.projects.get(context.req.param('id'))
    return project
      ? context.json(project)
      : notFound(context, 'project_not_found', 'Project was not found')
  })

  routes.patch('/:id', async (context) => {
    const parsed = updateProjectBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Project name must contain 1–120 characters', details: null },
        400,
      )
    }
    const project = app.projects.rename(context.req.param('id'), parsed.data.name)
    return project
      ? context.json(project)
      : notFound(context, 'project_not_found', 'Project was not found')
  })

  return routes
}
