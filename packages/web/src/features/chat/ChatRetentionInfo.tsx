import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CHAT_RETENTION_VERSION,
  type ChatRetentionPolicy,
  type ChatRetentionProjection,
} from '@alamo/contract'
import { Button, Callout, Modal, Skeleton, cx } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

type PolicyMode = ChatRetentionPolicy['mode']

export function ChatRetentionInfo({
  chatId,
  chatTitle,
  projectId,
}: {
  chatId: string
  chatTitle: string
  projectId: string | null
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [projection, setProjection] = useState<ChatRetentionProjection | null>(null)
  const [selected, setSelected] = useState<PolicyMode>('ttl')
  const [error, setError] = useState<string | null>(null)
  const [retryKind, setRetryKind] = useState<'load' | 'save' | null>(null)
  const savingRef = useRef(false)
  const retryPolicyRef = useRef<ChatRetentionPolicy | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) requestAnimationFrame(() => errorRef.current?.focus())
  }, [error])

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    setRetryKind(null)
    setProjection(null)
    try {
      const next = await api.getChatRetention(chatId, signal)
      if (next.chatId !== chatId || next.projectId !== projectId) {
        throw new Error(translate('chat.retention.scopeMismatch'))
      }
      setProjection(next)
      setSelected(next.policy.mode)
    } catch (reason) {
      if (signal?.aborted) return
      setError(errorMessage(reason))
      setRetryKind('load')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [chatId, projectId])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort('retention-info-closed')
  }, [open, load])

  const savePolicy = async (policy: ChatRetentionPolicy) => {
    if (savingRef.current || !projection) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    setRetryKind(null)
    try {
      const next = await api.updateChatRetention(chatId, {
        retentionVersion: CHAT_RETENTION_VERSION,
        policy,
      })
      if (next.chatId !== chatId || next.projectId !== projectId) {
        setError(translate('chat.retention.scopeMismatch'))
        setProjection(null)
        retryPolicyRef.current = null
        setRetryKind('load')
        return
      }
      setProjection(next)
      setSelected(next.policy.mode)
      retryPolicyRef.current = null
    } catch (reason) {
      setError(errorMessage(reason))
      retryPolicyRef.current = policy
      setRetryKind('save')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const policy: ChatRetentionPolicy = selected === 'ttl'
      ? { mode: 'ttl', expiresAfterDays: 7 }
      : { mode: selected }
    void savePolicy(policy)
  }

  const retry = () => {
    if (retryKind === 'load') void load()
    if (retryKind === 'save' && retryPolicyRef.current) {
      void savePolicy(retryPolicyRef.current)
    }
  }

  return (
    <>
      <Button ref={triggerRef} size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {translate('chat.retention.open')}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={translate('chat.retention.title')}
        returnFocusRef={triggerRef}
        closeLabel={translate('chat.retention.close')}
        width={520}
      >
        <div className="min-w-0 space-y-4">
          <p className="break-words text-xs text-[var(--fg-muted)]">{chatTitle}</p>
          {loading && !projection ? (
            <div role="status" aria-label={translate('chat.retention.loading')} className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
          {error ? (
            <div ref={errorRef} tabIndex={-1} className="min-w-0 outline-none" role="alert">
              <Callout tone="danger" title={translate('chat.retention.error')}>
                <span className="break-words">{error}</span>
              </Callout>
              {retryKind ? (
                <Button className="mt-2" size="sm" onClick={retry}>
                  {translate('chat.retention.retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {projection ? (
            <form onSubmit={save} className="min-w-0 space-y-4">
              <fieldset disabled={saving || loading}>
                <legend className="mb-2 text-xs font-semibold">
                  {translate('chat.retention.policy')}
                </legend>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                  {(['keep', 'ttl', 'session'] as const).map((mode) => (
                    <label
                      key={mode}
                      className={cx(
                        'flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs',
                        selected === mode
                          ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/55'
                          : 'border-[var(--border)]',
                      )}
                    >
                      <input
                        type="radio"
                        name="chat-retention"
                        value={mode}
                        checked={selected === mode}
                        onChange={() => setSelected(mode)}
                      />
                      <span className="break-words">{translate(`chat.retention.mode.${mode}`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <dl className="grid min-w-0 grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                <dt className="text-[var(--fg-subtle)]">{translate('chat.retention.current')}</dt>
                <dd className="min-w-0 break-words">{translate(`chat.retention.mode.${projection.policy.mode}`)}</dd>
                <dt className="text-[var(--fg-subtle)]">{translate('chat.retention.activity')}</dt>
                <dd className="min-w-0 break-words">
                  <time dateTime={projection.lastUserActivity.at}>
                    {formatDateTime(projection.lastUserActivity.at)}
                  </time>
                  {' · '}
                  {translate(`chat.retention.activity.${projection.lastUserActivity.source}`)}
                </dd>
                <dt className="text-[var(--fg-subtle)]">{translate('chat.retention.expiry')}</dt>
                <dd className="min-w-0 break-words">
                  {projection.expiresAt ? (
                    <time dateTime={projection.expiresAt}>{formatDateTime(projection.expiresAt)}</time>
                  ) : translate('chat.retention.expiry.none')}
                  {' · '}
                  {projection.expirySource === 'server_calculated'
                    ? translate('chat.retention.expiry.server')
                    : translate('chat.retention.expiry.policy')}
                </dd>
              </dl>

              <Callout
                tone={projection.enforcement === 'rolling_ttl_trash' ? 'info' : 'warning'}
                title={translate(
                  projection.enforcement === 'rolling_ttl_trash'
                    ? 'chat.retention.enforced.title'
                    : 'chat.retention.notEnforced.title',
                )}
              >
                {projection.enforcement === 'rolling_ttl_trash'
                  ? translate('chat.retention.enforced.description')
                  : translate('chat.retention.notEnforced.description')}
              </Callout>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={saving} disabled={loading}>
                  {translate('chat.retention.save')}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
