import { Hono } from 'hono'
import {
  createQuickRunBody,
  createQuickRunResponse,
  getQuickRunResponse,
  listQuickRunsResponse,
  quickRunScopeQuery,
  updateQuickRunRetentionBody,
  updateQuickRunRetentionResponse,
  type QuickRunScope,
} from '@alamo/contract'
import type { AppContext } from '../context.ts'
import { QuickRunStore } from '../store/quick-runs.ts'
import { fail, notFound } from './errors.ts'

const QUERY_KEYS = new Set(['quickRunVersion', 'scope', 'projectId'])

function parseScope(url: string): QuickRunScope | null {
  const query = new URL(url).searchParams
  if (
    [...query.keys()].some((key) => !QUERY_KEYS.has(key)) ||
    [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
  ) return null
  const parsed = quickRunScopeQuery.safeParse(Object.fromEntries(query))
  if (!parsed.success) return null
  return parsed.data.scope === 'project'
    ? { scope: 'project', projectId: parsed.data.projectId }
    : { scope: 'projectless' }
}

function scopeFromBody(
  body: { scope: 'projectless' } | { scope: 'project'; projectId: string },
): QuickRunScope {
  return body.scope === 'project'
    ? { scope: 'project', projectId: body.projectId }
    : { scope: 'projectless' }
}

export function quickRunsRoutes(app: Pick<AppContext, 'db' | 'projects'>): Hono {
  const routes = new Hono()
  const store = () => new QuickRunStore(app.db)

  routes.get('/', (context) => {
    const scope = parseScope(context.req.url)
    if (!scope) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Quick Run scope', details: null },
        400,
      )
    }
    if (scope.scope === 'project' && !app.projects.get(scope.projectId)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    return context.json(listQuickRunsResponse.parse({
      quickRunVersion: 1,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : null,
      quickRuns: store().list(scope),
    }))
  })

  routes.post('/', async (context) => {
    const parsed = createQuickRunBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Quick Run create request', details: null },
        400,
      )
    }
    const scope = scopeFromBody(parsed.data)
    if (scope.scope === 'project' && !app.projects.get(scope.projectId)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    try {
      return context.json(createQuickRunResponse.parse(store().create({
        operation: parsed.data.operation,
        scope,
      })), 201)
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.patch('/:id/retention', async (context) => {
    const parsed = updateQuickRunRetentionBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Quick Run retention request', details: null },
        400,
      )
    }
    const scope = scopeFromBody(parsed.data)
    if (scope.scope === 'project' && !app.projects.get(scope.projectId)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    try {
      const result = store().updateRetention(context.req.param('id'), scope, parsed.data.policy)
      if (result.status !== 'ok') {
        return notFound(context, 'quick_run_not_found', 'Quick Run was not found in this scope')
      }
      return context.json(updateQuickRunRetentionResponse.parse(result.quickRun))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:id', (context) => {
    const scope = parseScope(context.req.url)
    if (!scope) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Quick Run scope', details: null },
        400,
      )
    }
    if (scope.scope === 'project' && !app.projects.get(scope.projectId)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    const result = store().get(context.req.param('id'), scope)
    if (result.status !== 'ok') {
      return notFound(context, 'quick_run_not_found', 'Quick Run was not found in this scope')
    }
    return context.json(getQuickRunResponse.parse(result.quickRun))
  })

  return routes
}
