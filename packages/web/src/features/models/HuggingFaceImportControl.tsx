import { useEffect, useRef, useState, type RefObject } from 'react'
import type {
  CompletionProbeEvidence,
  HuggingFaceDownloadProvenance,
  HuggingFaceImportConflictReason,
  HuggingFaceImportFailureReason,
  HuggingFaceImportProvenance,
  HuggingFaceImportStreamEvent,
  HuggingFaceImportTargetObservation,
} from '@guanxi/contract'
import { Badge, Button, Input, Modal } from '../../components/ui.tsx'
import { streamHuggingFaceImport } from '../../lib/api.ts'
import { SseHttpError } from '../../lib/sse.ts'
import { formatContextLength, formatDateTime } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'

type Phase = Extract<HuggingFaceImportStreamEvent, { type: 'state' }>['data']['phase']
type ImportState =
  | { kind: 'idle' }
  | { kind: 'running'; phase: Phase }
  | { kind: 'completed'; provenance: HuggingFaceImportProvenance }
  | { kind: 'cancelled' }
  | {
      kind: 'conflict'
      reason: HuggingFaceImportConflictReason
      target: HuggingFaceImportTargetObservation
    }
  | {
      kind: 'failed'
      reason: HuggingFaceImportFailureReason
      target: HuggingFaceImportTargetObservation | null
      probe: CompletionProbeEvidence | null
    }

const PHASE_KEYS: Record<Phase, LocaleKey> = {
  validating_artifact: 'hf.import.phase.validatingArtifact',
  checking_target: 'hf.import.phase.checkingTarget',
  checking_blob: 'hf.import.phase.checkingBlob',
  uploading_blob: 'hf.import.phase.uploadingBlob',
  creating_model: 'hf.import.phase.creatingModel',
  observing_installation: 'hf.import.phase.observingInstallation',
  running_completion_probe: 'hf.import.phase.runningProbe',
}

const CONFLICT_KEYS: Record<HuggingFaceImportConflictReason, LocaleKey> = {
  duplicate_active: 'hf.import.conflict.duplicate_active',
  target_preexisting: 'hf.import.conflict.target_preexisting',
  target_changed: 'hf.import.conflict.target_changed',
  target_ambiguous: 'hf.import.conflict.target_ambiguous',
  cancelled_after_create: 'hf.import.conflict.cancelled_after_create',
  outcome_unknown: 'hf.import.conflict.outcome_unknown',
}

const FAILURE_KEYS: Record<HuggingFaceImportFailureReason, LocaleKey> = {
  invalid_target: 'hf.import.failed.invalid_target',
  remote_provider_not_allowed: 'hf.import.failed.remote_provider_not_allowed',
  artifact_not_found: 'hf.import.failed.artifact_not_found',
  artifact_changed: 'hf.import.failed.artifact_changed',
  artifact_corrupt: 'hf.import.failed.artifact_corrupt',
  filesystem_error: 'hf.import.failed.filesystem_error',
  provider_unavailable: 'hf.import.failed.provider_unavailable',
  connect_timeout: 'hf.import.failed.connect_timeout',
  stream_idle_timeout: 'hf.import.failed.stream_idle_timeout',
  overall_timeout: 'hf.import.failed.overall_timeout',
  blob_upload_failed: 'hf.import.failed.blob_upload_failed',
  create_provider_error: 'hf.import.failed.create_provider_error',
  create_protocol_error: 'hf.import.failed.create_protocol_error',
  installation_missing: 'hf.import.failed.installation_missing',
  probe_not_verified: 'hf.import.failed.probe_not_verified',
}

export function HuggingFaceImportControl({
  artifact,
  contextLength,
  onInstalled,
}: {
  artifact: HuggingFaceDownloadProvenance
  contextLength: number
  onInstalled?: () => void
}) {
  const [target, setTarget] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [state, setState] = useState<ImportState>({ kind: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  const attemptRef = useRef(0)
  const runningRef = useRef(false)
  const focusTargetOnIdleRef = useRef(false)
  const mountedRef = useRef(true)
  const launchRef = useRef<HTMLButtonElement>(null)
  const targetRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      controllerRef.current?.abort('hf-import-connection-closed')
    }
  }, [])

  useEffect(() => {
    if (state.kind === 'idle' && focusTargetOnIdleRef.current) {
      focusTargetOnIdleRef.current = false
      targetRef.current?.focus()
    }
    if (state.kind === 'idle' || state.kind === 'running') return
    statusRef.current?.focus()
  }, [state.kind])

  const start = async () => {
    const requestedTarget = target.trim()
    if (!requestedTarget || runningRef.current) return
    setConfirming(false)
    runningRef.current = true
    const controller = new AbortController()
    const attempt = ++attemptRef.current
    controllerRef.current = controller
    setState({ kind: 'running', phase: 'validating_artifact' })
    let terminal = false
    try {
      for await (const event of streamHuggingFaceImport({
        artifactId: artifact.artifact.id,
        targetModelName: requestedTarget,
        contextLength,
      }, controller.signal)) {
        if (
          !mountedRef.current
          || controller.signal.aborted
          || attemptRef.current !== attempt
          || controllerRef.current !== controller
        ) return
        if (event.type === 'state') {
          setState({ kind: 'running', phase: event.data.phase })
        } else if (event.type === 'completed') {
          terminal = true
          setState({ kind: 'completed', provenance: event.data.provenance })
          onInstalled?.()
          break
        } else if (event.type === 'cancelled') {
          terminal = true
          setState({ kind: 'cancelled' })
          break
        } else if (event.type === 'conflict') {
          terminal = true
          setState({ kind: 'conflict', reason: event.data.reason, target: event.data.target })
          break
        } else if (event.type === 'failed') {
          terminal = true
          setState({
            kind: 'failed',
            reason: event.data.reason,
            target: event.data.target,
            probe: event.data.probe,
          })
          break
        }
      }
      if (
        !terminal
        && !controller.signal.aborted
        && mountedRef.current
        && attemptRef.current === attempt
      ) setState({
        kind: 'failed', reason: 'provider_unavailable', target: null, probe: null,
      })
    } catch (error) {
      if (
        !controller.signal.aborted
        && mountedRef.current
        && attemptRef.current === attempt
      ) setState({
        kind: 'failed',
        reason: error instanceof SseHttpError && error.status === 400
          ? 'invalid_target'
          : 'provider_unavailable',
        target: null,
        probe: null,
      })
    } finally {
      if (controllerRef.current === controller && attemptRef.current === attempt) {
        controllerRef.current = null
        runningRef.current = false
      }
    }
  }

  const cancel = () => {
    attemptRef.current += 1
    controllerRef.current?.abort('hf-import-user-cancelled')
    controllerRef.current = null
    runningRef.current = false
    // Once the client closes the stream it cannot receive the server's
    // post-abort reconciliation. Never turn that uncertainty into a clean
    // pre-create cancellation claim in the UI.
    setState({
      kind: 'conflict',
      reason: 'outcome_unknown',
      target: { state: 'unavailable', observedAt: new Date().toISOString() },
    })
  }

  const terminal = state.kind !== 'idle' && state.kind !== 'running'
  return (
    <div className="mt-3 min-w-0 border-t border-divider pt-3">
      <p className="text-2xs font-semibold">{translate('hf.import.title')}</p>
      <p className="mt-1 text-2xs text-muted">
        {translate('hf.import.description')}
      </p>

      {state.kind !== 'completed' ? (
        <div className="mt-2 min-w-0">
          <label htmlFor={`hf-import-target-${artifact.artifact.id}`} className="block text-2xs font-medium">
            {translate('hf.import.target')}
          </label>
          <Input
            ref={targetRef}
            id={`hf-import-target-${artifact.artifact.id}`}
            value={target}
            disabled={state.kind === 'running'}
            onChange={(event) => {
              setTarget(event.target.value)
              if (terminal) setState({ kind: 'idle' })
            }}
            placeholder={translate('hf.import.target.placeholder')}
            autoComplete="off"
            className="mt-1 min-h-11 w-full min-w-0 sm:min-h-0"
            aria-describedby={`hf-import-hint-${artifact.artifact.id}`}
          />
          <p id={`hf-import-hint-${artifact.artifact.id}`} className="mt-1 text-2xs text-muted">
            {translate('hf.import.target.hint')}
          </p>
        </div>
      ) : null}

      {state.kind === 'idle' ? (
        <Button
          ref={launchRef}
          size="sm"
          variant="primary"
          disabled={target.trim().length === 0}
          onClick={() => setConfirming(true)}
          className="mt-2 min-h-11 sm:min-h-0"
        >
          {translate('hf.import.action')}
        </Button>
      ) : state.kind === 'running' ? (
        <div className="mt-2 rounded-md border border-divider bg-inset p-2">
          <p role="status" aria-live="polite" aria-atomic="true" className="text-2xs font-medium">
            {translate(PHASE_KEYS[state.phase])}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={cancel}
            className="mt-2 min-h-11 sm:min-h-0"
          >
            {translate('hf.import.cancel')}
          </Button>
        </div>
      ) : (
        <ImportTerminal
          state={state}
          statusRef={statusRef}
          onRetry={() => {
            focusTargetOnIdleRef.current = true
            setState({ kind: 'idle' })
          }}
        />
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={translate('hf.import.confirm.title')}
        describedBy={`hf-import-confirm-${artifact.artifact.id}`}
        initialFocusRef={confirmRef}
        returnFocusRef={launchRef}
        closeLabel={translate('hf.import.confirm.close')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              className="min-h-11 sm:min-h-0"
            >
              {translate('hf.import.confirm.back')}
            </Button>
            <Button
              ref={confirmRef}
              variant="primary"
              onClick={() => void start()}
              className="min-h-11 sm:min-h-0"
            >
              {translate('hf.import.confirm.run')}
            </Button>
          </>
        }
      >
        <div id={`hf-import-confirm-${artifact.artifact.id}`} className="space-y-2 text-xs text-secondary">
          <p>{translate('hf.import.confirm.description')}</p>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            <dt>{translate('hf.import.confirm.artifact')}</dt>
            <dd className="min-w-0 break-all font-mono">{artifact.artifact.id}</dd>
            <dt>{translate('hf.import.confirm.target')}</dt>
            <dd className="min-w-0 break-all font-mono">{target.trim()}</dd>
            <dt>{translate('hf.import.confirm.context')}</dt>
            <dd>{formatContextLength(contextLength)}</dd>
          </dl>
        </div>
      </Modal>
    </div>
  )
}

function ImportTerminal({
  state,
  statusRef,
  onRetry,
}: {
  state: Exclude<ImportState, { kind: 'idle' | 'running' }>
  statusRef: RefObject<HTMLDivElement | null>
  onRetry: () => void
}) {
  const success = state.kind === 'completed'
  const warning = state.kind === 'cancelled' || state.kind === 'conflict'
  const title = success
    ? translate('hf.import.completed')
    : state.kind === 'cancelled'
      ? translate('hf.import.cancelled')
      : state.kind === 'conflict'
        ? translate('hf.import.conflict')
        : translate('hf.import.failed')
  return (
    <div
      ref={statusRef}
      tabIndex={-1}
      role={success || warning ? 'status' : 'alert'}
      aria-live="polite"
      aria-atomic="true"
      className="mt-2 min-w-0 rounded-md border border-divider bg-inset p-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={success ? 'green' : warning ? 'yellow' : 'outline'}>{title}</Badge>
      </div>
      {state.kind === 'completed' ? (
        <div className="mt-2 min-w-0 text-2xs text-muted">
          <p>{translate('hf.import.installed')}</p>
          <p className="mt-1 min-w-0 break-all font-mono">
            {state.provenance.installation.normalizedModelReference} · {state.provenance.installation.digest}
          </p>
          <p className="mt-1">
            {translate('hf.import.runtimeVerified')}
          </p>
          <p className="mt-1">
            {translate('hf.import.runtimeVersion')} · {state.provenance.installation.runtimeVersion}
          </p>
          <p className="mt-1">
            {translate('hf.import.observed')} {formatDateTime(state.provenance.installation.observedAt)}
          </p>
        </div>
      ) : state.kind === 'conflict' ? (
        <>
          <p className="mt-2 text-2xs">{translate(CONFLICT_KEYS[state.reason])}</p>
          <TargetObservation target={state.target} />
        </>
      ) : state.kind === 'failed' ? (
        <>
          <p className="mt-2 text-2xs">{translate(FAILURE_KEYS[state.reason])}</p>
          {state.target ? <TargetObservation target={state.target} /> : null}
          {state.probe ? <ProbeObservation probe={state.probe} /> : null}
        </>
      ) : (
        <p className="mt-2 text-2xs">{translate('hf.import.cancelled.detail')}</p>
      )}
      {!success ? (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-2 min-h-11 sm:min-h-0">
          {translate('hf.import.retry')}
        </Button>
      ) : null}
    </div>
  )
}

function ProbeObservation({ probe }: { probe: CompletionProbeEvidence }) {
  return (
    <div className="mt-2 text-2xs text-muted">
      <p>{translate('hf.import.probeEvidence')}</p>
      <p className="mt-1">
        {translate(`models.probe.state.${probe.status}` as LocaleKey)} ·{' '}
        {translate(`models.probe.reason.${probe.reason}` as LocaleKey)}
      </p>
      <p className="mt-1">{translate('models.probe.observed')} {formatDateTime(probe.observedAt)}</p>
    </div>
  )
}

function TargetObservation({ target }: { target: HuggingFaceImportTargetObservation }) {
  return (
    <p className="mt-1 min-w-0 break-all font-mono text-2xs text-muted">
      {target.state === 'exact'
        ? `${target.normalizedModelReference} · ${target.digest}`
        : translate(`hf.import.target.${target.state}` as LocaleKey)}
    </p>
  )
}
