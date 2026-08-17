import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import {
  attachmentDisplayNameSchema,
  type ArtifactScope,
  type ArtifactTransferPolicy,
  type Attachment,
  type Project,
} from '@alamo/contract'
import { Badge, Button, Callout, EmptyState, Skeleton, cx } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatBytes, formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useAsync } from '../../lib/useAsync.ts'

const ATTACHMENT_LIST_LIMIT = 50

interface UploadIntent {
  key: string
  file: File
}

function newIntent(file: File): UploadIntent {
  return { key: crypto.randomUUID(), file }
}

function matchesScope(attachment: Attachment, scope: ArtifactScope): boolean {
  return scope.scope === 'project'
    ? attachment.artifact.ownership.scope === 'project'
      && attachment.artifact.ownership.projectId === scope.projectId
    : attachment.artifact.ownership.scope === 'projectless'
}

export function AttachmentsPage() {
  const projects = useAsync((signal) => api.listProjects(signal), [])
  const policy = useAsync((signal) => api.artifactTransferPolicy(signal), [])
  const [scope, setScope] = useState<ArtifactScope>({ scope: 'projectless' })
  const selectedScope = scope.scope === 'project' ? scope.projectId : 'projectless'

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 sm:px-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{translate('attachments.title')}</h1>
        <p className="mt-1 max-w-2xl text-xs text-[var(--fg-muted)]">
          {translate('attachments.description')}
        </p>
      </header>

      <div className="mt-4">
        <Callout tone="warning" title={translate('attachments.boundary.title')}>
          {translate('attachments.boundary.description')}
        </Callout>
      </div>

      <PolicyProjection policy={policy.data ?? null} loading={policy.loading} error={policy.error} onRetry={policy.reload} />

      <label className="mt-5 block max-w-md text-xs font-medium">
        {translate('attachments.scope.label')}
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
          <option value="projectless">{translate('attachments.scope.projectless')}</option>
          {projects.data?.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>
      {projects.loading ? (
        <p role="status" className="mt-1 text-2xs text-[var(--fg-subtle)]">
          {translate('attachments.projects.loading')}
        </p>
      ) : null}
      {projects.error ? (
        <div className="mt-2" role="alert">
          <Callout
            tone="warning"
            title={translate('attachments.projects.error')}
            action={<Button size="sm" onClick={projects.reload}>{translate('attachments.retry')}</Button>}
          >
            {errorMessage(projects.error)}
          </Callout>
        </div>
      ) : null}

      <AttachmentScopePanel
        key={selectedScope}
        scope={scope}
        projects={projects.data?.projects ?? []}
        policy={policy.data ?? null}
      />
    </div>
  )
}

function PolicyProjection({
  policy,
  loading,
  error,
  onRetry,
}: {
  policy: ArtifactTransferPolicy | null
  loading: boolean
  error: unknown
  onRetry(): void
}) {
  if (loading) {
    return <p role="status" className="mt-4 text-xs">{translate('attachments.policy.loading')}</p>
  }
  if (error || policy === null) {
    return (
      <div role="alert" className="mt-4">
        <Callout
          tone="warning"
          title={translate('attachments.policy.error')}
          action={<Button size="sm" onClick={onRetry}>{translate('attachments.retry')}</Button>}
        >
          {errorMessage(error)}
        </Callout>
      </div>
    )
  }
  if (policy.state !== 'enabled') {
    return (
      <div role="status" className="mt-4">
        <Callout tone="warning" title={translate('attachments.policy.unavailable')}>
          {translate(`attachments.policy.reason.${policy.reason}`)}
        </Callout>
      </div>
    )
  }
  return (
    <section className="surface mt-4 rounded-lg border border-[var(--border)] p-3" aria-label={translate('attachments.policy.title')}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold">{translate('attachments.policy.title')}</h2>
        <Badge tone="outline">{formatBytes(policy.maxBytes)}</Badge>
      </div>
      <p className="mt-1 break-words text-2xs text-[var(--fg-subtle)]">
        {translate('attachments.policy.detail')
          .replace('{source}', translate(`attachments.policy.source.${policy.source}`))
          .replace('{observedAt}', formatDateTime(policy.observedAt))
          .replace('{active}', String(policy.maxActiveTransfers))}
      </p>
      <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
        {translate('attachments.policy.notCapability')}
      </p>
    </section>
  )
}

function AttachmentScopePanel({
  scope,
  projects,
  policy,
}: {
  scope: ArtifactScope
  projects: Project[]
  policy: ArtifactTransferPolicy | null
}) {
  const { locale } = useLocale()
  const [attachments, setAttachments] = useState<Attachment[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [intent, setIntent] = useState<UploadIntent | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)
  const uploadingRef = useRef(false)
  const uploadButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listErrorRef = useRef<HTMLHeadingElement>(null)
  const uploadErrorRef = useRef<HTMLDivElement>(null)
  const downloadingRef = useRef<string | null>(null)
  const downloadErrorRefs = useRef(new Map<string, HTMLDivElement>())

  const scopeName = useMemo(() => scope.scope === 'project'
    ? projects.find((project) => project.id === scope.projectId)?.name ?? scope.projectId
    : translate('attachments.scope.projectless'), [locale, projects, scope])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    setAttachments(null)
    api.listAttachments(scope, ATTACHMENT_LIST_LIMIT, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        const expectedProject = scope.scope === 'project' ? scope.projectId : null
        if (
          response.scope !== scope.scope
          || response.projectId !== expectedProject
          || response.attachments.some((attachment) => !matchesScope(attachment, scope))
        ) {
          setLoadError(translate('attachments.scopeMismatch'))
        } else {
          setAttachments(response.attachments)
          setTruncated(response.truncated)
        }
        setLoading(false)
      },
      (cause) => {
        if (controller.signal.aborted) return
        setLoadError(errorMessage(cause))
        setLoading(false)
      },
    )
    return () => controller.abort('attachment-scope-changed')
  }, [reload, scope])

  useEffect(() => () => abortRef.current?.abort('attachment-page-unmounted'), [])
  useEffect(() => {
    if (loadError) requestAnimationFrame(() => listErrorRef.current?.focus())
  }, [loadError])

  const choose = (file: File | undefined) => {
    if (!file) return
    setUploadError(null)
    if (policy?.state !== 'enabled') {
      setUploadError(translate('attachments.policy.unavailable'))
      return
    }
    if (!attachmentDisplayNameSchema.safeParse(file.name).success) {
      setUploadError(translate('attachments.file.nameInvalid'))
      return
    }
    if (file.size > policy.maxBytes) {
      setUploadError(
        translate('attachments.file.tooLarge').replace('{maxBytes}', formatBytes(policy.maxBytes)),
      )
      return
    }
    setIntent(newIntent(file))
  }

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    choose(event.target.files?.[0])
    event.target.value = ''
  }

  const startUpload = async () => {
    if (!intent || uploadingRef.current || policy?.state !== 'enabled') return
    const controller = new AbortController()
    abortRef.current = controller
    uploadingRef.current = true
    setUploading(true)
    setUploadError(null)
    try {
      const attachment = await api.uploadAttachment(
        scope,
        intent.file,
        intent.key,
        controller.signal,
      )
      if (!matchesScope(attachment, scope)) throw new Error(translate('attachments.scopeMismatch'))
      setAttachments((current) => {
        const withoutDuplicate = (current ?? []).filter(
          (item) => item.artifact.id !== attachment.artifact.id,
        )
        return [attachment, ...withoutDuplicate].slice(0, ATTACHMENT_LIST_LIMIT)
      })
      setIntent(null)
    } catch (cause) {
      if (controller.signal.aborted) setUploadError(translate('attachments.upload.cancelled'))
      else setUploadError(errorMessage(cause))
      requestAnimationFrame(() => uploadErrorRef.current?.focus())
    } finally {
      abortRef.current = null
      uploadingRef.current = false
      setUploading(false)
      requestAnimationFrame(() => {
        if (uploadButtonRef.current) uploadButtonRef.current.focus()
        else fileInputRef.current?.focus()
      })
    }
  }

  const download = async (attachment: Attachment) => {
    if (downloadingRef.current !== null) return
    downloadingRef.current = attachment.artifact.id
    setDownloadingId(attachment.artifact.id)
    setDownloadErrors((current) => {
      const next = { ...current }
      delete next[attachment.artifact.id]
      return next
    })
    try {
      const blob = await api.downloadAttachment(attachment.artifact.id, scope)
      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = attachment.displayName
        anchor.click()
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (cause) {
      setDownloadErrors((current) => ({
        ...current,
        [attachment.artifact.id]: errorMessage(cause),
      }))
      requestAnimationFrame(() => downloadErrorRefs.current.get(attachment.artifact.id)?.focus())
    } finally {
      downloadingRef.current = null
      setDownloadingId(null)
    }
  }

  if (loading) {
    return (
      <div role="status" aria-label={translate('attachments.loading')} className="mt-6 space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (loadError || attachments === null) {
    return (
      <section className="mt-6" role="alert">
        <h2 ref={listErrorRef} tabIndex={-1} className="text-sm font-semibold outline-none">
          {translate('attachments.error.title')}
        </h2>
        <p className="mt-1 break-words text-xs text-[var(--fg-muted)]">{loadError}</p>
        <Button className="mt-3" onClick={() => setReload((value) => value + 1)}>
          {translate('attachments.retry')}
        </Button>
      </section>
    )
  }

  const enabled = policy?.state === 'enabled'
  return (
    <section className="mt-6 min-w-0" aria-labelledby="attachment-scope-title">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="attachment-scope-title" className="break-words text-sm font-semibold">{scopeName}</h2>
          <p className="text-2xs text-[var(--fg-subtle)]">
            {translate('attachments.count').replace('{count}', String(attachments.length))}
          </p>
        </div>
        <Badge tone="outline">{translate('attachments.scope.exact')}</Badge>
      </div>

      <div
        className={cx(
          'attachment-drop mt-4 rounded-lg border border-dashed p-4',
          dropActive ? 'border-[var(--accent)] bg-[var(--accent-subtle)]' : 'border-[var(--border-strong)]',
        )}
        onDragEnter={(event) => { event.preventDefault(); setDropActive(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault()
          setDropActive(false)
          choose(event.dataTransfer.files[0])
        }}
      >
        <label className="block text-xs font-medium">
          {translate('attachments.file.label')}
          <input
            type="file"
            ref={fileInputRef}
            disabled={!enabled || uploading}
            onChange={onFile}
            className="mt-2 block w-full min-w-0 text-xs file:mr-2 file:rounded-md file:border file:border-[var(--border-strong)] file:bg-[var(--bg-raised)] file:px-3 file:py-1.5 file:text-xs"
          />
        </label>
        <p className="mt-2 text-2xs text-[var(--fg-subtle)]">
          {enabled
            ? translate('attachments.file.hint').replace('{maxBytes}', formatBytes(policy.maxBytes))
            : translate('attachments.policy.unavailable')}
        </p>
        {intent ? (
          <div className="mt-3 min-w-0">
            <p className="break-words text-xs">
              {intent.file.name} · {formatBytes(intent.file.size)}
            </p>
            {uploading ? (
              <progress
                aria-label={translate('attachments.upload.progress')}
                className="mt-2 h-2 w-full max-w-md"
              />
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                ref={uploadButtonRef}
                variant="primary"
                disabled={!enabled || uploading}
                loading={uploading}
                onClick={() => void startUpload()}
              >
                {uploading
                  ? translate('attachments.upload.uploading')
                  : uploadError
                    ? translate('attachments.upload.retry')
                    : translate('attachments.upload.start')}
              </Button>
              {uploading ? (
                <Button onClick={() => abortRef.current?.abort('user-cancelled')}>
                  {translate('attachments.upload.cancel')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {uploadError ? (
          <div ref={uploadErrorRef} tabIndex={-1} role="alert" className="mt-3 outline-none">
            <p className="break-words text-xs text-[var(--danger)]">{uploadError}</p>
          </div>
        ) : null}
      </div>

      {attachments.length === 0 ? (
        <EmptyState
          title={translate('attachments.empty.title')}
          description={translate('attachments.empty.description')}
        />
      ) : (
        <ol aria-label={translate('attachments.list')} className="mt-4 space-y-3">
          {attachments.map((attachment) => (
            <li key={attachment.artifact.id}>
              <article className="attachment-card surface min-w-0 rounded-lg border border-[var(--border)] p-3">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-xs font-semibold">{attachment.displayName}</h3>
                    <p className="mt-1 break-all font-mono text-2xs text-[var(--fg-subtle)]">
                      {attachment.artifact.id}
                    </p>
                  </div>
                  <Button
                    className="shrink-0"
                    loading={downloadingId === attachment.artifact.id}
                    disabled={downloadingId !== null}
                    onClick={() => void download(attachment)}
                  >
                    {translate('attachments.download')}
                  </Button>
                </div>
                <dl className="mt-3 grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
                  <dt className="text-[var(--fg-subtle)]">{translate('attachments.mediaType')}</dt>
                  <dd className="break-words">{attachment.artifact.mediaType}</dd>
                  <dt className="text-[var(--fg-subtle)]">{translate('attachments.size')}</dt>
                  <dd>{formatBytes(attachment.artifact.byteSize)}</dd>
                  <dt className="text-[var(--fg-subtle)]">{translate('attachments.created')}</dt>
                  <dd><time dateTime={attachment.artifact.createdAt}>{formatDateTime(attachment.artifact.createdAt)}</time></dd>
                  <dt className="text-[var(--fg-subtle)]">{translate('attachments.checksum')}</dt>
                  <dd className="break-all font-mono">{attachment.artifact.checksum}</dd>
                </dl>
                <p className="mt-3 text-2xs text-[var(--fg-muted)]">
                  {translate('attachments.notInContext')}
                </p>
                {downloadErrors[attachment.artifact.id] ? (
                  <div
                    ref={(node) => {
                      if (node) downloadErrorRefs.current.set(attachment.artifact.id, node)
                      else downloadErrorRefs.current.delete(attachment.artifact.id)
                    }}
                    tabIndex={-1}
                    role="alert"
                    className="mt-2 outline-none"
                  >
                    <p className="break-words text-2xs text-[var(--danger)]">
                      {downloadErrors[attachment.artifact.id]}
                    </p>
                    <Button size="sm" className="mt-1" onClick={() => void download(attachment)}>
                      {translate('attachments.download.retry')}
                    </Button>
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      )}
      {truncated ? (
        <p role="status" className="mt-3 text-2xs text-[var(--fg-subtle)]">
          {translate('attachments.truncated').replace('{limit}', String(ATTACHMENT_LIST_LIMIT))}
        </p>
      ) : null}
    </section>
  )
}
