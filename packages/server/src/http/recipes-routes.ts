import { Hono } from 'hono'
import {
  createRecipeBody,
  createRecipeResponse,
  getRecipeResponse,
  getRecipeRevisionResponse,
  listRecipesResponse,
  recipePathParams,
  recipeRevisionPathParams,
  recipeScopeQuery,
  renameRecipeBody,
  renameRecipeResponse,
  reviseRecipeBody,
  reviseRecipeResponse,
  type RecipeScope,
} from '@alamo/contract'
import type { AppContext } from '../context.ts'
import { RecipeStore } from '../store/recipes.ts'
import { fail, notFound } from './errors.ts'

const QUERY_KEYS = new Set(['recipeVersion', 'scope', 'projectId'])

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

export function recipesRoutes(app: Pick<AppContext, 'db' | 'projects'>): Hono {
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
