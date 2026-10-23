import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CHAT_RETENTION_VERSION,
  SESSION_LEAVE_VERSION,
  type ChatRetentionPolicy,
  type ChatRetentionProjection,
  type LeaveSessionChatResponse,
} from '@guanxi/contract'
import { Icon, IconButton } from '@guanxi/ui'
import { Button, Callout, Modal, Skeleton, cx } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useAutoRecover } from '../../lib/recover.ts'
import { ChatReasoningArtifacts } from './ChatReasoningArtifacts.tsx'

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
  const [leaving, setLeaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaveResult, setLeaveResult] = useState<LeaveSessionChatResponse | null>(null)
  const [projection, setProjection] = useState<ChatRetentionProjection | null>(null)
  const [reasoningRevision, setReasoningRevision] = useState(0)
  const [selected, setSelected] = useState<PolicyMode>('ttl')
  const [error, setError] = useState<string | null>(null)
  const [retryKind, setRetryKind] = useState<'load' | 'save' | 'leave' | null>(null)
  const savingRef = useRef(false)
  const leavingRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const confirmLeaveRef = useRef<HTMLButtonElement>(null)
  const leaveTriggerRef = useRef<HTMLButtonElement>(null)
  const leaveResultRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (error) requestAnimationFrame(() => errorRef.current?.focus())
  }, [error])

  useEffect(() => {
    if (leaveResult) requestAnimationFrame(() => leaveResultRef.current?.focus())
  }, [leaveResult])

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    // A recovery read keeps the error on screen until it succeeds (D-203).
    if (!quiet) {
      setLoading(true)
      setError(null)
      setRetryKind(null)
      setProjection(null)
    }
    try {
      const next = await api.getChatRetention(chatId, signal)
      if (next.chatId !== chatId || next.projectId !== projectId) {
        throw new Error(translate('chat.retention.scopeMismatch'))
      }
      setProjection(next)
      setSelected(next.policy.mode)
      setLeaveResult(null)
      setError(null)
      setRetryKind(null)
    } catch (reason) {
      if (signal?.aborted) return
      setError(errorMessage(reason))
      setRetryKind('load')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [chatId, projectId])

  const recovery = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort('retention-info-closed'); recovery.current?.abort('retention-info-closed') }
  }, [open, load])
  // A failed read recovers by itself; a failed save or leave keeps its own button (D-203).
  useAutoRecover(open && retryKind === 'load' ? error : null, () => {
    recovery.current?.abort('retention-recovery-replaced')
    recovery.current = new AbortController()
    void load(recovery.current.signal, true)
  })

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
        setRetryKind('load')
        return
      }
      setProjection(next)
      setSelected(next.policy.mode)
      setReasoningRevision((revision) => revision + 1)
      setConfirmLeave(false)
      setLeaveResult(null)
    } catch (reason) {
      setError(errorMessage(reason))
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


  const openLeaveConfirmation = () => {
    setConfirmLeave(true)
    requestAnimationFrame(() => confirmLeaveRef.current?.focus())
  }

  const cancelLeave = () => {
    setConfirmLeave(false)
    requestAnimationFrame(() => leaveTriggerRef.current?.focus())
  }

  const leaveSession = async () => {
    if (leavingRef.current || projection?.policy.mode !== 'session') return
    leavingRef.current = true
    setLeaving(true)
    setError(null)
    setRetryKind(null)
    try {
      const result = await api.leaveSessionChat(chatId, {
        leaveVersion: SESSION_LEAVE_VERSION,
        chatId,
        scope: projectId === null ? 'projectless' : 'project',
        ...(projectId === null ? {} : { projectId }),
      })
      if (result.chatId !== chatId || result.projectId !== projectId) {
        throw new Error(translate('chat.retention.scopeMismatch'))
      }
      setLeaveResult(result)
      setConfirmLeave(false)
      setProjection((current) => current && result.state !== 'trash'
        ? {
            ...current,
            sessionLeave: {
              at: result.leaveBasis.at,
              source: 'explicit_user_action',
              state: result.state,
              activeJobCount: result.activeJobCount,
            },
          }
        : current)
    } catch (reason) {
      setError(errorMessage(reason))
      setRetryKind('leave')
    } finally {
      leavingRef.current = false
      setLeaving(false)
    }
  }

  return (
    <>
      <IconButton ref={triggerRef} label={translate('chat.retention.open')} icon={<Icon name="info" />} onClick={() => setOpen(true)} />
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={translate('chat.retention.title')}
        returnFocusRef={triggerRef}
        closeLabel={translate('chat.retention.close')}
        dismissable={!confirmLeave && !leaving}
        width={520}
      >
        <div className="min-w-0 space-y-4">
          <p className="break-words text-xs text-secondary">{chatTitle}</p>
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
                {retryKind === 'load' ? <span className="mt-1 block">{translate('common.recovering')}</span> : null}
              </Callout>
            </div>
          ) : null}
          {projection ? (
            <form onSubmit={save} className="min-w-0 space-y-4">
              <fieldset disabled={saving || loading || leaving || confirmLeave}>
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
                          ? 'border-accent bg-accent/5.5'
                          : 'border-divider',
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
                <dt className="text-muted">{translate('chat.retention.current')}</dt>
                <dd className="min-w-0 break-words">{translate(`chat.retention.mode.${projection.policy.mode}`)}</dd>
                <dt className="text-muted">{translate('chat.retention.activity')}</dt>
                <dd className="min-w-0 break-words">
                  <time dateTime={projection.lastUserActivity.at}>
                    {formatDateTime(projection.lastUserActivity.at)}
                  </time>
                  {', '}
                  {translate(`chat.retention.activity.${projection.lastUserActivity.source}`)}
                </dd>
                <dt className="text-muted">{translate('chat.retention.expiry')}</dt>
                <dd className="min-w-0 break-words">
                  {projection.expiresAt ? (
                    <time dateTime={projection.expiresAt}>{formatDateTime(projection.expiresAt)}</time>
                  ) : translate('chat.retention.expiry.none')}
                  {', '}
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
              {projection.sessionLeave && !leaveResult ? (
                <Callout
                  tone="warning"
                  title={translate(`chat.retention.leave.${projection.sessionLeave.state}.title`)}
                >
                  {translate('chat.retention.leave.basis')}:{' '}
                  <time dateTime={projection.sessionLeave.at}>
                    {formatDateTime(projection.sessionLeave.at)}
                  </time>
                </Callout>
              ) : null}
              {leaveResult ? (
                <div
                  ref={leaveResultRef}
                  role="status"
                  tabIndex={-1}
                  className="outline-none"
                >
                  <Callout
                    tone={leaveResult.state === 'trash' ? 'info' : 'warning'}
                    title={translate(`chat.retention.leave.${leaveResult.state}.title`)}
                  >
                    {leaveResult.recoveryDeadline ? (
                      <>
                        {translate('chat.retention.leave.recoverUntil')}:{' '}
                        <time dateTime={leaveResult.recoveryDeadline}>
                          {formatDateTime(leaveResult.recoveryDeadline)}
                        </time>.{' '}
                      </>
                    ) : null}
                    {translate('chat.retention.leave.noHardDelete')}
                  </Callout>
                </div>
              ) : null}
              {projection.policy.mode === 'session' && !projection.sessionLeave && !leaveResult ? (
                confirmLeave ? (
                  <div
                    className="rounded-md border border-warning p-3"
                    role="group"
                    aria-labelledby={`session-leave-confirm-${chatId}`}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && !leaving) {
                        event.preventDefault()
                        event.stopPropagation()
                        cancelLeave()
                      }
                    }}
                  >
                    <p id={`session-leave-confirm-${chatId}`} className="text-xs font-semibold">
                      {translate('chat.retention.leave.confirmTitle')}
                    </p>
                    <p className="mt-1 text-xs text-secondary">
                      {translate('chat.retention.leave.confirmDescription')}
                    </p>
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <Button type="button" size="sm" disabled={leaving} onClick={cancelLeave}>
                        {translate('chat.retention.leave.cancel')}
                      </Button>
                      <Button
                        ref={confirmLeaveRef}
                        type="button"
                        size="sm"
                        variant="primary"
                        loading={leaving}
                        onClick={() => void leaveSession()}
                      >
                        {translate('chat.retention.leave.confirm')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <Button
                      ref={leaveTriggerRef}
                      type="button"
                      variant="secondary"
                      disabled={saving || loading}
                      onClick={openLeaveConfirmation}
                    >
                      {translate('chat.retention.leave.open')}
                    </Button>
                  </div>
                )
              ) : null}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  loading={saving}
                  disabled={loading || leaving || confirmLeave}
                >
                  {translate('chat.retention.save')}
                </Button>
              </div>
            </form>
          ) : null}
          <ChatReasoningArtifacts
            chatId={chatId}
            projectId={projectId}
            retentionRevision={reasoningRevision}
          />
        </div>
      </Modal>
    </>
  )
}
