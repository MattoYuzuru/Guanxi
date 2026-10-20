import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  QUICK_RUN_OPERATIONS,
  QUICK_RUN_VERSION,
  RETENTION_DEFAULT_DAYS,
  RETENTION_POLICY_VERSION,
  type Project,
  type QuickRun,
  type QuickRunOperation,
  type QuickRunScopeQuery,
  type RetentionPolicy,
} from '@guanxi/contract'
import { Badge, Button, Callout, EmptyState, Skeleton } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useAsync } from '../../lib/useAsync.ts'

type ScopeSelection = { scope: 'projectless' } | { scope: 'project'; projectId: string }

function scopeQuery(scope: ScopeSelection): QuickRunScopeQuery {
  return scope.scope === 'project'
    ? { quickRunVersion: QUICK_RUN_VERSION, scope: 'project', projectId: scope.projectId }
    : { quickRunVersion: QUICK_RUN_VERSION, scope: 'projectless' }
}

function matchesScope(quickRun: QuickRun, scope: ScopeSelection): boolean {
  return scope.scope === 'project'
    ? quickRun.scope === 'project' && quickRun.projectId === scope.projectId
    : quickRun.scope === 'projectless' && quickRun.projectId === null
}

function policyFor(mode: RetentionPolicy['mode']): RetentionPolicy {
  return mode === 'ttl'
    ? { mode: 'ttl', expiresAfterDays: RETENTION_DEFAULT_DAYS }
    : { mode }
}

export function QuickRunsPage() {
  const projects = useAsync((signal) => api.listProjects(signal), [])
  const [scope, setScope] = useState<ScopeSelection>({ scope: 'projectless' })
  const selectedScope = scope.scope === 'project' ? scope.projectId : 'projectless'

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 sm:px-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{translate('quickRuns.title')}</h1>
        <p className="mt-1 max-w-2xl text-xs text-[var(--fg-muted)]">
          {translate('quickRuns.description')}
        </p>
      </header>

      <div className="mt-4">
        <Callout tone="warning" title={translate('quickRuns.metadata.title')}>
          {translate('quickRuns.metadata.description')}
        </Callout>
      </div>

      <label className="mt-5 block max-w-md text-xs font-medium">
        {translate('quickRuns.scope.label')}
        <select
          value={selectedScope}
          className="mt-1 h-8 w-full min-w-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2 text-xs text-[var(--fg)]"
          onChange={(event) => {
            const value = event.target.value
            setScope(value === 'projectless'
              ? { scope: 'projectless' }
              : { scope: 'project', projectId: value })
          }}
        >
          <option value="projectless">{translate('quickRuns.scope.projectless')}</option>
          {projects.data?.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>
      {projects.loading ? (
        <p role="status" className="mt-1 text-2xs text-[var(--fg-subtle)]">
          {translate('quickRuns.projects.loading')}
        </p>
      ) : null}
      {projects.error ? (
        <div className="mt-2" role="alert">
          <Callout
            tone="warning"
            title={translate('quickRuns.projects.error')}
            action={<Button size="sm" onClick={projects.reload}>{translate('quickRuns.retry')}</Button>}
          >
            {errorMessage(projects.error)}
          </Callout>
        </div>
      ) : null}

      <QuickRunScopePanel key={selectedScope} scope={scope} projects={projects.data?.projects ?? []} />
    </div>
  )
}

function QuickRunScopePanel({
  scope,
  projects,
}: {
  scope: ScopeSelection
  projects: Project[]
}) {
  const { locale } = useLocale()
  const [quickRuns, setQuickRuns] = useState<QuickRun[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [operation, setOperation] = useState<QuickRunOperation>('complete')
  const [creating, setCreating] = useState(false)
  const [restoreCreateFocus, setRestoreCreateFocus] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const retryPolicies = useRef(new Map<string, RetentionPolicy>())
  const creatingRef = useRef(false)
  const updatingRef = useRef<string | null>(null)
  const errorHeadingRef = useRef<HTMLHeadingElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const actionErrorRefs = useRef(new Map<string, HTMLDivElement>())

  const scopeName = useMemo(() => scope.scope === 'project'
    ? projects.find((project) => project.id === scope.projectId)?.name ?? scope.projectId
    : translate('quickRuns.scope.projectless'), [locale, projects, scope])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    setQuickRuns(null)
    api.listQuickRuns(scopeQuery(scope), controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        const expectedProjectId = scope.scope === 'project' ? scope.projectId : null
        if (
          response.scope !== scope.scope ||
          response.projectId !== expectedProjectId ||
          response.quickRuns.some((quickRun) => !matchesScope(quickRun, scope))
        ) {
          setLoadError(translate('quickRuns.scopeMismatch'))
          setLoading(false)
          return
        }
        setQuickRuns(response.quickRuns)
        setLoading(false)
      },
      (error) => {
        if (controller.signal.aborted) return
        setLoadError(errorMessage(error))
        setLoading(false)
      },
    )
    return () => controller.abort('quick-run-scope-changed')
  }, [reload, scope])

  useEffect(() => {
    if (loadError) requestAnimationFrame(() => errorHeadingRef.current?.focus())
  }, [loadError])

  useEffect(() => {
    if (!creating && restoreCreateFocus) {
      createButtonRef.current?.focus()
      setRestoreCreateFocus(false)
    }
  }, [creating, restoreCreateFocus])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      const created = await api.createQuickRun(scope.scope === 'project'
        ? {
            quickRunVersion: QUICK_RUN_VERSION,
            operation,
            scope: 'project',
            projectId: scope.projectId,
          }
        : { quickRunVersion: QUICK_RUN_VERSION, operation, scope: 'projectless' })
      if (!matchesScope(created, scope)) throw new Error(translate('quickRuns.scopeMismatch'))
      setQuickRuns((current) => [created, ...(current ?? [])])
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      creatingRef.current = false
      setCreating(false)
      setRestoreCreateFocus(true)
    }
  }

  const updateRetention = async (quickRun: QuickRun, policy: RetentionPolicy) => {
    if (updatingRef.current !== null) return
    updatingRef.current = quickRun.id
    setUpdatingId(quickRun.id)
    setActionErrors((current) => {
      const next = { ...current }
      delete next[quickRun.id]
      return next
    })
    try {
      const updated = await api.updateQuickRunRetention(
        quickRun.id,
        scope.scope === 'project'
          ? {
              quickRunVersion: QUICK_RUN_VERSION,
              retentionVersion: RETENTION_POLICY_VERSION,
              scope: 'project',
              projectId: scope.projectId,
              policy,
            }
          : {
              quickRunVersion: QUICK_RUN_VERSION,
              retentionVersion: RETENTION_POLICY_VERSION,
              scope: 'projectless',
              policy,
            },
      )
      if (updated.id !== quickRun.id || !matchesScope(updated, scope)) {
        throw new Error(translate('quickRuns.scopeMismatch'))
      }
      retryPolicies.current.delete(quickRun.id)
      setQuickRuns((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null)
    } catch (error) {
      retryPolicies.current.set(quickRun.id, policy)
      setActionErrors((current) => ({ ...current, [quickRun.id]: errorMessage(error) }))
      requestAnimationFrame(() => actionErrorRefs.current.get(quickRun.id)?.focus())
    } finally {
      updatingRef.current = null
      setUpdatingId(null)
    }
  }

  if (loading) {
    return (
      <div role="status" aria-label={translate('quickRuns.loading')} className="mt-6 space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (loadError || quickRuns === null) {
    return (
      <section className="mt-6" role="alert">
        <h2 ref={errorHeadingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
          {translate('quickRuns.error.title')}
        </h2>
        <p className="mt-1 break-words text-xs text-[var(--fg-muted)]">{loadError}</p>
        <Button className="mt-3" onClick={() => setReload((value) => value + 1)}>
          {translate('quickRuns.retry')}
        </Button>
      </section>
    )
  }

  return (
    <section className="mt-6 min-w-0" aria-labelledby="quick-runs-scope-title">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="quick-runs-scope-title" className="break-words text-sm font-semibold">{scopeName}</h2>
          <p className="text-2xs text-[var(--fg-subtle)]">
            {translate('quickRuns.count').replace('{count}', String(quickRuns.length))}
          </p>
        </div>
        <Badge tone="outline">{translate('quickRuns.ready')}</Badge>
      </div>

      <form onSubmit={create} className="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-xs font-medium">
          {translate('quickRuns.operation.label')}
          <select
            value={operation}
            className="mt-1 h-8 w-full min-w-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2 text-xs text-[var(--fg)]"
            onChange={(event) => setOperation(event.target.value as QuickRunOperation)}
          >
            {QUICK_RUN_OPERATIONS.map((value) => (
              <option key={value} value={value}>
                {translate(`quickRuns.operation.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <Button ref={createButtonRef} type="submit" variant="primary" loading={creating}>
          {translate('quickRuns.create')}
        </Button>
      </form>
      <p className="mt-1 text-2xs text-[var(--fg-subtle)]">{translate('quickRuns.create.hint')}</p>
      {createError ? (
        <p role="alert" className="mt-2 break-words text-xs text-[var(--danger)]">{createError}</p>
      ) : null}

      {quickRuns.length === 0 ? (
        <EmptyState
          title={translate('quickRuns.empty.title')}
          description={translate('quickRuns.empty.description')}
        />
      ) : (
        <ol aria-label={translate('quickRuns.list')} className="mt-4 space-y-3">
          {quickRuns.map((quickRun) => {
            const actionError = actionErrors[quickRun.id]
            return (
              <li key={quickRun.id}>
                <article className="quick-run-card surface min-w-0 rounded-lg border border-[var(--border)] p-3">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="break-words text-xs font-semibold">
                        {translate(`quickRuns.operation.${quickRun.operation}`)}
                      </h3>
                      <p className="mt-1 break-all font-mono text-2xs text-[var(--fg-subtle)]">{quickRun.id}</p>
                    </div>
                    <Badge tone="neutral">{translate('quickRuns.execution.notImplemented')}</Badge>
                  </div>

                  <dl className="mt-3 grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
                    <dt className="text-[var(--fg-subtle)]">{translate('quickRuns.created')}</dt>
                    <dd className="min-w-0 break-words"><time dateTime={quickRun.createdAt}>{formatDateTime(quickRun.createdAt)}</time></dd>
                    <dt className="text-[var(--fg-subtle)]">{translate('quickRuns.retention.source')}</dt>
                    <dd>{translate(`quickRuns.retention.source.${quickRun.retention.policySource}`)}</dd>
                    <dt className="text-[var(--fg-subtle)]">{translate('quickRuns.retention.expiry')}</dt>
                    <dd>{translate('quickRuns.retention.notImplemented')}</dd>
                    <dt className="text-[var(--fg-subtle)]">{translate('quickRuns.retention.cleanup')}</dt>
                    <dd>{translate('quickRuns.retention.notImplemented')}</dd>
                    <dt className="text-[var(--fg-subtle)]">{translate('quickRuns.retention.session')}</dt>
                    <dd>{translate('quickRuns.retention.notImplemented')}</dd>
                  </dl>

                  <fieldset className="mt-3" disabled={updatingId !== null}>
                    <legend className="text-2xs font-medium">{translate('quickRuns.retention.policy')}</legend>
                    <div className="mt-1 flex min-w-0 flex-wrap gap-2">
                      {(['keep', 'ttl', 'session'] as const).map((mode) => (
                        <Button
                          key={mode}
                          size="sm"
                          variant={quickRun.retention.policy.mode === mode ? 'primary' : 'secondary'}
                          aria-pressed={quickRun.retention.policy.mode === mode}
                          loading={updatingId === quickRun.id && quickRun.retention.policy.mode !== mode}
                          onClick={() => void updateRetention(quickRun, policyFor(mode))}
                        >
                          {translate(`quickRuns.retention.mode.${mode}`)}
                        </Button>
                      ))}
                    </div>
                  </fieldset>

                  {actionError ? (
                    <div
                      ref={(node) => {
                        if (node) actionErrorRefs.current.set(quickRun.id, node)
                        else actionErrorRefs.current.delete(quickRun.id)
                      }}
                      tabIndex={-1}
                      role="alert"
                      className="mt-3 outline-none"
                    >
                      <p className="break-words text-2xs text-[var(--danger)]">{actionError}</p>
                      <Button
                        className="mt-1"
                        size="sm"
                        onClick={() => {
                          const policy = retryPolicies.current.get(quickRun.id)
                          if (policy) void updateRetention(quickRun, policy)
                        }}
                      >
                        {translate('quickRuns.retention.retry')}
                      </Button>
                    </div>
                  ) : null}
                </article>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
