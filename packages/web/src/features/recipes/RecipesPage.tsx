import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  RECIPE_OPERATIONS,
  RECIPE_REVISION_VERSION,
  RECIPE_VERSION,
  type Project,
  type Recipe,
  type RecipeConfiguration,
  type RecipeJsonValue,
  type RecipeJobSnapshot,
  type Job,
  type RecipeOperation,
  type RecipeScopeQuery,
} from '@guanxi/contract'
import { Badge, Button, Callout, EmptyState, Skeleton } from '../../components/ui.tsx'
import { ApiRequestError, api, errorMessage } from '../../lib/api.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useAsync } from '../../lib/useAsync.ts'

type Scope = { scope: 'projectless' } | { scope: 'project'; projectId: string }

type SnapshotReference = {
  recipeId: string
  recipeRevision: number
  jobId: string
  scope: Scope
}

type SnapshotProjection = {
  job: Job
  snapshot: RecipeJobSnapshot
  eventsUrl: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function snapshotReferenceFromLocation(): SnapshotReference | null {
  const parameters = new URLSearchParams(window.location.search)
  const recipeId = parameters.get('snapshotRecipe')
  const jobId = parameters.get('snapshotJob')
  const rawRevision = parameters.get('snapshotRevision')
  const rawScope = parameters.get('snapshotScope')
  const projectId = parameters.get('snapshotProject')
  const recipeRevision = Number(rawRevision)
  if (
    !recipeId ||
    !jobId ||
    !UUID_PATTERN.test(recipeId) ||
    !UUID_PATTERN.test(jobId) ||
    !Number.isSafeInteger(recipeRevision) ||
    recipeRevision < 1
  ) return null
  if (rawScope === 'projectless' && projectId === null) {
    return { recipeId, recipeRevision, jobId, scope: { scope: 'projectless' } }
  }
  if (rawScope === 'project' && projectId && projectId === projectId.trim()) {
    return { recipeId, recipeRevision, jobId, scope: { scope: 'project', projectId } }
  }
  return null
}

function rememberSnapshotReference(reference: SnapshotReference): void {
  const url = new URL(window.location.href)
  url.searchParams.set('snapshotRecipe', reference.recipeId)
  url.searchParams.set('snapshotRevision', String(reference.recipeRevision))
  url.searchParams.set('snapshotJob', reference.jobId)
  url.searchParams.set('snapshotScope', reference.scope.scope)
  if (reference.scope.scope === 'project') {
    url.searchParams.set('snapshotProject', reference.scope.projectId)
  } else {
    url.searchParams.delete('snapshotProject')
  }
  window.history.replaceState(window.history.state, '', url)
}

function query(scope: Scope): RecipeScopeQuery {
  return scope.scope === 'project'
    ? { recipeVersion: RECIPE_VERSION, scope: 'project', projectId: scope.projectId }
    : { recipeVersion: RECIPE_VERSION, scope: 'projectless' }
}

function scopeMatches(recipe: Recipe, scope: Scope): boolean {
  return scope.scope === 'project'
    ? recipe.scope === 'project' && recipe.projectId === scope.projectId
    : recipe.scope === 'projectless' && recipe.projectId === null
}

function parseDefaults(text: string): Record<string, RecipeJsonValue> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, RecipeJsonValue>
      : null
  } catch {
    return null
  }
}

function baseConfiguration(operation: RecipeOperation): RecipeConfiguration {
  return {
    recipeRevisionVersion: RECIPE_REVISION_VERSION,
    operation,
    model: { state: 'none', reason: 'not_selected' },
    instructions: '',
    defaultParameters: {},
    retention: { mode: 'ttl', expiresAfterDays: 7 },
  }
}

export function RecipesPage() {
  const [initialSnapshotReference] = useState(snapshotReferenceFromLocation)
  const projects = useAsync((signal) => api.listProjects(signal), [])
  const [scope, setScope] = useState<Scope>(
    initialSnapshotReference?.scope ?? { scope: 'projectless' },
  )
  const selected = scope.scope === 'project' ? scope.projectId : 'projectless'

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 sm:px-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{translate('recipes.title')}</h1>
        <p className="mt-1 max-w-2xl text-xs text-[var(--fg-muted)]">
          {translate('recipes.description')}
        </p>
      </header>

      <div className="mt-4">
        <Callout tone="warning" title={translate('recipes.boundary.title')}>
          {translate('recipes.boundary.description')}
        </Callout>
      </div>

      <label className="mt-5 block max-w-md text-xs font-medium">
        {translate('recipes.scope.label')}
        <select
          value={selected}
          className="mt-1 h-8 w-full min-w-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2 text-xs text-[var(--fg)]"
          onChange={(event) => setScope(event.target.value === 'projectless'
            ? { scope: 'projectless' }
            : { scope: 'project', projectId: event.target.value })}
        >
          <option value="projectless">{translate('recipes.scope.projectless')}</option>
          {projects.data?.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>
      {projects.loading ? <p role="status" className="mt-1 text-2xs">{translate('recipes.projects.loading')}</p> : null}
      {projects.error ? (
        <div className="mt-2" role="alert">
          <Callout
            tone="warning"
            title={translate('recipes.projects.error')}
            action={<Button size="sm" onClick={projects.reload}>{translate('recipes.retry')}</Button>}
          >
            {errorMessage(projects.error)}
          </Callout>
        </div>
      ) : null}

      <RecipeScopePanel
        key={selected}
        scope={scope}
        projects={projects.data?.projects ?? []}
        initialSnapshotReference={initialSnapshotReference}
      />
    </div>
  )
}

function RecipeScopePanel({
  scope,
  projects,
  initialSnapshotReference,
}: {
  scope: Scope
  projects: Project[]
  initialSnapshotReference: SnapshotReference | null
}) {
  const { locale } = useLocale()
  const [recipes, setRecipes] = useState<Recipe[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [name, setName] = useState('')
  const [operation, setOperation] = useState<RecipeOperation>('complete')
  const [instructions, setInstructions] = useState('')
  const [modelReference, setModelReference] = useState('')
  const [defaults, setDefaults] = useState('{}')
  const [creating, setCreating] = useState(false)
  const [restoreCreateFocus, setRestoreCreateFocus] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createLock = useRef(false)
  const errorRef = useRef<HTMLHeadingElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)
  const scopeName = useMemo(() => scope.scope === 'project'
    ? projects.find((project) => project.id === scope.projectId)?.name ?? scope.projectId
    : translate('recipes.scope.projectless'), [locale, projects, scope])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    setRecipes(null)
    api.listRecipes(query(scope), controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        if (
          response.scope !== scope.scope ||
          response.projectId !== (scope.scope === 'project' ? scope.projectId : null) ||
          response.recipes.some((recipe) => !scopeMatches(recipe, scope))
        ) {
          setLoadError(translate('recipes.scopeMismatch'))
        } else {
          setRecipes(response.recipes)
        }
        setLoading(false)
      },
      (error) => {
        if (controller.signal.aborted) return
        setLoadError(errorMessage(error))
        setLoading(false)
      },
    )
    return () => controller.abort('recipe-scope-changed')
  }, [reload, scope])

  useEffect(() => {
    if (loadError) requestAnimationFrame(() => errorRef.current?.focus())
  }, [loadError])

  useEffect(() => {
    if (!creating && restoreCreateFocus) {
      createRef.current?.focus()
      setRestoreCreateFocus(false)
    }
  }, [creating, restoreCreateFocus])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (createLock.current) return
    const parameters = parseDefaults(defaults)
    if (!name.trim()) {
      setCreateError(translate('recipes.name.required'))
      return
    }
    if (!parameters) {
      setCreateError(translate('recipes.defaults.invalid'))
      return
    }
    createLock.current = true
    setCreating(true)
    setCreateError(null)
    const configuration: RecipeConfiguration = {
      ...baseConfiguration(operation),
      instructions,
      defaultParameters: parameters,
      model: modelReference.trim()
        ? { state: 'explicit', provider: 'ollama', reference: modelReference.trim() }
        : { state: 'none', reason: 'not_selected' },
    }
    try {
      const created = await api.createRecipe(scope.scope === 'project'
        ? { recipeVersion: 1, name: name.trim(), scope: 'project', projectId: scope.projectId, configuration }
        : { recipeVersion: 1, name: name.trim(), scope: 'projectless', configuration })
      if (!scopeMatches(created, scope)) throw new Error(translate('recipes.scopeMismatch'))
      setRecipes((current) => [created, ...(current ?? [])])
      setName('')
      setInstructions('')
      setModelReference('')
      setDefaults('{}')
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      createLock.current = false
      setCreating(false)
      setRestoreCreateFocus(true)
    }
  }

  return (
    <section className="mt-6 min-w-0" aria-labelledby="recipes-scope-title">
      <h2 id="recipes-scope-title" className="text-sm font-semibold">{scopeName}</h2>
      <form className="mt-3 grid min-w-0 gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-3 sm:grid-cols-2" onSubmit={(event) => void create(event)}>
        <label className="text-xs font-medium">
          {translate('recipes.name.label')}
          <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2" />
        </label>
        <label className="text-xs font-medium">
          {translate('recipes.operation.label')}
          <select value={operation} onChange={(event) => setOperation(event.target.value as RecipeOperation)} className="mt-1 h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2">
            {RECIPE_OPERATIONS.map((value) => <option key={value} value={value}>{translate(`recipes.operation.${value}`)}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium sm:col-span-2">
          {translate('recipes.instructions.label')}
          <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-2" />
        </label>
        <label className="text-xs font-medium">
          {translate('recipes.model.label')}
          <input value={modelReference} onChange={(event) => setModelReference(event.target.value)} placeholder={translate('recipes.model.none')} className="mt-1 h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2" />
        </label>
        <label className="text-xs font-medium">
          {translate('recipes.defaults.label')}
          <textarea value={defaults} onChange={(event) => setDefaults(event.target.value)} rows={2} spellCheck={false} className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-2 font-mono" />
        </label>
        <div className="sm:col-span-2">
          <Button ref={createRef} type="submit" loading={creating}>{translate('recipes.create')}</Button>
          {createError ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{createError}</p> : null}
        </div>
      </form>

      {loading ? (
        <div role="status" aria-label={translate('recipes.loading')} className="mt-4 space-y-2"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
      ) : loadError ? (
        <div className="mt-4" role="alert">
          <h3 ref={errorRef} tabIndex={-1} className="text-sm font-semibold outline-none">{translate('recipes.error.title')}</h3>
          <p className="mt-1 break-words text-xs text-[var(--danger)]">{loadError}</p>
          <Button className="mt-2" size="sm" onClick={() => setReload((value) => value + 1)}>{translate('recipes.retry')}</Button>
        </div>
      ) : recipes?.length === 0 ? (
        <div className="mt-4"><EmptyState title={translate('recipes.empty.title')} description={translate('recipes.empty.description')} /></div>
      ) : (
        <ol aria-label={translate('recipes.list')} className="mt-4 space-y-3">
          {recipes?.map((recipe) => (
            <li key={recipe.id}>
              <RecipeCard
                recipe={recipe}
                scope={scope}
                initialSnapshotReference={
                  initialSnapshotReference?.recipeId === recipe.id
                    ? initialSnapshotReference
                    : null
                }
                onChange={(updated) => setRecipes((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null)}
                onReload={() => setReload((value) => value + 1)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function RecipeCard({
  recipe,
  scope,
  initialSnapshotReference,
  onChange,
  onReload,
}: {
  recipe: Recipe
  scope: Scope
  initialSnapshotReference: SnapshotReference | null
  onChange: (recipe: Recipe) => void
  onReload: () => void
}) {
  const [rename, setRename] = useState(recipe.name)
  const [renaming, setRenaming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [instructions, setInstructions] = useState(recipe.currentRevision.configuration.instructions)
  const [defaults, setDefaults] = useState(JSON.stringify(recipe.currentRevision.configuration.defaultParameters, null, 2))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirmSnapshot, setConfirmSnapshot] = useState(false)
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotReadAttempt, setSnapshotReadAttempt] = useState(0)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [snapshotProjection, setSnapshotProjection] = useState<SnapshotProjection | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const snapshotErrorRef = useRef<HTMLDivElement>(null)
  const snapshotResultRef = useRef<HTMLHeadingElement>(null)
  const snapshotActionRef = useRef<HTMLButtonElement>(null)
  const lock = useRef(false)
  const snapshotLock = useRef(false)

  useEffect(() => {
    if (error) requestAnimationFrame(() => errorRef.current?.focus())
  }, [error])

  useEffect(() => {
    if (snapshotError) requestAnimationFrame(() => snapshotErrorRef.current?.focus())
  }, [snapshotError])

  useEffect(() => {
    if (snapshotProjection) requestAnimationFrame(() => snapshotResultRef.current?.focus())
  }, [snapshotProjection])

  useEffect(() => {
    if (!initialSnapshotReference) return
    const expectedProject = scope.scope === 'project' ? scope.projectId : null
    const referencedProject = initialSnapshotReference.scope.scope === 'project'
      ? initialSnapshotReference.scope.projectId
      : null
    if (
      initialSnapshotReference.recipeId !== recipe.id ||
      initialSnapshotReference.scope.scope !== scope.scope ||
      referencedProject !== expectedProject
    ) return
    const controller = new AbortController()
    setSnapshotLoading(true)
    setSnapshotError(null)
    api.getRecipeJobSnapshot(
      recipe.id,
      initialSnapshotReference.recipeRevision,
      initialSnapshotReference.jobId,
      scope.scope === 'project'
        ? { recipeJobSnapshotVersion: 1, scope: 'project', projectId: scope.projectId }
        : { recipeJobSnapshotVersion: 1, scope: 'projectless' },
      controller.signal,
    ).then(
      (projection) => {
        if (controller.signal.aborted) return
        setSnapshotProjection(projection)
        setSnapshotLoading(false)
      },
      (nextError) => {
        if (controller.signal.aborted) return
        setSnapshotError(errorMessage(nextError))
        setSnapshotLoading(false)
      },
    )
    return () => controller.abort('recipe-snapshot-reference-changed')
  }, [initialSnapshotReference, recipe.id, scope, snapshotReadAttempt])

  const scoped = <T extends object>(body: T) => scope.scope === 'project'
    ? { ...body, scope: 'project' as const, projectId: scope.projectId }
    : { ...body, scope: 'projectless' as const }

  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current || !rename.trim()) return
    lock.current = true
    setRenaming(true)
    setError(null)
    try {
      onChange(await api.renameRecipe(recipe.id, scoped({ recipeVersion: RECIPE_VERSION, name: rename.trim() })))
    } catch (nextError) {
      setError(errorMessage(nextError))
    } finally {
      lock.current = false
      setRenaming(false)
    }
  }

  const revise = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    const parameters = parseDefaults(defaults)
    if (!parameters) {
      setError(translate('recipes.defaults.invalid'))
      return
    }
    lock.current = true
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const configuration = { ...recipe.currentRevision.configuration, instructions, defaultParameters: parameters }
      const updated = await api.reviseRecipe(recipe.id, scoped({
        recipeVersion: RECIPE_VERSION,
        expectedRevision: recipe.currentRevision.revision,
        configuration,
      }))
      onChange(updated)
      setEditing(false)
    } catch (nextError) {
      if (nextError instanceof ApiRequestError && nextError.code === 'recipe_revision_conflict') {
        setConflict(true)
        setError(translate('recipes.conflict'))
      } else {
        setError(errorMessage(nextError))
      }
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  const openSnapshotConfirmation = () => {
    setSnapshotKey(globalThis.crypto.randomUUID())
    setSnapshotError(null)
    setConfirmSnapshot(true)
  }

  const createSnapshot = async () => {
    if (snapshotLock.current || !snapshotKey) return
    snapshotLock.current = true
    setSnapshotLoading(true)
    setSnapshotError(null)
    const revision = recipe.currentRevision.revision
    try {
      const result = await api.createRecipeJobSnapshot(
        recipe.id,
        revision,
        scope.scope === 'project'
          ? {
              recipeJobSnapshotVersion: 1,
              scope: 'project',
              projectId: scope.projectId,
              idempotencyKey: snapshotKey,
            }
          : {
              recipeJobSnapshotVersion: 1,
              scope: 'projectless',
              idempotencyKey: snapshotKey,
            },
      )
      if (
        result.snapshot.recipeId !== recipe.id ||
        result.snapshot.recipeRevision !== revision ||
        result.snapshot.scope !== scope.scope ||
        result.snapshot.projectId !== (scope.scope === 'project' ? scope.projectId : null)
      ) throw new Error(translate('recipes.snapshot.scopeMismatch'))
      setSnapshotProjection(result)
      setConfirmSnapshot(false)
      rememberSnapshotReference({
        recipeId: recipe.id,
        recipeRevision: revision,
        jobId: result.job.id,
        scope,
      })
    } catch (nextError) {
      setSnapshotError(errorMessage(nextError))
    } finally {
      snapshotLock.current = false
      setSnapshotLoading(false)
    }
  }

  const configuration = recipe.currentRevision.configuration
  return (
    <article className="recipe-card surface min-w-0 rounded-lg border border-[var(--border)] p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">{recipe.name}</h3>
          <p className="mt-0.5 text-2xs text-[var(--fg-subtle)]">{recipe.id}</p>
        </div>
        <Badge tone="neutral">{translate('recipes.revision')} {recipe.currentRevision.revision}</Badge>
      </div>
      <dl className="mt-3 grid min-w-0 grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[var(--fg-subtle)]">{translate('recipes.operation.label')}</dt><dd>{translate(`recipes.operation.${configuration.operation}`)}</dd>
        <dt className="text-[var(--fg-subtle)]">{translate('recipes.model.label')}</dt><dd className="break-words">{configuration.model.state === 'explicit' ? configuration.model.reference : translate('recipes.model.none')}</dd>
        <dt className="text-[var(--fg-subtle)]">{translate('recipes.retention')}</dt><dd>{translate(`recipes.retention.${configuration.retention.mode}`)}</dd>
        <dt className="text-[var(--fg-subtle)]">{translate('recipes.provenance')}</dt><dd className="break-all font-mono text-2xs">sha256:{recipe.currentRevision.canonical.sha256} · {recipe.currentRevision.canonical.byteSize} B</dd>
        <dt className="text-[var(--fg-subtle)]">{translate('recipes.updated')}</dt><dd><time dateTime={recipe.updatedAt}>{formatDateTime(recipe.updatedAt)}</time></dd>
      </dl>
      <p className="mt-3 whitespace-pre-wrap break-words text-xs">{configuration.instructions || translate('recipes.instructions.empty')}</p>

      <form className="mt-3 flex min-w-0 flex-wrap items-end gap-2" onSubmit={(event) => void submitRename(event)}>
        <label className="min-w-0 flex-1 text-2xs font-medium">{translate('recipes.rename.label')}<input value={rename} onChange={(event) => setRename(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs" /></label>
        <Button size="sm" type="submit" loading={renaming}>{translate('recipes.rename')}</Button>
      </form>

      <div className="mt-3">
        <Button size="sm" variant="secondary" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{translate('recipes.revise')}</Button>
      </div>
      {editing ? (
        <form className="mt-3 grid gap-2" onSubmit={(event) => void revise(event)}>
          <label className="text-xs font-medium">{translate('recipes.instructions.label')}<textarea rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-2" /></label>
          <label className="text-xs font-medium">{translate('recipes.defaults.label')}<textarea rows={3} value={defaults} onChange={(event) => setDefaults(event.target.value)} spellCheck={false} className="mt-1 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-2 font-mono" /></label>
          <Button className="justify-self-start" size="sm" type="submit" loading={saving}>{translate('recipes.revise.confirm')}</Button>
        </form>
      ) : null}
      {error ? (
        <div ref={errorRef} tabIndex={-1} role="alert" className="mt-3 outline-none">
          <p className="text-xs text-[var(--danger)]">{error}</p>
          {conflict ? <Button className="mt-2" size="sm" onClick={onReload}>{translate('recipes.conflict.reload')}</Button> : null}
        </div>
      ) : null}
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        <Button
          ref={snapshotActionRef}
          size="sm"
          variant="secondary"
          onClick={openSnapshotConfirmation}
          disabled={snapshotLoading}
        >
          {translate('recipes.snapshot.open')}
        </Button>
        {confirmSnapshot ? (
          <div className="mt-2 rounded-md border border-[var(--border-strong)] p-2">
            <p className="text-xs">{translate('recipes.snapshot.confirmation')}</p>
            <p className="mt-1 break-all text-2xs text-[var(--fg-subtle)]">
              {recipe.id} · {translate('recipes.revision')} {recipe.currentRevision.revision}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" loading={snapshotLoading} onClick={() => void createSnapshot()}>
                {translate('recipes.snapshot.confirm')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setConfirmSnapshot(false)
                  setSnapshotKey(null)
                  snapshotActionRef.current?.focus()
                }}
              >
                {translate('recipes.snapshot.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
        {snapshotLoading && !confirmSnapshot ? (
          <p role="status" className="mt-2 text-xs">{translate('recipes.snapshot.loading')}</p>
        ) : null}
        {snapshotError ? (
          <div
            ref={snapshotErrorRef}
            tabIndex={-1}
            role="alert"
            className="mt-2 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--accent)]"
          >
            <p className="break-words text-xs text-[var(--danger)]">{snapshotError}</p>
            {snapshotKey ? (
              <Button className="mt-2" size="sm" onClick={() => void createSnapshot()}>
                {translate('recipes.snapshot.retry')}
              </Button>
            ) : initialSnapshotReference ? (
              <Button
                className="mt-2"
                size="sm"
                onClick={() => setSnapshotReadAttempt((attempt) => attempt + 1)}
              >
                {translate('recipes.snapshot.retryRead')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {snapshotProjection ? (
          <section className="mt-3 rounded-md border border-[var(--border)] p-2" aria-label={translate('recipes.snapshot.result')}>
            <h4
              ref={snapshotResultRef}
              tabIndex={-1}
              className="text-xs font-semibold focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--accent)]"
            >
              {translate('recipes.snapshot.queued')}
            </h4>
            <dl className="mt-2 grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-2 gap-y-1 text-2xs">
              <dt className="text-[var(--fg-subtle)]">{translate('recipes.snapshot.jobId')}</dt>
              <dd className="break-all font-mono">{snapshotProjection.job.id}</dd>
              <dt className="text-[var(--fg-subtle)]">{translate('recipes.revision')}</dt>
              <dd>{snapshotProjection.snapshot.recipeRevision}</dd>
              <dt className="text-[var(--fg-subtle)]">{translate('recipes.provenance')}</dt>
              <dd className="break-all font-mono">sha256:{snapshotProjection.snapshot.canonical.sha256}</dd>
              <dt className="text-[var(--fg-subtle)]">{translate('recipes.snapshot.execution')}</dt>
              <dd>{translate('recipes.snapshot.notImplemented')}</dd>
            </dl>
          </section>
        ) : null}
      </div>
      <p className="mt-3 text-2xs text-[var(--fg-subtle)]">{translate('recipes.noExecution')}</p>
    </article>
  )
}
