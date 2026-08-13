import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, Recipe, RecipeConfiguration } from '@alamo/contract'
import { RecipesPage } from '../../src/features/recipes/RecipesPage.tsx'
import { ApiRequestError, api } from '../../src/lib/api.ts'

const AT = '2026-08-13T12:00:00.000Z'
const ID = '11111111-1111-4111-8111-111111111111'
const PROJECT: Project = {
  id: 'project-1', name: 'Exact Project', createdAt: AT, updatedAt: AT, filesystemBindings: [],
}

const configuration = (revision = 1): RecipeConfiguration => ({
  recipeRevisionVersion: 1,
  operation: 'complete',
  model: { state: 'none', reason: 'not_selected' },
  instructions: revision === 1 ? 'Exact instructions' : 'Revised instructions',
  defaultParameters: { temperature: 0.2 },
  retention: { mode: 'ttl', expiresAfterDays: 7 },
})

function recipe(revision = 1, projectId: string | null = null, name = 'Exact Recipe'): Recipe {
  return {
    recipeVersion: 1,
    id: ID,
    name,
    scope: projectId === null ? 'projectless' : 'project',
    projectId,
    createdAt: AT,
    updatedAt: AT,
    currentRevision: {
      recipeRevisionVersion: 1,
      recipeId: ID,
      revision,
      configuration: configuration(revision),
      canonical: { format: 'canonical_json_v1', byteSize: 144 + revision, sha256: 'a'.repeat(64) },
      createdAt: AT,
    },
    advancedRouting: 'not_implemented',
    execution: 'not_implemented',
    jobSnapshot: 'not_implemented',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.lang = 'ru'
})

describe('RecipesPage', () => {
  it('distinguishes loading, focused error/retry and exact empty scope', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    const retry = deferred<{ recipeVersion: 1; scope: 'projectless'; projectId: null; recipes: Recipe[] }>()
    vi.spyOn(api, 'listRecipes')
      .mockRejectedValueOnce(new Error('safe Recipe list failure'))
      .mockReturnValueOnce(retry.promise)

    render(<RecipesPage />)
    expect(screen.getByRole('status', { name: 'Загружаем сценарии' })).toBeTruthy()
    const heading = await screen.findByRole('heading', { name: 'Не удалось загрузить сценарии' })
    await waitFor(() => expect(heading).toBe(document.activeElement))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить', exact: true }))
    await act(async () => retry.resolve({ recipeVersion: 1, scope: 'projectless', projectId: null, recipes: [] }))
    expect(await screen.findByText('В этой области нет сценариев')).toBeTruthy()
    expect(api.listRecipes).toHaveBeenCalledTimes(2)
  })

  it('creates one exact Project revision 1, shows provenance and uses English fallback', async () => {
    document.documentElement.lang = 'fr'
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1 })
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [PROJECT] })
    vi.spyOn(api, 'listRecipes').mockImplementation(async (scope) => ({
      recipeVersion: 1,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : null,
      recipes: [],
    }))
    const creation = deferred<Recipe>()
    vi.spyOn(api, 'createRecipe').mockReturnValue(creation.promise)

    render(<RecipesPage />)
    expect(await screen.findByRole('heading', { name: 'Recipes' })).toBeTruthy()
    expect(screen.getByText('Configuration only; execution is not connected')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Scope' }), { target: { value: PROJECT.id } })
    await screen.findByRole('heading', { name: 'Exact Project' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipe name' }), { target: { value: 'Project Recipe' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Exact instructions' } })
    const create = screen.getByRole('button', { name: 'Create Recipe' })
    fireEvent.submit(create.closest('form')!)
    fireEvent.submit(create.closest('form')!)
    expect(api.createRecipe).toHaveBeenCalledTimes(1)
    expect(api.createRecipe).toHaveBeenCalledWith({
      recipeVersion: 1,
      name: 'Project Recipe',
      scope: 'project',
      projectId: PROJECT.id,
      configuration: {
        recipeRevisionVersion: 1,
        operation: 'complete',
        model: { state: 'none', reason: 'not_selected' },
        instructions: 'Exact instructions',
        defaultParameters: {},
        retention: { mode: 'ttl', expiresAfterDays: 7 },
      },
    })
    await act(async () => creation.resolve(recipe(1, PROJECT.id, 'Project Recipe')))
    expect(await screen.findByText('Revision 1')).toBeTruthy()
    expect(screen.getByText(/sha256:aaaa/u)).toBeTruthy()
    expect(screen.getByText('Advanced routing, execution, and Job snapshot attachment are not implemented.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /run|execute|route/iu })).toBeNull()
    await waitFor(() => expect(create).toBe(document.activeElement))
  })

  it('renames without a revision and explicitly revises to N+1', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'listRecipes').mockResolvedValue({ recipeVersion: 1, scope: 'projectless', projectId: null, recipes: [recipe()] })
    vi.spyOn(api, 'renameRecipe').mockResolvedValue(recipe(1, null, 'Новое имя'))
    const revision = deferred<Recipe>()
    vi.spyOn(api, 'reviseRecipe').mockReturnValue(revision.promise)

    render(<RecipesPage />)
    await screen.findByText(ID)
    const rename = screen.getByRole('textbox', { name: 'Отображаемое название' })
    fireEvent.change(rename, { target: { value: 'Новое имя' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Переименовать' }).closest('form')!)
    expect(await screen.findByRole('heading', { name: 'Новое имя' })).toBeTruthy()
    expect(screen.getByText('Ревизия 1')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Изменить конфигурацию' }))
    const forms = screen.getAllByRole('textbox', { name: 'Инструкции' })
    fireEvent.change(forms.at(-1)!, { target: { value: 'Revised instructions' } })
    const revise = screen.getByRole('button', { name: 'Создать следующую ревизию' })
    fireEvent.submit(revise.closest('form')!)
    fireEvent.submit(revise.closest('form')!)
    expect(api.reviseRecipe).toHaveBeenCalledTimes(1)
    await act(async () => revision.resolve(recipe(2, null, 'Новое имя')))
    expect(await screen.findByText('Ревизия 2')).toBeTruthy()
  })

  it('focuses a stale revision conflict and reloads instead of claiming a partial revision', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1 })
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'listRecipes')
      .mockResolvedValueOnce({ recipeVersion: 1, scope: 'projectless', projectId: null, recipes: [recipe()] })
      .mockResolvedValueOnce({ recipeVersion: 1, scope: 'projectless', projectId: null, recipes: [recipe(2)] })
    vi.spyOn(api, 'reviseRecipe').mockRejectedValue(new ApiRequestError(409, {
      code: 'recipe_revision_conflict', message: 'conflict', details: { expectedRevision: 1, currentRevision: 2 },
    }, 'conflict'))

    render(<RecipesPage />)
    await screen.findByText(ID)
    fireEvent.click(screen.getByRole('button', { name: 'Изменить конфигурацию' }))
    fireEvent.submit(screen.getByRole('button', { name: 'Создать следующую ревизию' }).closest('form')!)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Частичная ревизия не сохранена')
    expect(alert).toBe(document.activeElement)
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить текущую ревизию' }))
    expect(await screen.findByText('Ревизия 2')).toBeTruthy()
    expect(api.listRecipes).toHaveBeenCalledTimes(2)
  })
})
