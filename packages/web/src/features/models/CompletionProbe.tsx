import { useEffect, useRef, useState } from 'react'
import type { CompletionProbeEvidence, ModelDetail } from '@guanxi/contract'
import { Badge, Button, Modal } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatContextLength, formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useOptionalRuntimeProjection } from '../health/RuntimeContext.tsx'

type LocalState =
  | { state: 'idle' }
  | { state: 'pending'; controller: AbortController }
  | { state: 'result'; evidence: CompletionProbeEvidence }
  | { state: 'error'; message: string }

export function CompletionProbe({
  model,
  contextLength,
}: {
  model: ModelDetail
  contextLength: number
}) {
  const runtime = useOptionalRuntimeProjection()
  const [confirming, setConfirming] = useState<'reuse' | 'force' | null>(null)
  const [local, setLocal] = useState<LocalState>({ state: 'idle' })
  const launchRef = useRef<HTMLButtonElement>(null)
  const forceRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)
  const localRef = useRef(local)
  localRef.current = local

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const current = localRef.current
      if (current.state === 'pending') current.controller.abort('model-profile-unmounted')
    }
  }, [])

  useEffect(() => {
    if (local.state === 'pending') cancelRef.current?.focus()
    else if (local.state === 'result' || local.state === 'error') launchRef.current?.focus()
  }, [local.state])

  const pendingProjection =
    local.state === 'pending'
      ? runtime?.data?.governor.activeLease?.operation === 'model_probe'
        && runtime.data.governor.activeLease.model.name === model.name
        ? 'running'
        : runtime?.data?.governor.queued.some(
            (item) => item.operation === 'model_probe' && item.model.name === model.name,
          )
          ? 'queued'
          : 'queued'
      : null

  const run = async (force: boolean) => {
    if (localRef.current.state === 'pending') return
    setConfirming(null)
    const controller = new AbortController()
    const pending: LocalState = { state: 'pending', controller }
    localRef.current = pending
    setLocal(pending)
    try {
      const response = await api.completionProbe(
        model.name,
        {
          capability: 'completion',
          expectedDigest: model.digest,
          contextLength,
          force,
        },
        controller.signal,
      )
      if (!controller.signal.aborted && mountedRef.current) {
        setLocal({ state: 'result', evidence: response.evidence })
      }
    } catch (error) {
      if (!mountedRef.current) return
      if (controller.signal.aborted) {
        setLocal({
          state: 'result',
          evidence: cancelledEvidence(model),
        })
      } else {
        setLocal({ state: 'error', message: errorMessage(error) })
      }
    }
  }

  const result = local.state === 'result' ? local.evidence : null

  return (
    <div className="min-w-0 space-y-3" aria-label={translate('models.probe.label')}>
      <p className="text-2xs text-[var(--fg-muted)]">
        {translate('models.probe.explanation')}
      </p>
      <p className="text-2xs text-[var(--fg-subtle)]">
        {translate('models.probe.boundary')}
      </p>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="rounded-md border border-[var(--border)] bg-[var(--bg-inset)] p-2 text-2xs"
      >
        {local.state === 'idle' ? (
          <ProbeState label={translate('models.probe.state.idle')} tone="outline" />
        ) : pendingProjection ? (
          <ProbeState
            label={
              pendingProjection === 'running'
                ? translate('models.probe.state.running')
                : translate('models.probe.state.queued')
            }
            tone="yellow"
          />
        ) : local.state === 'error' ? (
          <>
            <ProbeState label={translate('models.probe.state.error')} tone="yellow" />
            <p className="mt-1 break-words">{local.message}</p>
          </>
        ) : result ? (
          <ProbeResult evidence={result} />
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap gap-2">
        {local.state === 'pending' ? (
          <Button
            ref={cancelRef}
            variant="secondary"
            onClick={() => local.controller.abort('explicit-cancel')}
            aria-label={translate('models.probe.cancel.aria')}
          >
            {translate('models.probe.cancel')}
          </Button>
        ) : (
          <>
            <Button
              ref={launchRef}
              variant="secondary"
              onClick={() => setConfirming('reuse')}
              disabled={model.isCloud}
              aria-label={translate('models.probe.run.aria')}
            >
              {translate('models.probe.run')}
            </Button>
            {result?.basis.state === 'exact' ? (
              <Button
                ref={forceRef}
                variant="ghost"
                onClick={() => setConfirming('force')}
                aria-label={translate('models.probe.force.aria')}
              >
                {translate('models.probe.force')}
              </Button>
            ) : null}
          </>
        )}
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={translate(
          confirming === 'force'
            ? 'models.probe.confirm.forceTitle'
            : 'models.probe.confirm.title',
        )}
        describedBy="completion-probe-confirmation"
        initialFocusRef={confirmRef}
        returnFocusRef={confirming === 'force' ? forceRef : launchRef}
        closeLabel={translate('models.probe.confirm.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {translate('models.probe.confirm.back')}
            </Button>
            <Button
              ref={confirmRef}
              variant="primary"
              onClick={() => void run(confirming === 'force')}
            >
              {translate(
                confirming === 'force'
                  ? 'models.probe.confirm.force'
                  : 'models.probe.confirm.run',
              )}
            </Button>
          </>
        }
      >
        <div id="completion-probe-confirmation" className="space-y-2 text-xs text-[var(--fg-muted)]">
          <p>{translate('models.probe.confirm.description')}</p>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            <dt>{translate('models.probe.confirm.model')}</dt>
            <dd className="min-w-0 break-all font-mono">{model.name}</dd>
            <dt>{translate('models.probe.confirm.context')}</dt>
            <dd>{formatContextLength(contextLength)}</dd>
          </dl>
        </div>
      </Modal>
    </div>
  )
}

function ProbeResult({ evidence }: { evidence: CompletionProbeEvidence }) {
  const label = evidence.historical
    ? translate('models.probe.state.cached')
    : probeStatus(evidence.status)
  const tone = evidence.status === 'verified' && !evidence.historical ? 'green' :
    evidence.status === 'degraded' || evidence.status === 'cancelled' ? 'yellow' : 'outline'
  return (
    <>
      <ProbeState label={label} tone={tone} />
      <p className="mt-1">{probeReason(evidence)}</p>
      <p className="mt-1 min-w-0 break-all font-mono text-[var(--fg-subtle)]">
        {evidence.basis.state === 'exact'
          ? `${translate('models.probe.identity.reference')}: ${evidence.basis.normalizedModelReference} · ${translate('models.probe.identity.digest')}: ${evidence.basis.artifactDigest} · ${translate('models.probe.identity.runtime')}: Ollama ${evidence.basis.runtimeVersion} · ${translate('models.probe.identity.context')}: ${formatContextLength(evidence.basis.contextLength)} · ${translate('models.probe.identity.definition')}: v${evidence.basis.probeDefinitionVersion}`
          : translate('models.probe.identity.unknown')}
      </p>
      <p className="mt-1 text-[var(--fg-subtle)]">
        {translate('models.probe.observed')} {formatDateTime(evidence.observedAt)} ·{' '}
        {translate('models.probe.confidence')} {probeConfidence(evidence.confidence)}
      </p>
    </>
  )
}

function ProbeState({
  label,
  tone,
}: {
  label: string
  tone: 'green' | 'yellow' | 'outline'
}) {
  return <Badge tone={tone}>{label}</Badge>
}

function probeReason(evidence: CompletionProbeEvidence): string {
  const keys = {
    terminal_response: 'models.probe.reason.terminal_response',
    provider_unavailable: 'models.probe.reason.provider_unavailable',
    connect_timeout: 'models.probe.reason.connect_timeout',
    load_timeout: 'models.probe.reason.load_timeout',
    response_timeout: 'models.probe.reason.response_timeout',
    provider_error: 'models.probe.reason.provider_error',
    runtime_protocol: 'models.probe.reason.runtime_protocol',
    empty_response: 'models.probe.reason.empty_response',
    identity_changed: 'models.probe.reason.identity_changed',
    persistence_failed: 'models.probe.reason.persistence_failed',
    identity_unavailable: 'models.probe.reason.identity_unavailable',
    context_limit_unknown: 'models.probe.reason.context_limit_unknown',
    request_cancelled: 'models.probe.reason.request_cancelled',
    request_timeout: 'models.probe.reason.request_timeout',
    model_not_installed: 'models.probe.reason.model_not_installed',
    cloud_model: 'models.probe.reason.cloud_model',
    fit_red: 'models.probe.reason.fit_red',
    fit_unknown: 'models.probe.reason.fit_unknown',
    context_limit_exceeded: 'models.probe.reason.context_limit_exceeded',
    probe_in_progress: 'models.probe.reason.probe_in_progress',
  } as const satisfies Record<CompletionProbeEvidence['reason'], Parameters<typeof translate>[0]>
  return translate(keys[evidence.reason])
}

function probeStatus(status: CompletionProbeEvidence['status']): string {
  const keys = {
    verified: 'models.probe.state.verified',
    degraded: 'models.probe.state.degraded',
    unknown: 'models.probe.state.unknown',
    cancelled: 'models.probe.state.cancelled',
    skipped: 'models.probe.state.skipped',
  } as const
  return translate(keys[status])
}

function probeConfidence(confidence: CompletionProbeEvidence['confidence']): string {
  if (confidence === 'verified') return translate('models.probe.confidence.verified')
  if (confidence === 'degraded') return translate('models.probe.confidence.degraded')
  return translate('models.probe.confidence.unknown')
}

function cancelledEvidence(model: ModelDetail): CompletionProbeEvidence {
  const now = new Date().toISOString()
  return {
    status: 'cancelled',
    confidence: 'unknown',
    reason: 'request_cancelled',
    capability: 'completion',
    source: 'runtime_probe',
    observedAt: now,
    completedAt: now,
    durationMs: 0,
    basis: {
      state: 'unavailable',
      keyVersion: 1,
      probeDefinitionVersion: 1,
      reason:
        model.descriptor.reference.state === 'canonical'
          ? 'runtime_version_unavailable'
          : 'invalid_model_reference',
    },
    historical: false,
  }
}
