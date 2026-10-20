import { Hono } from 'hono'
import {
  createRecipeBody,
  createRecipeResponse,
  createRecipeJobSnapshotBody,
  createRecipeJobSnapshotResponse,
  getRecipeResponse,
  getRecipeRevisionResponse,
  getRecipeJobSnapshotResponse,
  listRecipesResponse,
  recipePathParams,
  recipeRevisionPathParams,
  recipeJobSnapshotPathParams,
  recipeJobSnapshotQuery,
  recipeJobSnapshotReadPathParams,
  recipeScopeQuery,
  renameRecipeBody,
  renameRecipeResponse,
  reviseRecipeBody,
  reviseRecipeResponse,
  type RecipeScope,
  type RecipeJobSnapshotScope,
  ROUTES,
} from '@guanxi/contract'
import type { AppContext } from '../context.ts'
import { JobStoreError } from '../store/jobs.ts'
import { RecipeStore } from '../store/recipes.ts'
import { fail, notFound } from './errors.ts'

const QUERY_KEYS = new Set(['recipeVersion', 'scope', 'projectId'])
const SNAPSHOT_QUERY_KEYS = new Set(['recipeJobSnapshotVersion', 'scope', 'projectId'])

function parseScope(url: string): RecipeScope | null {
  const query = new URL(url).searchParams
  if (
    [...query.keys()].some((key) => !QUERY_KEYS.has(key)) ||
    [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
  ) return null
  const parsed = recipeScopeQuery.safeParse(Object.fromEntries(query))
  if (!parsed.success) return null
  return parsed.data.scope === 'project'
    ? { scope: 'project', projectId: parsed.data.projectId }
    : { scope: 'projectless' }
}

function parseSnapshotScope(url: string): RecipeJobSnapshotScope | null {
  const query = new URL(url).searchParams
  if (
    [...query.keys()].some((key) => !SNAPSHOT_QUERY_KEYS.has(key)) ||
    [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
  ) return null
  const parsed = recipeJobSnapshotQuery.safeParse(Object.fromEntries(query))
  if (!parsed.success) return null
  return parsed.data.scope === 'project'
    ? { scope: 'project', projectId: parsed.data.projectId }
    : { scope: 'projectless' }
}

function bodyScope(body: { scope: 'projectless' } | { scope: 'project'; projectId: string }): RecipeScope {
  return body.scope === 'project'
    ? { scope: 'project', projectId: body.projectId }
    : { scope: 'projectless' }
}

function validateProject(
  app: Pick<AppContext, 'projects'>,
  scope: RecipeScope,
): boolean {
  return scope.scope === 'projectless' || app.projects.get(scope.projectId) !== null
}

export function recipesRoutes(app: Pick<AppContext, 'db' | 'projects' | 'jobService'>): Hono {
  const routes = new Hono()
  const store = () => new RecipeStore(app.db)

  routes.get('/', (context) => {
    const scope = parseScope(context.req.url)
    if (!scope) return context.json({ code: 'validation_failed', message: 'Invalid Recipe scope', details: null }, 400)
    if (!validateProject(app, scope)) return notFound(context, 'project_not_found', 'Project was not found')
    return context.json(listRecipesResponse.parse({
      recipeVersion: 1,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : null,
      recipes: store().list(scope),
    }))
  })

  routes.post('/', async (context) => {
    const parsed = createRecipeBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return context.json({ code: 'validation_failed', message: 'Invalid Recipe create request', details: null }, 400)
    const scope = bodyScope(parsed.data)
    if (!validateProject(app, scope)) return notFound(context, 'project_not_found', 'Project was not found')
    try {
      return context.json(createRecipeResponse.parse(store().create({
        name: parsed.data.name,
        scope,
        configuration: parsed.data.configuration,
      })), 201)
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.patch('/:id/name', async (context) => {
    const path = recipePathParams.safeParse(context.req.param())
    const parsed = renameRecipeBody.safeParse(await context.req.json().catch(() => null))
    if (!path.success || !parsed.success) return context.json({ code: 'validation_failed', message: 'Invalid Recipe rename request', details: null }, 400)
    const scope = bodyScope(parsed.data)
    if (!validateProject(app, scope)) return notFound(context, 'project_not_found', 'Project was not found')
    try {
      const result = store().rename(path.data.id, scope, parsed.data.name)
      if (result.status !== 'ok') return notFound(context, 'recipe_not_found', 'Recipe was not found in this scope')
      return context.json(renameRecipeResponse.parse(result.recipe))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.post('/:id/revisions', async (context) => {
    const path = recipePathParams.safeParse(context.req.param())
    const parsed = reviseRecipeBody.safeParse(await context.req.json().catch(() => null))
    if (!path.success || !parsed.success) return context.json({ code: 'validation_failed', message: 'Invalid Recipe revision request', details: null }, 400)
    const scope = bodyScope(parsed.data)
    if (!validateProject(app, scope)) return notFound(context, 'project_not_found', 'Project was not found')
    try {
      const result = store().revise(
        path.data.id,
        scope,
        parsed.data.expectedRevision,
        parsed.data.configuration,
      )
      if (result.status === 'conflict') {
        return context.json({
          code: 'recipe_revision_conflict',
          message: 'Recipe changed since this revision was opened',
          details: { expectedRevision: parsed.data.expectedRevision, currentRevision: result.currentRevision },
        }, 409)
      }
      if (result.status !== 'ok') return notFound(context, 'recipe_not_found', 'Recipe was not found in this scope')
      return context.json(reviseRecipeResponse.parse(result.recipe))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.post('/:id/revisions/:revision/jobs', async (context) => {
    const path = recipeJobSnapshotPathParams.safeParse(context.req.param())
    const parsed = createRecipeJobSnapshotBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!path.success || !parsed.success) {
      return context.json({
        code: 'validation_failed',
        message: 'Invalid Recipe Job snapshot request',
        details: null,
      }, 400)
    }
    const scope = bodyScope(parsed.data)
    if (!validateProject(app, scope)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    if (store().getRevision(path.data.id, path.data.revision, scope).status !== 'ok') {
      return notFound(
        context,
        'recipe_not_found',
        'Recipe revision was not found in this scope',
      )
    }

    try {
      const result = app.jobService.createRecipeSnapshot({
        recipeId: path.data.id,
        recipeRevision: path.data.revision,
        scope,
        idempotencyKey: parsed.data.idempotencyKey,
      })
      return context.json(createRecipeJobSnapshotResponse.parse({
        ...result,
        eventsUrl: ROUTES.jobEvents(result.job.id),
      }), result.created ? 202 : 200)
    } catch (error) {
      if (error instanceof JobStoreError && error.code === 'idempotency_conflict') {
        return context.json({
          code: 'recipe_job_conflict',
          message: 'Recipe Job idempotency key is bound to different input',
          details: null,
        }, 409)
      }
      return fail(context, error)
    }
  })

  routes.get('/:id/revisions/:revision/jobs/:jobId', (context) => {
    const path = recipeJobSnapshotReadPathParams.safeParse(context.req.param())
    const scope = parseSnapshotScope(context.req.url)
    if (!path.success || !scope) {
      return context.json({
        code: 'validation_failed',
        message: 'Invalid Recipe Job snapshot read request',
        details: null,
      }, 400)
    }
    if (!validateProject(app, scope)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    try {
      const result = app.jobService.recipeSnapshot(path.data.jobId)
      if (
        !result ||
        result.snapshot.recipeId !== path.data.id ||
        result.snapshot.recipeRevision !== path.data.revision ||
        result.snapshot.scope !== scope.scope ||
        result.snapshot.projectId !== (scope.scope === 'project' ? scope.projectId : null)
      ) {
        return notFound(
          context,
          'recipe_job_not_found',
          'Recipe Job snapshot was not found in this scope',
        )
      }
      return context.json(getRecipeJobSnapshotResponse.parse({
        ...result,
        eventsUrl: ROUTES.jobEvents(result.job.id),
      }))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:id/revisions/:revision', (context) => {
    const scope = parseScope(context.req.url)
    const path = recipeRevisionPathParams.safeParse(context.req.param())
    if (!scope || !path.success) return context.json({ code: 'validation_failed', message: 'Invalid Recipe revision request', details: null }, 400)
    if (!validateProject(app, scope)) return notFound(context, 'project_not_found', 'Project was not found')
    const result = store().getRevision(path.data.id, path.data.revision, scope)
    if (result.status !== 'ok') return notFound(context, 'recipe_not_found', 'Recipe revision was not found in this scope')
    return context.json(getRecipeRevisionResponse.parse(result.revision))
  })

  routes.get('/:id', (context) => {
    const scope = parseScope(context.req.url)
    const path = recipePathParams.safeParse(context.req.param())
    if (!scope || !path.success) return context.json({ code: 'validation_failed', message: 'Invalid Recipe scope', details: null }, 400)
    if (!validateProject(app, scope)) return notFound(context, 'project_not_found', 'Project was not found')
    const result = store().get(path.data.id, scope)
    if (result.status !== 'ok') return notFound(context, 'recipe_not_found', 'Recipe was not found in this scope')
    return context.json(getRecipeResponse.parse(result.recipe))
  })

  return routes
}
