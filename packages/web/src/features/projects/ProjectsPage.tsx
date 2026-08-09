import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Project } from '@alamo/contract'
import { Button, Callout, EmptyState, Input, Skeleton } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { translate } from '../../lib/locale.ts'
import { useAsync } from '../../lib/useAsync.ts'

export function ProjectsPage() {
  const projects = useAsync((signal) => api.listProjects(signal), [])
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const errorHeadingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (projects.error && !projects.data) errorHeadingRef.current?.focus()
  }, [projects.error, projects.data])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (creatingRef.current) return
    const normalized = name.trim()
    if (normalized.length === 0) {
      setCreateError(translate('projects.name.required'))
      nameRef.current?.focus()
      return
    }
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      await api.createProject({ name: normalized })
      setName('')
      projects.reload()
      nameRef.current?.focus()
    } catch (error) {
      setCreateError(errorMessage(error))
      nameRef.current?.focus()
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  if (projects.loading) {
    return (
      <div
        role="status"
        aria-label={translate('projects.loading')}
        className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5"
      >
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-5 h-28 w-full" />
      </div>
    )
  }

  if (projects.error && !projects.data) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
        <div role="alert">
          <h1 ref={errorHeadingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
            {translate('projects.error.title')}
          </h1>
          <p className="mt-1 break-words text-xs text-[var(--fg-muted)]">
            {errorMessage(projects.error)}
          </p>
          <Button className="mt-4" variant="primary" onClick={projects.reload}>
            {translate('projects.retry')}
          </Button>
        </div>
      </div>
    )
  }

  const list = projects.data?.projects ?? []

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 sm:px-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{translate('projects.title')}</h1>
        <p className="mt-1 max-w-2xl text-xs text-[var(--fg-muted)]">
          {translate('projects.description')}
        </p>
      </header>

      <form onSubmit={create} className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-xs font-medium">
          {translate('projects.name.label')}
          <Input
            ref={nameRef}
            value={name}
            maxLength={120}
            autoComplete="off"
            aria-describedby={createError ? 'project-create-error' : 'project-name-hint'}
            aria-invalid={createError !== null}
            onChange={(event) => {
              setName(event.target.value)
              if (createError) setCreateError(null)
            }}
            className="mt-1 w-full"
          />
        </label>
        <Button type="submit" variant="primary" loading={creating}>
          {translate('projects.create')}
        </Button>
      </form>
      <p id="project-name-hint" className="mt-1 text-2xs text-[var(--fg-subtle)]">
        {translate('projects.name.hint')}
      </p>
      {createError && (
        <p id="project-create-error" role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {createError}
        </p>
      )}

      {Boolean(projects.error && projects.data) && (
        <div className="mt-4" role="alert">
          <Callout
            tone="warning"
            title={translate('projects.refresh.error')}
            action={<Button size="sm" onClick={projects.reload}>{translate('projects.retry')}</Button>}
          >
            {errorMessage(projects.error)}
          </Callout>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState
          title={translate('projects.empty.title')}
          description={translate('projects.empty.description')}
        />
      ) : (
        <section aria-label={translate('projects.list')} className="mt-6 grid min-w-0 gap-3 sm:grid-cols-2">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} onUpdated={projects.reload} />
          ))}
        </section>
      )}
    </div>
  )
}

function ProjectCard({ project, onUpdated }: { project: Project; onUpdated: () => void }) {
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = name.trim()
    if (savingRef.current || normalized.length === 0 || normalized === project.name) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await api.updateProject(project.id, { name: normalized })
      onUpdated()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <article className="surface min-w-0 rounded-lg border border-[var(--border)] p-3">
      <form onSubmit={rename} className="flex min-w-0 flex-col gap-2">
        <label className="min-w-0 text-2xs text-[var(--fg-subtle)]">
          {translate('projects.name.label')}
          <Input
            value={name}
            maxLength={120}
            aria-label={`${translate('projects.rename')} — ${project.name}`}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-2xs text-[var(--fg-subtle)]">
            {project.filesystemBindings.length === 0
              ? translate('projects.binding.none')
              : translate('projects.binding.present').replace('{count}', String(project.filesystemBindings.length))}
          </span>
          <Button
            type="submit"
            size="sm"
            loading={saving}
            disabled={name.trim().length === 0 || name.trim() === project.name}
          >
            {translate('projects.rename')}
          </Button>
        </div>
        {error && <p role="alert" className="break-words text-2xs text-[var(--danger)]">{error}</p>}
      </form>
    </article>
  )
}
