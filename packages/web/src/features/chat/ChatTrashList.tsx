import { useEffect, useRef, useState } from 'react'
import {
  CHAT_DELETION_VERSION,
  CHAT_LIFECYCLE_VERSION,
  type ChatTrashItem,
} from '@guanxi/contract'
import { Button, Callout } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useAsync } from '../../lib/useAsync.ts'

/** Quiet re-read period of a mounted Trash list. */
export const TRASH_REFRESH_MS = 30_000

export function ChatTrashList({
  projectId,
  onRestored,
}: {
  projectId: string | null
  onRestored?: () => void
}) {
  const trash = useAsync(
    (signal) => api.listChatTrash(
      projectId === null
        ? {
            lifecycleVersion: CHAT_LIFECYCLE_VERSION,
            deletionVersion: CHAT_DELETION_VERSION,
            scope: 'projectless',
            limit: 20,
          }
        : {
            lifecycleVersion: CHAT_LIFECYCLE_VERSION,
            deletionVersion: CHAT_DELETION_VERSION,
            scope: 'project',
            projectId,
            limit: 20,
          },
      signal,
    ),
    [projectId],
    // Stays current by itself (D-203): a quiet re-read on focus and on an interval, so a pending
    // hard deletion's outcome appears without a Refresh button.
    { revalidate: { onFocus: true, intervalMs: TRASH_REFRESH_MS } },
  )
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoredIds, setRestoredIds] = useState<ReadonlySet<string>>(() => new Set())
  const restoringRef = useRef(false)
  const sectionRef = useRef<HTMLElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const listErrorRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (restoreError) requestAnimationFrame(() => errorRef.current?.focus())
  }, [restoreError])

  // When the list recovers while its error had focus, focus returns to the heading.
  const errorHadFocus = useRef(false)
  useEffect(() => {
    if (!trash.error) return
    requestAnimationFrame(() => {
      const activeElement = document.activeElement
      if (
        activeElement === null ||
        activeElement === document.body ||
        sectionRef.current?.contains(activeElement)
      ) {
        listErrorRef.current?.focus()
        errorHadFocus.current = true
      }
    })
  }, [trash.error])

  useEffect(() => {
    if (!trash.data || trash.error) return
    if (errorHadFocus.current) {
      errorHadFocus.current = false
      requestAnimationFrame(() => headingRef.current?.focus())
    }
    const visibleIds = new Set(trash.data.chats.map(({ chatId }) => chatId))
    setRestoredIds((current) => {
      const unresolved = new Set([...current].filter((chatId) => visibleIds.has(chatId)))
      return unresolved.size === current.size ? current : unresolved
    })
  }, [trash.data, trash.error])

  const restore = async (chat: ChatTrashItem) => {
    if (restoringRef.current) return
    restoringRef.current = true
    setRestoringId(chat.chatId)
    setRestoreError(null)
    try {
      const result = await api.restoreChat(chat.chatId, {
        lifecycleVersion: CHAT_LIFECYCLE_VERSION,
      })
      if (result.chatId !== chat.chatId || result.projectId !== projectId) {
        throw new Error(translate('chat.trash.scopeMismatch'))
      }
      setRestoredIds((current) => new Set(current).add(chat.chatId))
      trash.reload()
      onRestored?.()
      requestAnimationFrame(() => headingRef.current?.focus())
    } catch (error) {
      setRestoreError(errorMessage(error))
    } finally {
      restoringRef.current = false
      setRestoringId(null)
    }
  }

  const chats = (trash.data?.chats ?? []).filter((chat) => !restoredIds.has(chat.chatId))
  const deletionPending = chats.some(
    (chat) => chat.reason === 'session_left' && chat.hardDeletion.state === 'pending_maintenance',
  )

  return (
    <section
      ref={sectionRef}
      aria-label={translate('chat.trash.title')}
      className="chat-trash-region mt-3 min-w-0 border-t border-divider pt-3"
    >
      <h3 ref={headingRef} tabIndex={-1} className="text-xs font-semibold outline-none">
        {translate('chat.trash.title')}
      </h3>
      <p className="mt-1 break-words text-2xs text-muted">
        {translate('chat.trash.hardDeletion')}
      </p>
      {trash.loading && !trash.data ? (
        <p role="status" className="mt-2 text-2xs text-muted">
          {translate('chat.trash.loading')}
        </p>
      ) : null}
      {trash.error ? (
        <div ref={listErrorRef} tabIndex={-1} className="mt-2 outline-none" role="alert">
          <p className="break-words text-2xs text-danger">
            {translate('chat.trash.loadError')}: {errorMessage(trash.error)}
          </p>
          <p className="mt-1 text-12 text-muted">{translate('common.recovering')}</p>
        </div>
      ) : null}
      {restoreError ? (
        <div ref={errorRef} tabIndex={-1} className="mt-2 outline-none" role="alert">
          <Callout tone="danger" title={translate('chat.trash.restoreError')}>
            <span className="break-words">{restoreError}</span>
          </Callout>
        </div>
      ) : null}
      {!trash.loading && !trash.error && chats.length === 0 ? (
        <p className="mt-2 text-2xs text-muted">
          {translate('chat.trash.empty')}
        </p>
      ) : null}
      {chats.length > 0 ? (
        <ol className="mt-2 min-w-0 space-y-2">
          {chats.map((chat) => (
            <li
              key={chat.chatId}
              className="chat-trash-item min-w-0 rounded-md border border-divider p-2 text-2xs"
            >
              <strong className="block min-w-0 break-words text-xs">{chat.title}</strong>
              <span className="mt-1 block break-words text-muted">
                {translate(`chat.trash.reason.${chat.reason}`)},{' '}
                <time dateTime={chat.tombstonedAt}>{formatDateTime(chat.tombstonedAt)}</time>
              </span>
              <span className="block break-words text-muted">
                {translate('chat.trash.activity')}:{' '}
                <time dateTime={chat.activityBasis.at}>{formatDateTime(chat.activityBasis.at)}</time>
                {', '}{translate(`chat.retention.activity.${chat.activityBasis.source}`)}
              </span>
              {chat.reason === 'session_left' ? (
                <>
                  <span className="block break-words text-muted">
                    {translate('chat.trash.recoveryDeadline')}:{' '}
                    <time dateTime={chat.recovery.deadline}>
                      {formatDateTime(chat.recovery.deadline)}
                    </time>
                    {', '}{translate(`chat.trash.recovery.${chat.recovery.state}`)}
                  </span>
                  <span className="block break-words text-muted">
                    {translate(`chat.trash.deletion.${chat.hardDeletion.state}`)}
                    {', '}{translate('chat.trash.noBlobGc')}
                  </span>
                </>
              ) : null}
              <Button
                className="mt-2"
                size="sm"
                loading={restoringId === chat.chatId}
                disabled={restoringId !== null || (chat.reason === 'session_left' && chat.recovery.state === 'grace_elapsed')}
                onClick={() => void restore(chat)}
              >
                {translate('chat.trash.restore')}
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {deletionPending ? (
        <p role="status" className="mt-2 text-12 text-muted">{translate('chat.trash.watchingDeletion')}</p>
      ) : null}
      {(trash.data?.deletions?.length ?? 0) > 0 ? (
        <div className="mt-3" aria-live="polite">
          <h4 className="text-2xs font-semibold">{translate('chat.trash.deleted.title')}</h4>
          <ol className="mt-1 min-w-0 space-y-1">
            {(trash.data?.deletions ?? []).map((deletion) => (
              <li key={deletion.chatId} className="min-w-0 break-words text-2xs text-muted">
                {translate('chat.trash.deleted.item')},{' '}
                <time dateTime={deletion.deletedAt}>{formatDateTime(deletion.deletedAt)}</time>
                {', '}{translate('chat.trash.noBlobGc')}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {trash.data?.hasMore ? (
        <p className="mt-2 text-2xs text-muted">
          {translate('chat.trash.bounded')}
        </p>
      ) : null}
      {trash.data?.deletionsHaveMore ? (
        <p className="mt-2 text-2xs text-muted">
          {translate('chat.trash.deleted.bounded')}
        </p>
      ) : null}
    </section>
  )
}
