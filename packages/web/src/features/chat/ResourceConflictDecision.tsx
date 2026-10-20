import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type {
  Job,
  RuntimeAdmissionPriority,
  RuntimeResourceOperation,
  RuntimeResourceOwner,
  RuntimeSnapshot,
} from '@guanxi/contract'
import { Button, Modal, Spinner } from '../../components/ui.tsx'
import { ApiRequestError, api } from '../../lib/api.ts'
import { formatContextLength, formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useRuntimeProjection } from '../health/RuntimeContext.tsx'

const CANCELLATION_POLL_INTERVAL_MS = 250
const CANCELLATION_MAX_READS = 20
const RUNTIME_DECISION_TIMEOUT_MS = 5_000
const STOP_ACTION_TIMEOUT_MS = 10_000

export type ChatSendIntent = {
  content: string
  idempotencyKey: string
  onAccepted: () => void
  onRejected: () => void
}

export type ChatIntentDispatcher = (
  intent: ChatSendIntent,
  callbacks: { onAccepted: () => void; onCommandError: () => void },
) => void

type DecisionAction = 'idle' | 'verifying' | 'cancelling' | 'acknowledging' | 'dispatching'
type DecisionError =
  | 'runtime_unavailable'
  | 'owner_changed'
  | 'job_unavailable'
  | 'cancel_conflict'
  | 'cancel_failed'
  | 'cancel_timeout'
  | 'dispatch_failed'
  | null

type ConflictDecision = {
  intent: ChatSendIntent
  snapshot: RuntimeSnapshot
  sampleState: 'fresh' | 'stale' | 'updated'
  expectedJobId: string | null
  action: DecisionAction
  error: DecisionError
}

export function useResourceConflictDecision(dispatch: ChatIntentDispatcher) {
  const runtime = useRuntimeProjection()
  const [decision, setDecision] = useState<ConflictDecision | null>(null)
  const decisionRef = useRef<ConflictDecision | null>(null)
  const readAbortRef = useRef<AbortController | null>(null)
  const requestPendingRef = useRef(false)
  const dispatchPendingRef = useRef(false)

  decisionRef.current = decision

  const updateDecision = useCallback(
    (update: (current: ConflictDecision) => ConflictDecision) => {
      setDecision((current) => (current ? update(current) : current))
    },
    [],
  )

  const dispatchIntent = useCallback(
    (intent: ChatSendIntent, keepDialog: boolean) => {
      if (dispatchPendingRef.current) return
      dispatchPendingRef.current = true
      if (keepDialog) {
        updateDecision((current) => ({ ...current, action: 'dispatching', error: null }))
      }

      dispatch(intent, {
        onAccepted: () => {
          dispatchPendingRef.current = false
          if (keepDialog) setDecision(null)
          intent.onAccepted()
        },
        onCommandError: () => {
          dispatchPendingRef.current = false
          if (keepDialog) {
            updateDecision((current) => ({
              ...current,
              action: 'idle',
              error: 'dispatch_failed',
            }))
          }
          intent.onRejected()
        },
      })
    },
    [dispatch, updateDecision],
  )

  const request = useCallback(
    async (intent: ChatSendIntent): Promise<'conflict' | 'dispatched' | 'ignored'> => {
      if (requestPendingRef.current || decisionRef.current || dispatchPendingRef.current) {
        return 'ignored'
      }
      requestPendingRef.current = true
      const bounded = createBoundedController(RUNTIME_DECISION_TIMEOUT_MS)
      const { controller } = bounded
      readAbortRef.current = controller

      try {
        const snapshot = await runtime.refresh(controller.signal, true)
        if (controller.signal.aborted) return 'ignored'
        if (!hasConservativeConflict(snapshot)) {
          dispatchIntent(intent, false)
          return 'dispatched'
        }
        setDecision(createDecision(intent, snapshot, 'fresh'))
        return 'conflict'
      } catch (error) {
        if (isAbort(error, controller.signal) && !bounded.timedOut()) return 'ignored'
        const lastConfirmed = runtime.data
        if (lastConfirmed && hasConservativeConflict(lastConfirmed)) {
          setDecision(createDecision(intent, lastConfirmed, 'stale'))
          return 'conflict'
        }
        // The server Governor remains the canonical admission owner. If no
        // conflict was observed, the ordinary command is the safe queue path.
        dispatchIntent(intent, false)
        return 'dispatched'
      } finally {
        bounded.cleanup()
        requestPendingRef.current = false
        if (readAbortRef.current === controller) readAbortRef.current = null
      }
    },
    [dispatchIntent, runtime],
  )

  const close = useCallback(() => {
    readAbortRef.current?.abort()
    readAbortRef.current = null
    setDecision(null)
  }, [])

  const queue = useCallback(() => {
    const current = decisionRef.current
    if (!current || current.action !== 'idle') return
    dispatchIntent(current.intent, true)
  }, [dispatchIntent])

  const stopAndSwitch = useCallback(async () => {
    const initial = decisionRef.current
    if (
      !initial ||
      initial.action !== 'idle' ||
      initial.sampleState === 'stale' ||
      !initial.expectedJobId
    ) {
      return
    }

    const bounded = createBoundedController(STOP_ACTION_TIMEOUT_MS)
    const { controller } = bounded
    let stopPhase: 'runtime' | 'job' | 'cancel' | 'acknowledgement' = 'runtime'
    readAbortRef.current = controller
    updateDecision((current) => ({ ...current, action: 'verifying', error: null }))

    try {
      const fresh = await runtime.refresh(controller.signal, true)
      if (controller.signal.aborted) return
      const active = normalActiveLease(fresh)

      if (!active) {
        dispatchIntent(initial.intent, true)
        return
      }
      if (
        active.owner.kind !== 'job' ||
        active.owner.jobId !== initial.expectedJobId
      ) {
        setDecision((current) =>
          current
            ? {
                ...current,
                snapshot: fresh,
                sampleState: 'updated',
                action: 'idle',
                error: 'owner_changed',
              }
            : current,
        )
        return
      }

      let job: Job
      stopPhase = 'job'
      try {
        job = (await api.getJob(initial.expectedJobId, controller.signal)).job
      } catch (error) {
        if (isAbort(error, controller.signal) && !bounded.timedOut()) return
        updateDecision((current) => ({
          ...current,
          snapshot: fresh,
          action: 'idle',
          error: 'job_unavailable',
        }))
        return
      }

      if (isTerminal(job)) {
        dispatchIntent(initial.intent, true)
        return
      }

      updateDecision((current) => ({ ...current, action: 'cancelling', error: null }))
      stopPhase = 'cancel'
      try {
        job = (await api.cancelJob(initial.expectedJobId, controller.signal)).job
      } catch (error) {
        if (isAbort(error, controller.signal) && !bounded.timedOut()) return
        updateDecision((current) => ({
          ...current,
          action: 'idle',
          error:
            error instanceof ApiRequestError && (error.status === 404 || error.status === 409)
              ? 'cancel_conflict'
              : 'cancel_failed',
        }))
        return
      }

      if (!isTerminal(job)) {
        if (job.status !== 'cancelling') {
          updateDecision((current) => ({
            ...current,
            action: 'idle',
            error: 'cancel_conflict',
          }))
          return
        }
        updateDecision((current) => ({ ...current, action: 'acknowledging' }))
        stopPhase = 'acknowledgement'
        job = await waitForTerminalJob(initial.expectedJobId, controller.signal)
      }

      if (controller.signal.aborted) return
      dispatchIntent(initial.intent, true)
    } catch (error) {
      if (isAbort(error, controller.signal) && !bounded.timedOut()) return
      updateDecision((current) => ({
        ...current,
        action: 'idle',
        error:
          stopPhase === 'runtime'
            ? 'runtime_unavailable'
            : stopPhase === 'job'
              ? 'job_unavailable'
              : stopPhase === 'acknowledgement' || error instanceof CancellationTimeoutError
            ? 'cancel_timeout'
            : 'cancel_failed',
      }))
    } finally {
      bounded.cleanup()
      if (readAbortRef.current === controller) readAbortRef.current = null
    }
  }, [dispatchIntent, runtime, updateDecision])

  useEffect(() => {
    const current = decisionRef.current
    const sample = runtime.data
    if (!current || !sample || current.action !== 'idle') return
    if (conflictFingerprint(sample) === conflictFingerprint(current.snapshot)) return
    setDecision({ ...current, snapshot: sample, sampleState: 'updated', error: null })
  }, [runtime.data])

  useEffect(
    () => () => {
      readAbortRef.current?.abort()
      readAbortRef.current = null
    },
    [],
  )

  return useMemo(
    () => ({ decision, request, close, queue, stopAndSwitch }),
    [close, decision, queue, request, stopAndSwitch],
  )
}

export function ResourceConflictDialog({
  decision,
  onQueue,
  onStopAndSwitch,
  onClose,
  returnFocusRef,
}: {
  decision: ConflictDecision
  onQueue: () => void
  onStopAndSwitch: () => void
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const queueRef = useRef<HTMLButtonElement>(null)
  const descriptionId = 'resource-conflict-description'
  const active = normalActiveLease(decision.snapshot)
  const queued = normalQueued(decision.snapshot)
  const prewarmOwnsPermit = decision.snapshot.governor.activeLease?.priority === 'prewarm'
  const busy = decision.action !== 'idle'
  const stopReason = stopUnavailableReason(decision)

  return (
    <Modal
      open
      onClose={onClose}
      title={translate('chat.conflict.title')}
      describedBy={descriptionId}
      initialFocusRef={queueRef}
      returnFocusRef={returnFocusRef}
      closeLabel={translate('chat.conflict.close')}
      width={720}
      footer={
        <div className="flex w-full min-w-0 flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button className="min-h-11 sm:min-h-0" variant="ghost" onClick={onClose}>
            {translate('chat.conflict.back')}
          </Button>
          {!prewarmOwnsPermit ? (
            <Button
              className="min-h-11 sm:min-h-0"
              variant="danger"
              disabled={busy || Boolean(stopReason)}
              onClick={onStopAndSwitch}
            >
              {translate('chat.conflict.stop')}
            </Button>
          ) : null}
          <Button
            ref={queueRef}
            className="min-h-11 sm:min-h-0"
            variant="primary"
            disabled={busy}
            onClick={onQueue}
          >
            {decision.action === 'dispatching' ? (
              <Spinner size={12} />
            ) : null}
            {translate('chat.conflict.queue')}
          </Button>
        </div>
      }
    >
      <p id={descriptionId} className="text-xs text-[var(--fg-muted)]">
        {translate('chat.conflict.description')}
      </p>
      <p className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] p-2 text-2xs text-[var(--fg-muted)]">
        {translate('chat.conflict.policy')}
      </p>

      {decision.sampleState !== 'fresh' ? (
        <p className="mt-2 text-2xs text-[var(--danger)]" role="status">
          {decision.sampleState === 'stale'
            ? translate('chat.conflict.sample.stale')
            : translate('chat.conflict.sample.updated')}
        </p>
      ) : null}

      <section className="mt-3 min-w-0" aria-labelledby="resource-conflict-active">
        <h3 id="resource-conflict-active" className="text-xs font-semibold">
          {translate('chat.conflict.active')}
        </h3>
        {active ? (
          <dl className="mt-1 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-2xs text-[var(--fg-muted)]">
            <Fact label={translate('runtime.operation')} value={operationLabel(active.operation)} />
            <Fact label={translate('runtime.priority')} value={priorityLabel(active.priority)} />
            <Fact label={translate('runtime.model')} value={active.model.name} mono />
            <Fact label={translate('runtime.owner')} value={ownerLabel(active.owner)} />
            <Fact label={translate('runtime.context')} value={formatContextLength(active.requestedContext)} />
            <Fact label={translate('runtime.acquired')} value={formatDateTime(active.acquiredAt)} />
          </dl>
        ) : (
          <p className="mt-1 text-2xs text-[var(--fg-muted)]">
            {translate('chat.conflict.active.changed')}
          </p>
        )}
      </section>

      <section className="mt-3 min-w-0" aria-labelledby="resource-conflict-queue">
        <h3 id="resource-conflict-queue" className="text-xs font-semibold">
          {translate('chat.conflict.queueAhead').replace(
            '{count}',
            String(queued.length),
          )}
        </h3>
        {queued.length > 0 ? (
          <ol className="mt-1 space-y-1.5">
            {queued.map((waiter, index) => (
              <li key={waiter.ticketId} className="min-w-0 border-l-2 border-[var(--border-strong)] pl-2 text-2xs">
                <p className="font-medium">
                  {translate('runtime.queue.position').replace('{position}', String(index + 1))}{' '}
                  · {operationLabel(waiter.operation)}
                </p>
                <p className="break-words font-mono text-[var(--fg-muted)]">{waiter.model.name}</p>
                <p className="text-[var(--fg-muted)]">
                  {ownerLabel(waiter.owner)} · {translate('runtime.context')}:{' '}
                  {formatContextLength(waiter.requestedContext)}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-2xs text-[var(--fg-muted)]">
            {translate('chat.conflict.queue.empty')}
          </p>
        )}
      </section>

      {stopReason ? (
        <p className="mt-3 text-2xs text-[var(--fg-muted)]" role="status">
          {stopReason}
        </p>
      ) : null}
      {actionLabel(decision.action) ? (
        <p className="mt-3 flex items-center gap-2 text-2xs text-[var(--fg-muted)]" role="status" aria-live="polite">
          <Spinner size={12} />
          {actionLabel(decision.action)}
        </p>
      ) : null}
      {decision.error ? (
        <div className="mt-3" role="alert">
          <p className="text-xs font-semibold text-[var(--danger)]">
            {translate('chat.conflict.error.title')}
          </p>
          <p className="text-2xs text-[var(--fg-muted)]">{errorLabel(decision.error)}</p>
        </div>
      ) : null}
    </Modal>
  )
}

function createDecision(
  intent: ChatSendIntent,
  snapshot: RuntimeSnapshot,
  sampleState: ConflictDecision['sampleState'],
): ConflictDecision {
  const owner = normalActiveLease(snapshot)?.owner
  return {
    intent,
    snapshot,
    sampleState,
    expectedJobId: owner?.kind === 'job' ? owner.jobId : null,
    action: 'idle',
    error: sampleState === 'stale' ? 'runtime_unavailable' : null,
  }
}

function hasConservativeConflict(snapshot: RuntimeSnapshot): boolean {
  return Boolean(normalActiveLease(snapshot) || normalQueued(snapshot).length)
}

function conflictFingerprint(snapshot: RuntimeSnapshot): string {
  const active = normalActiveLease(snapshot)
  return JSON.stringify({
    active: active
      ? {
          owner: active.owner,
          operation: active.operation,
          model: active.model,
          requestedContext: active.requestedContext,
        }
      : null,
    queued: normalQueued(snapshot).map((waiter) => ({
      owner: waiter.owner,
      operation: waiter.operation,
      model: waiter.model,
      requestedContext: waiter.requestedContext,
      reason: waiter.reason,
    })),
  })
}

function stopUnavailableReason(decision: ConflictDecision): string | null {
  if (decision.sampleState === 'stale') return translate('chat.conflict.stop.stale')
  const active = normalActiveLease(decision.snapshot)
  if (!active) return translate('chat.conflict.stop.noExactJob')
  if (active.owner.kind !== 'job') return translate('chat.conflict.stop.operationOwner')
  if (active.owner.jobId !== decision.expectedJobId) return translate('chat.conflict.stop.changedOwner')
  return null
}

function ownerLabel(owner: RuntimeResourceOwner): string {
  return owner.kind === 'job'
    ? translate('runtime.owner.job')
    : translate('runtime.owner.operation')
}

function operationLabel(operation: RuntimeResourceOperation): string {
  if (operation === 'chat') return translate('runtime.operation.chat')
  if (operation === 'compaction') return translate('runtime.operation.compaction')
  if (operation === 'model_prewarm') return translate('runtime.operation.modelPrewarm')
  return translate('runtime.operation.modelWarm')
}

function priorityLabel(priority: RuntimeAdmissionPriority): string {
  return priority === 'prewarm'
    ? translate('runtime.priority.prewarm')
    : translate('runtime.priority.normal')
}

function normalActiveLease(snapshot: RuntimeSnapshot) {
  const active = snapshot.governor.activeLease
  return active?.priority === 'normal' ? active : null
}

function normalQueued(snapshot: RuntimeSnapshot) {
  return snapshot.governor.queued.filter((waiter) => waiter.priority === 'normal')
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}:</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </>
  )
}

function actionLabel(action: DecisionAction): string | null {
  if (action === 'verifying') return translate('chat.conflict.action.verifying')
  if (action === 'cancelling') return translate('chat.conflict.action.cancelling')
  if (action === 'acknowledging') return translate('chat.conflict.action.acknowledging')
  if (action === 'dispatching') return translate('chat.conflict.action.dispatching')
  return null
}

function errorLabel(error: Exclude<DecisionError, null>): string {
  if (error === 'runtime_unavailable') return translate('chat.conflict.error.runtimeUnavailable')
  if (error === 'owner_changed') return translate('chat.conflict.error.ownerChanged')
  if (error === 'job_unavailable') return translate('chat.conflict.error.jobUnavailable')
  if (error === 'cancel_conflict') return translate('chat.conflict.error.cancelConflict')
  if (error === 'cancel_failed') return translate('chat.conflict.error.cancelFailed')
  if (error === 'cancel_timeout') return translate('chat.conflict.error.cancelTimeout')
  return translate('chat.conflict.error.dispatchFailed')
}

function isTerminal(job: Job): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'interrupted'
  )
}

async function waitForTerminalJob(jobId: string, signal: AbortSignal): Promise<Job> {
  for (let read = 0; read < CANCELLATION_MAX_READS; read += 1) {
    await abortableDelay(CANCELLATION_POLL_INTERVAL_MS, signal)
    const job = (await api.getJob(jobId, signal)).job
    if (isTerminal(job)) return job
    if (job.status !== 'cancelling') {
      throw new Error('Job left cancelling without a terminal acknowledgement')
    }
  }
  throw new CancellationTimeoutError()
}

function abortableDelay(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Conflict action was aborted', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delay)
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Conflict action was aborted', 'AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return Boolean(
    signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError'),
  )
}

class CancellationTimeoutError extends Error {}

function createBoundedController(timeoutMs: number) {
  const controller = new AbortController()
  let timeoutReached = false
  const timer = setTimeout(() => {
    timeoutReached = true
    controller.abort()
  }, timeoutMs)
  return {
    controller,
    timedOut: () => timeoutReached,
    cleanup: () => clearTimeout(timer),
  }
}
