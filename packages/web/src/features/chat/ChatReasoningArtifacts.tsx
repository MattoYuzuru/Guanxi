import { useCallback, useEffect, useRef, useState } from 'react'
import {
  REASONING_ARTIFACT_ENFORCEMENT_VERSION,
  REASONING_ARTIFACT_VERSION,
  type ListReasoningArtifactsQuery,
  type ListReasoningArtifactsResponse,
} from '@guanxi/contract'
import { Button, Callout, Skeleton } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatBytes, formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useAutoRecover } from '../../lib/recover.ts'

/** Quiet re-read period of the open reasoning list. */
export const REASONING_REFRESH_MS = 30_000

function scopeQuery(projectId: string | null): ListReasoningArtifactsQuery {
  return projectId === null
    ? {
        artifactVersion: REASONING_ARTIFACT_VERSION,
        enforcementVersion: REASONING_ARTIFACT_ENFORCEMENT_VERSION,
        scope: 'projectless',
      }
    : {
        artifactVersion: REASONING_ARTIFACT_VERSION,
        enforcementVersion: REASONING_ARTIFACT_ENFORCEMENT_VERSION,
        scope: 'project',
        projectId,
      }
}

export function ChatReasoningArtifacts({
  chatId,
  projectId,
  retentionRevision,
}: {
  chatId: string
  projectId: string | null
  retentionRevision: number
}) {
  const [data, setData] = useState<ListReasoningArtifactsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const actionErrorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) requestAnimationFrame(() => errorRef.current?.focus())
  }, [error])
  useEffect(() => {
    if (actionError) requestAnimationFrame(() => actionErrorRef.current?.focus())
  }, [actionError])

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    // A recovery read keeps the error on screen until it succeeds (D-203).
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      const next = await api.listReasoningArtifacts(chatId, scopeQuery(projectId), signal)
      if (next.chatId !== chatId || next.projectId !== projectId) {
        throw new Error(translate('chat.reasoning.scopeMismatch'))
      }
      setData(next)
      setError(null)
    } catch (reason) {
      if (!signal?.aborted) {
        setData(null)
        setError(errorMessage(reason))
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [chatId, projectId, retentionRevision])

  const recovery = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort('reasoning-info-closed'); recovery.current?.abort('reasoning-info-closed') }
  }, [load])
  // The list stays current by itself (D-203): a quiet re-read on focus and every 30 s while it
  // is open (server cleanup removes artifacts in the background), and a failed read recovers with
  // a growing pause. None of these change loading flags.
  const quietLoad = useCallback(() => {
    recovery.current?.abort('reasoning-recovery-replaced')
    recovery.current = new AbortController()
    void load(recovery.current.signal, true)
  }, [load])
  useAutoRecover(error, quietLoad)
  useEffect(() => {
    const tick = () => { if (document.visibilityState !== 'hidden') quietLoad() }
    const timer = setInterval(tick, REASONING_REFRESH_MS)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [quietLoad])

  const read = async (artifactId: string) => {
    const artifact = await api.getReasoningArtifact(
      chatId,
      artifactId,
      scopeQuery(projectId),
    )
    if (
      artifact.id !== artifactId ||
      artifact.source.chatId !== chatId ||
      artifact.ownership.projectId !== projectId
    ) throw new Error(translate('chat.reasoning.scopeMismatch'))
    return artifact
  }

  const copy = async (artifactId: string) => {
    if (activeArtifactId) return
    setActiveArtifactId(artifactId)
    setActionError(null)
    try {
      const artifact = await read(artifactId)
      await navigator.clipboard.writeText(artifact.content)
    } catch (reason) {
      setActionError(errorMessage(reason))
    } finally {
      setActiveArtifactId(null)
    }
  }

  const exportText = async (artifactId: string) => {
    if (activeArtifactId) return
    setActiveArtifactId(artifactId)
    setActionError(null)
    try {
      const artifact = await read(artifactId)
      const url = URL.createObjectURL(new Blob([artifact.content], { type: 'text/markdown;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = translate('chat.reasoning.exportFilename', { id: artifact.id })
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setActionError(errorMessage(reason))
    } finally {
      setActiveArtifactId(null)
    }
  }

  return (
    <section aria-labelledby="chat-reasoning-title" className="min-w-0 space-y-3 border-t border-divider pt-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="chat-reasoning-title" className="text-sm font-semibold">
            {translate('chat.reasoning.title')}
          </h3>
        </div>
        {data ? (
          <p className="mt-1 break-words text-xs text-secondary">
            {translate('chat.reasoning.cleanupActive')}
          </p>
        ) : null}
      </div>
      {loading && !data ? (
        <div role="status" aria-label={translate('chat.reasoning.loading')} className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {error ? (
        <div ref={errorRef} tabIndex={-1} role="alert" className="outline-none">
          <Callout tone="danger" title={translate('chat.reasoning.error')}>
            <span className="break-words">{error}</span>
            <span className="mt-1 block">{translate('common.recovering')}</span>
          </Callout>
        </div>
      ) : null}
      {actionError ? (
        <div ref={actionErrorRef} tabIndex={-1} role="alert" className="outline-none">
          <Callout tone="danger" title={translate('chat.reasoning.actionError')}>
            <span className="break-words">{actionError}</span>
          </Callout>
        </div>
      ) : null}
      {data ? (
        <div className="min-w-0 space-y-4">
          <div>
            <h4 className="text-xs font-semibold">{translate('chat.reasoning.answers')}</h4>
            {data.generatedAnswers.length === 0 ? (
              <p className="mt-1 text-xs text-secondary">{translate('chat.reasoning.answersEmpty')}</p>
            ) : (
              <ul className="mt-2 space-y-1 text-xs">
                {data.generatedAnswers.map((answer) => (
                  <li key={answer.messageId} className="break-words">
                    <time dateTime={answer.createdAt}>{formatDateTime(answer.createdAt)}</time>
                    {', '}{formatBytes(answer.byteSize)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="text-xs font-semibold">{translate('chat.reasoning.artifacts')}</h4>
            {data.artifacts.length === 0 ? (
              <p className="mt-1 text-xs text-secondary">{translate('chat.reasoning.empty')}</p>
            ) : (
              <ul className="mt-2 min-w-0 space-y-2">
                {data.artifacts.map((artifact) => (
                  <li key={artifact.id} className="min-w-0 rounded-lg border border-divider p-3 text-xs">
                    <p className="break-words font-medium">
                      {translate('chat.reasoning.artifactLabel')}, {formatBytes(artifact.byteSize)}
                    </p>
                    <p className="mt-1 break-all text-secondary">{artifact.checksum}</p>
                    <p className="mt-1 break-words text-secondary">
                      {translate('chat.reasoning.expires')}:{' '}
                      <time dateTime={artifact.retention.effectiveExpiresAt}>
                        {formatDateTime(artifact.retention.effectiveExpiresAt)}
                      </time>
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={activeArtifactId !== null}
                        loading={activeArtifactId === artifact.id}
                        onClick={() => void copy(artifact.id)}
                      >
                        {translate('chat.reasoning.copy')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={activeArtifactId !== null}
                        onClick={() => void exportText(artifact.id)}
                      >
                        {translate('chat.reasoning.export')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
