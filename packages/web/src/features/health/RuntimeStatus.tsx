import type {
  RuntimeCurrentFitReason,
  RuntimeHostTelemetry,
  RuntimeMemoryFact,
  RuntimeModelObservation,
  RuntimeResourceOwner,
  RuntimeResourceOperation,
  RuntimeAdmissionPriority,
  RuntimeSnapshot,
} from '@alamo/contract'
import { Button, Spinner } from '../../components/ui.tsx'
import {
  formatBytes,
  formatContextLength,
  formatDateTime,
  formatDuration,
} from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useRuntimeProjection } from './RuntimeContext.tsx'

export interface RuntimeStatusViewProps {
  data: RuntimeSnapshot | null
  error: unknown
  loading: boolean
  refreshing: boolean
  onRetry: () => void
}

export function RuntimeStatus() {
  const runtime = useRuntimeProjection()

  return (
    <RuntimeStatusView
      data={runtime.data}
      error={runtime.error}
      loading={runtime.loading}
      refreshing={runtime.refreshing}
      onRetry={runtime.retry}
    />
  )
}

export function RuntimeStatusView({
  data,
  error,
  loading,
  refreshing,
  onRetry,
}: RuntimeStatusViewProps) {
  return (
    <section
      aria-labelledby="runtime-status-title"
      className="runtime-bar z-20 shrink-0 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 max-sm:order-last max-sm:border-t max-sm:border-b-0 max-sm:shadow-[0_-8px_24px_oklch(0_0_0/0.18)]"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="runtime-status-title" className="text-2xs font-semibold">
            {translate('runtime.bar.title')}
          </h2>
          {data ? <CompactSummary snapshot={data} /> : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          loading={refreshing}
          aria-label={translate('runtime.retry')}
          className="min-h-11 shrink-0 sm:min-h-0"
        >
          {translate('runtime.retry.short')}
        </Button>
      </div>

      {loading ? (
        <div
          className="mt-1 flex items-center gap-1.5 text-2xs text-[var(--fg-muted)]"
          role="status"
          aria-live="polite"
        >
          <Spinner size={12} />
          {translate('runtime.checking')}
        </div>
      ) : null}

      {refreshing && data ? (
        <p className="mt-1 text-2xs text-[var(--fg-muted)]" role="status" aria-live="polite">
          {translate('runtime.refreshing')}
        </p>
      ) : null}

      {error ? (
        <div className="mt-1 text-2xs text-[var(--danger)]" role="alert">
          <p className="font-medium">
            {data
              ? translate('runtime.refresh.error.title')
              : translate('runtime.error.title')}
          </p>
          <p className="text-[var(--fg-muted)]">
            {data
              ? translate('runtime.refresh.error.summary')
              : translate('runtime.error.summary')}
          </p>
        </div>
      ) : null}

      {data ? (
        <details className="runtime-bar-details mt-1 max-sm:max-h-[min(70dvh,36rem)] max-sm:overflow-y-auto">
          <summary className="min-h-11 cursor-pointer py-2 text-2xs font-medium text-[var(--fg-muted)] sm:min-h-0 sm:py-0.5">
            {translate('runtime.details')}
          </summary>
          <div className="mt-2 grid min-w-0 gap-2 pb-1 lg:grid-cols-3">
            <AdmissionProjection snapshot={data} />
            <ModelsProjection snapshot={data} />
            <HostProjection host={data.host} />
          </div>
          <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
            {translate('runtime.sampled')} · {formatDateTime(data.observedAt)}
          </p>
        </details>
      ) : null}
    </section>
  )
}

function CompactSummary({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const active = snapshot.governor.activeLease
  const modelState =
    snapshot.models === null
      ? sourceStateLabel(snapshot.source.state)
      : snapshot.models.length === 0
        ? translate('runtime.models.empty.short')
        : translate('runtime.models.count').replace('{count}', String(snapshot.models.length))

  return (
    <p className="truncate text-2xs text-[var(--fg-muted)]">
      {active
        ? `${operationLabel(active.operation)} · ${active.model.name}`
        : translate('runtime.admission.idle')}
      {' · '}
      {translate('runtime.queue.count').replace(
        '{count}',
        String(snapshot.governor.queued.length),
      )}
      {' · '}
      {modelState}
      {' · '}
      {hostStateLabel(snapshot.host)}
    </p>
  )
}

function AdmissionProjection({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const { governor } = snapshot
  return (
    <section
      aria-labelledby="runtime-admission-title"
      className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-2xs"
    >
      <h3 id="runtime-admission-title" className="font-semibold">
        {translate('runtime.admission.title')}
      </h3>
      <p className="mt-0.5 text-[var(--fg-subtle)]">
        {translate('runtime.admission.scope')}
      </p>
      <p className="mt-0.5 text-[var(--fg-subtle)]">
        {translate('runtime.admission.permitPolicy')}
      </p>
      <p className="mt-1 font-medium">
        {governor.accepting
          ? translate('runtime.admission.open')
          : translate('runtime.admission.closed')}
      </p>

      {governor.activeLease ? (
        <div className="mt-2">
          <h4 className="font-medium">{translate('runtime.active.title')}</h4>
          <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-[var(--fg-muted)]">
            <Fact label={translate('runtime.operation')} value={operationLabel(governor.activeLease.operation)} />
            <Fact label={translate('runtime.priority')} value={priorityLabel(governor.activeLease.priority)} />
            <Fact label={translate('runtime.model')} value={governor.activeLease.model.name} mono />
            <Fact label={translate('runtime.owner')} value={ownerLabel(governor.activeLease.owner)} />
            <Fact
              label={translate('runtime.context')}
              value={formatContextLength(governor.activeLease.requestedContext)}
            />
            <Fact
              label={translate('runtime.acquired')}
              value={formatDateTime(governor.activeLease.acquiredAt)}
            />
            <Fact
              label={translate('runtime.elapsed')}
              value={formatElapsed(governor.activeLease.acquiredAt)}
            />
          </dl>
        </div>
      ) : (
        <p className="mt-2 text-[var(--fg-muted)]">{translate('runtime.active.none')}</p>
      )}

      <div className="mt-2">
        <h4 className="font-medium">
          {translate('runtime.queue.title')} ({governor.queued.length})
        </h4>
        {governor.queued.length === 0 ? (
          <p className="mt-1 text-[var(--fg-muted)]">{translate('runtime.queue.empty')}</p>
        ) : (
          <ol className="mt-1 space-y-1">
            {governor.queued.map((waiter, index) => (
              <li
                key={waiter.ticketId}
                className="min-w-0 border-l-2 border-[var(--border-strong)] pl-2"
              >
                <p className="font-medium">
                  {translate('runtime.queue.position').replace('{position}', String(index + 1))}{' '}
                  · {operationLabel(waiter.operation)}
                </p>
                <p className="break-words font-mono text-[var(--fg-muted)]">
                  {waiter.model.name}
                </p>
                <p className="text-[var(--fg-muted)]">
                  {ownerLabel(waiter.owner)} · {priorityLabel(waiter.priority)} · {translate('runtime.context')}:{' '}
                  {formatContextLength(waiter.requestedContext)} · {translate('runtime.wait')}:{' '}
                  {formatElapsed(waiter.enqueuedAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}

function ModelsProjection({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const activeNotObserved = snapshot.decisions.some(
    (decision) => decision.code === 'active_not_observed',
  )

  return (
    <section
      aria-labelledby="runtime-models-title"
      className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-2xs"
    >
      <h3 id="runtime-models-title" className="font-semibold">
        {translate('runtime.models.title')}
      </h3>
      <p className="mt-0.5 text-[var(--fg-subtle)]">
        {sourceStateLabel(snapshot.source.state)} · {translate('runtime.source.ollama')}
      </p>

      {snapshot.models === null ? (
        <p className="mt-2 font-medium text-[var(--danger)]">
          {snapshot.source.state === 'incompatible'
            ? translate('runtime.models.incompatible')
            : translate('runtime.models.unavailable')}
        </p>
      ) : snapshot.models.length === 0 ? (
        <div className="mt-2">
          <p className="font-medium">{translate('runtime.empty.title')}</p>
          <p className="text-[var(--fg-muted)]">{translate('runtime.empty.summary')}</p>
        </div>
      ) : (
        <ul className="mt-2 space-y-2" aria-label={translate('runtime.models.title')}>
          {snapshot.models.map((model) => (
            <RuntimeModelRow key={`${model.normalizedName}:${model.digest ?? ''}`} model={model} />
          ))}
        </ul>
      )}

      {activeNotObserved ? (
        <p className="mt-2 font-medium text-[var(--danger)]">
          {translate('runtime.active.notObserved')}
        </p>
      ) : null}
    </section>
  )
}

function RuntimeModelRow({ model }: { model: RuntimeModelObservation }) {
  const fit = model.currentFit
  return (
    <li className="min-w-0 border-l-2 border-[var(--border-strong)] pl-2">
      <p className="break-words font-mono font-medium">{model.name}</p>
      <p className="text-[var(--fg-muted)]">
        {model.ownerState === 'unknown'
          ? translate('runtime.owner.unknown.warning')
          : translate('runtime.owner.active.exact')}
      </p>
      <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-[var(--fg-muted)]">
        <Fact label={translate('runtime.digest')} value={model.digest ?? translate('runtime.unknown')} mono />
        <Fact label={translate('runtime.context.observed')} value={model.contextLength === null ? translate('runtime.unknown') : formatContextLength(model.contextLength)} />
        <Fact label={translate('runtime.allocation.runtime')} value={allocationLabel(fit.runtimeAllocationBytes)} />
        <Fact label={translate('runtime.allocation.accelerator')} value={allocationLabel(fit.runtimeAcceleratorAllocationBytes)} />
        <Fact label={translate('runtime.fit.state')} value={fit.state === 'observed' ? translate('runtime.fit.observed') : translate('runtime.fit.unknown')} />
        <Fact label={translate('runtime.fit.basis')} value={fit.state === 'observed' ? translate('runtime.fit.currentResidency') : fitReasonLabel(fit.reason)} />
        <Fact label={translate('runtime.fit.requestedContext')} value={fit.requestedContext === null ? translate('runtime.unknown') : formatContextLength(fit.requestedContext)} />
        <Fact label={translate('runtime.fit.pressure')} value={pressureLabel(fit.pressureLevel)} />
      </dl>
      <p className="mt-1 text-[var(--fg-subtle)]">
        {translate('runtime.fit.noFutureGuarantee')}
      </p>
    </li>
  )
}

function HostProjection({ host }: { host: RuntimeHostTelemetry }) {
  return (
    <section
      aria-labelledby="runtime-host-title"
      className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-2xs"
    >
      <h3 id="runtime-host-title" className="font-semibold">
        {translate('runtime.host.title')}
      </h3>
      <p className="mt-0.5 font-medium">{hostStateLabel(host)}</p>
      <p className="text-[var(--fg-subtle)]">
        {host.profile.platform}/{host.profile.arch} · {host.profile.accelerator}
      </p>
      <p className="text-[var(--fg-subtle)]">
        {translate('runtime.host.devicesUnknown')}
      </p>
      <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-[var(--fg-muted)]">
        <MemoryFact label={translate('runtime.host.total')} fact={host.profile.totalMemoryBytes} />
        <MemoryFact label={translate('runtime.host.free')} fact={host.sample.freeMemoryBytes} />
        <MemoryFact label={translate('runtime.host.legacyEstimate')} fact={host.profile.legacyUsableMemoryBytes} />
        <MemoryFact label={translate('runtime.host.availableMemory')} fact={host.sample.availableMemoryBytes} />
        <Fact label={translate('runtime.host.pressure')} value={pressureLabel(host.sample.pressure.level)} />
        <MemoryFact label={translate('runtime.host.discreteVram')} fact={host.profile.discreteVramBytes} />
        <MemoryFact label={translate('runtime.host.gpuFree')} fact={host.sample.gpuFreeMemoryBytes} />
      </dl>
      {host.missingFields.length > 0 ? (
        <p className="mt-2 text-[var(--fg-subtle)]">
          {translate('runtime.host.missing')}:{' '}
          {host.missingFields.map(hostFieldLabel).join(', ')}
        </p>
      ) : null}
    </section>
  )
}

function MemoryFact({ label, fact }: { label: string; fact: RuntimeMemoryFact }) {
  return (
    <Fact
      label={label}
      value={`${fact.bytes === null ? translate('runtime.unknown') : formatBytes(fact.bytes)} · ${confidenceLabel(fact.confidence)} · ${memorySourceLabel(fact.source)} · ${memoryBasisLabel(fact.basis)}`}
    />
  )
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <>
      <dt>{label}:</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </>
  )
}

function formatElapsed(iso: string): string {
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp)
    ? translate('runtime.unknown')
    : formatDuration(Math.max(0, Date.now() - timestamp))
}

function allocationLabel(bytes: number | null): string {
  return `${bytes === null ? translate('runtime.unknown') : formatBytes(bytes)} · ${translate('runtime.confidence.observed')} · ${translate('runtime.source.ollama')}`
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
  if (operation === 'model_probe') return translate('runtime.operation.modelProbe')
  return translate('runtime.operation.modelWarm')
}

function priorityLabel(priority: RuntimeAdmissionPriority): string {
  return priority === 'prewarm'
    ? translate('runtime.priority.prewarm')
    : translate('runtime.priority.normal')
}

function sourceStateLabel(state: RuntimeSnapshot['source']['state']): string {
  if (state === 'available') return translate('runtime.source.available')
  if (state === 'incompatible') return translate('runtime.source.incompatible')
  return translate('runtime.source.unavailable')
}

function hostStateLabel(host: RuntimeHostTelemetry): string {
  if (host.state === 'available') {
    return host.missingFields.length > 0
      ? translate('runtime.host.availableMissing')
      : translate('runtime.host.available')
  }
  if (host.state === 'partial') return translate('runtime.host.partial')
  if (host.state === 'unsupported') return translate('runtime.host.unsupported')
  return translate('runtime.host.unavailable')
}

function confidenceLabel(confidence: RuntimeMemoryFact['confidence']): string {
  if (confidence === 'observed') return translate('runtime.confidence.observed')
  if (confidence === 'estimated') return translate('runtime.confidence.estimated')
  return translate('runtime.confidence.unknown')
}

function pressureLabel(level: RuntimeHostTelemetry['sample']['pressure']['level']): string {
  if (level === 'normal') return translate('runtime.pressure.normal')
  if (level === 'warning') return translate('runtime.pressure.warning')
  if (level === 'critical') return translate('runtime.pressure.critical')
  return translate('runtime.pressure.unknown')
}

function memorySourceLabel(source: RuntimeMemoryFact['source']): string {
  if (source === 'node_os_totalmem') return translate('runtime.memory.source.total')
  if (source === 'apple_vm_stat_pages_free') return translate('runtime.memory.source.freePages')
  if (source === 'apple_host_available_memory') return translate('runtime.memory.source.available')
  if (source === 'apple_host_gpu_free_memory') return translate('runtime.memory.source.gpuFree')
  if (
    source === 'legacy_apple_unified_memory_70_percent' ||
    source === 'legacy_hardware_usable_estimate'
  ) {
    return translate('runtime.memory.source.legacy')
  }
  return translate('runtime.memory.source.notReported')
}

function memoryBasisLabel(basis: RuntimeMemoryFact['basis']): string {
  if (basis === 'total_unified_memory') return translate('runtime.memory.basis.totalUnified')
  if (basis === 'total_system_memory') return translate('runtime.memory.basis.totalSystem')
  if (basis === 'legacy_compatibility_estimate_not_current_availability') return translate('runtime.memory.basis.legacy')
  if (basis === 'system_free_pages_not_safe_capacity') return translate('runtime.memory.basis.freePages')
  if (basis === 'system_available_memory_advisory') return translate('runtime.memory.basis.available')
  if (basis === 'discrete_vram_not_applicable_to_apple_unified_memory') return translate('runtime.memory.basis.unifiedNoVram')
  if (basis === 'discrete_vram_not_observed') return translate('runtime.memory.basis.vramUnknown')
  return translate('runtime.memory.basis.gpuFreeUnknown')
}

function hostFieldLabel(field: RuntimeHostTelemetry['missingFields'][number]): string {
  if (field === 'total_unified_memory_bytes') return translate('runtime.host.total')
  if (field === 'legacy_usable_memory_estimate_bytes') return translate('runtime.host.legacyEstimate')
  if (field === 'free_memory_bytes') return translate('runtime.host.free')
  if (field === 'available_memory_bytes') return translate('runtime.host.availableMemory')
  if (field === 'memory_pressure') return translate('runtime.host.pressure')
  if (field === 'discrete_vram_bytes') return translate('runtime.host.discreteVram')
  return translate('runtime.host.gpuFree')
}

function fitReasonLabel(reason: RuntimeCurrentFitReason): string {
  if (reason === 'runtime_owner_unknown') return translate('runtime.fit.reason.ownerUnknown')
  if (reason === 'runtime_reference_ambiguous') return translate('runtime.fit.reason.referenceAmbiguous')
  if (reason === 'runtime_digest_missing') return translate('runtime.fit.reason.digestMissing')
  if (reason === 'runtime_context_missing') return translate('runtime.fit.reason.contextMissing')
  if (reason === 'runtime_context_mismatch') return translate('runtime.fit.reason.contextMismatch')
  if (reason === 'host_unsupported') return translate('runtime.fit.reason.hostUnsupported')
  if (reason === 'host_unavailable') return translate('runtime.fit.reason.hostUnavailable')
  if (reason === 'host_partial') return translate('runtime.fit.reason.hostPartial')
  if (reason === 'host_available_memory_unknown') return translate('runtime.fit.reason.availableUnknown')
  if (reason === 'host_pressure_unknown') return translate('runtime.fit.reason.pressureUnknown')
  if (reason === 'host_pressure_elevated') return translate('runtime.fit.reason.pressureElevated')
  if (reason === 'observation_key_unavailable') {
    return translate('runtime.fit.reason.observationKeyUnavailable')
  }
  return translate('runtime.fit.currentResidency')
}
