import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  PROJECT_PRESENTATION_VERSION,
  type ProjectColorToken,
  type ProjectIconKey,
  type ProjectWithPresentation,
} from '@guanxi/contract'
import { Button, Callout, EmptyState, Input, Skeleton } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { translate } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { useAsync } from '../../lib/useAsync.ts'
import { ProjectIcon, projectColorStyle } from './ProjectIcon.tsx'
import { ProjectPresentationPicker } from './ProjectPresentationPicker.tsx'
import { ChatTrashList } from '../chat/ChatTrashList.tsx'

export function ProjectsPage() {
  const projects = useAsync((signal) => api.listProjectsWithPresentation(signal), [])
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
          <p className="mt-1 break-words text-xs text-secondary">
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
        <p className="mt-1 max-w-2xl text-xs text-secondary">
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
      <p id="project-name-hint" className="mt-1 text-2xs text-muted">
        {translate('projects.name.hint')}
      </p>
      {createError && (
        <p id="project-create-error" role="alert" className="mt-2 text-xs text-danger">
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

      <ChatTrashList projectId={null} />

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

function ProjectCard({
  project,
  onUpdated,
}: {
  project: ProjectWithPresentation
  onUpdated: () => void
}) {
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const savingRef = useRef(false)
  const pickerTriggerRef = useRef<HTMLButtonElement>(null)

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

  const closePicker = () => {
    setPickerOpen(false)
    requestAnimationFrame(() => pickerTriggerRef.current?.focus())
  }

  const savePresentation = async (
    iconKey: ProjectIconKey,
    colorToken: ProjectColorToken,
  ) => {
    await api.updateProjectPresentation(project.id, {
      presentationVersion: PROJECT_PRESENTATION_VERSION,
      iconKey,
      colorToken,
    })
    onUpdated()
    closePicker()
  }

  return (
    <article className="surface min-w-0 rounded-lg border border-divider p-3">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <span
          className="project-color-chip flex size-10 shrink-0 items-center justify-center rounded-md border"
          style={projectColorStyle(project.colorToken)}
          aria-hidden="true"
        >
          <ProjectIcon iconKey={project.iconKey} size={22} />
        </span>
        <strong className="min-w-0 flex-1 break-words text-sm">{project.name}</strong>
        <Button
          ref={pickerTriggerRef}
          type="button"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(true)}
        >
          {translate('projects.presentation.edit')}
        </Button>
      </div>
      <form onSubmit={rename} className="flex min-w-0 flex-col gap-2">
        <label className="min-w-0 text-2xs text-muted">
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
          <span className="text-2xs text-muted">
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
        {error && <p role="alert" className="break-words text-2xs text-danger">{error}</p>}
      </form>
      <ProjectChats projectId={project.id} />
      {pickerOpen && (
        <ProjectPresentationPicker
          projectName={project.name}
          initialIconKey={project.iconKey}
          initialColorToken={project.colorToken}
          onClose={closePicker}
          onSave={savePresentation}
        />
      )}
    </article>
  )
}

function ProjectChats({ projectId }: { projectId: string }) {
  const chats = useAsync((signal) => api.listProjectChats(projectId, signal), [projectId])

  return (
    <section aria-label={translate('projects.chats.group')} className="mt-3 min-w-0 border-t border-divider pt-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">{translate('projects.chats.group')}</h3>
        <Link
          to={paths.projectChat(projectId)}
          className="rounded-md border border-control px-2 py-1 text-2xs font-medium text-[var(--accent)] hover:bg-[var(--accent-subtle)]"
        >
          {translate('projects.chats.new')}
        </Link>
      </div>
      {chats.loading ? (
        <p role="status" className="mt-2 text-2xs text-muted">
          {translate('projects.chats.loading')}
        </p>
      ) : chats.error ? (
        <div className="mt-2" role="alert">
          <p className="break-words text-2xs text-danger">
            {translate('projects.chats.error')}: {errorMessage(chats.error)}
          </p>
          <Button className="mt-1" size="sm" onClick={chats.reload}>
            {translate('projects.retry')}
          </Button>
        </div>
      ) : (chats.data?.chats.length ?? 0) === 0 ? (
        <p className="mt-2 text-2xs text-muted">{translate('projects.chats.empty')}</p>
      ) : (
        <ol className="mt-2 space-y-1">
          {chats.data?.chats.map((chat) => (
            <li key={chat.id}>
              <Link
                to={paths.projectChat(projectId, chat.id)}
                className="block min-w-0 rounded px-2 py-1 text-xs hover:bg-inset"
              >
                <span className="block truncate font-medium">{chat.title}</span>
                <span className="text-2xs text-muted">
                  {translate('projects.chats.messageCount').replace('{count}', String(chat.messageCount))}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <ChatTrashList projectId={projectId} onRestored={chats.reload} />
    </section>
  )
}
