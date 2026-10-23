import type {
  RuntimeCurrentFitReason,
  RuntimeHostTelemetry,
  RuntimeMemoryFact,
  RuntimeModelObservation,
  RuntimeResourceOwner,
  RuntimeResourceOperation,
  RuntimeAdmissionPriority,
  RuntimeSnapshot,
} from '@guanxi/contract'
import {
  formatBytes,
  formatContextLength,
  formatDateTime,
  formatDuration,
} from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

/**
 * Runtime detail for the status strip's runtime popover (D-202, D-203): admission, observed models
 * and host telemetry from the one shared quiet sample. No Retry and no "refreshing" caption: the
 * sample updates in place, and a failed read keeps the last sample with one sentence that says so.
 */
export function RuntimeDetails({ snapshot, stale }: { snapshot: RuntimeSnapshot | null; stale: boolean }) {
  if (!snapshot) {
    return <p className="text-12 text-secondary" role="status">
      {translate(stale ? 'runtime.error.summary' : 'runtime.checking')}
    </p>
  }
  return (
    <section aria-label={translate('runtime.bar.title')} className="flex min-w-0 flex-col gap-2">
      <AdmissionProjection snapshot={snapshot} />
      <ModelsProjection snapshot={snapshot} />
      <HostProjection host={snapshot.host} />
    </section>
  )
}

function AdmissionProjection({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const { governor } = snapshot
  return (
    <section
      aria-labelledby="runtime-admission-title"
      className="min-w-0 rounded-md border border-divider bg-canvas p-2 text-2xs"
    >
      <h3 id="runtime-admission-title" className="font-semibold">
        {translate('runtime.admission.title')}
      </h3>
      <p className="mt-0.5 text-muted">
        {translate('runtime.admission.scope')}
      </p>
      <p className="mt-0.5 text-muted">
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
          <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-secondary">
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
        <p className="mt-2 text-secondary">{translate('runtime.active.none')}</p>
      )}

      <div className="mt-2">
        <h4 className="font-medium">
          {translate('runtime.queue.title')} ({governor.queued.length})
        </h4>
        {governor.queued.length === 0 ? (
          <p className="mt-1 text-secondary">{translate('runtime.queue.empty')}</p>
        ) : (
          <ol className="mt-1 space-y-1">
            {governor.queued.map((waiter, index) => (
              <li
                key={waiter.ticketId}
                className="min-w-0 border-l-2 border-control pl-2"
              >
                <p className="font-medium">
                  {translate('runtime.queue.position').replace('{position}', String(index + 1))}{' '}
                  · {operationLabel(waiter.operation)}
                </p>
                <p className="break-words font-mono text-secondary">
                  {waiter.model.name}
                </p>
                <p className="text-secondary">
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
      className="min-w-0 rounded-md border border-divider bg-canvas p-2 text-2xs"
    >
      <h3 id="runtime-models-title" className="font-semibold">
        {translate('runtime.models.title')}
      </h3>
      <p className="mt-0.5 text-muted">
        {sourceStateLabel(snapshot.source.state)} · {translate('runtime.source.ollama')}
      </p>

      {snapshot.models === null ? (
        <p className="mt-2 font-medium text-danger">
          {snapshot.source.state === 'incompatible'
            ? translate('runtime.models.incompatible')
            : translate('runtime.models.unavailable')}
        </p>
      ) : snapshot.models.length === 0 ? (
        <div className="mt-2">
          <p className="font-medium">{translate('runtime.empty.title')}</p>
          <p className="text-secondary">{translate('runtime.empty.summary')}</p>
        </div>
      ) : (
        <ul className="mt-2 space-y-2" aria-label={translate('runtime.models.title')}>
          {snapshot.models.map((model) => (
            <RuntimeModelRow key={`${model.normalizedName}:${model.digest ?? ''}`} model={model} />
          ))}
        </ul>
      )}

      {activeNotObserved ? (
        <p className="mt-2 font-medium text-danger">
          {translate('runtime.active.notObserved')}
        </p>
      ) : null}
    </section>
  )
}

function RuntimeModelRow({ model }: { model: RuntimeModelObservation }) {
  const fit = model.currentFit
  return (
    <li className="min-w-0 border-l-2 border-control pl-2">
      <p className="break-words font-mono font-medium">{model.name}</p>
      <p className="text-secondary">
        {model.ownerState === 'unknown'
          ? translate('runtime.owner.unknown.warning')
          : translate('runtime.owner.active.exact')}
      </p>
      <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-secondary">
        <Fact label={translate('runtime.digest')} value={model.digest ?? translate('runtime.unknown')} mono />
        <Fact label={translate('runtime.context.observed')} value={model.contextLength === null ? translate('runtime.unknown') : formatContextLength(model.contextLength)} />
        <Fact label={translate('runtime.allocation.runtime')} value={allocationLabel(fit.runtimeAllocationBytes)} />
        <Fact label={translate('runtime.allocation.accelerator')} value={allocationLabel(fit.runtimeAcceleratorAllocationBytes)} />
        <Fact label={translate('runtime.fit.state')} value={fit.state === 'observed' ? translate('runtime.fit.observed') : translate('runtime.fit.unknown')} />
        <Fact label={translate('runtime.fit.basis')} value={fit.state === 'observed' ? translate('runtime.fit.currentResidency') : fitReasonLabel(fit.reason)} />
        <Fact label={translate('runtime.fit.requestedContext')} value={fit.requestedContext === null ? translate('runtime.unknown') : formatContextLength(fit.requestedContext)} />
        <Fact label={translate('runtime.fit.pressure')} value={pressureLabel(fit.pressureLevel)} />
      </dl>
      <p className="mt-1 text-muted">
        {translate('runtime.fit.noFutureGuarantee')}
      </p>
    </li>
  )
}

function HostProjection({ host }: { host: RuntimeHostTelemetry }) {
  const nvidia = host.nvidia
  return (
    <section
      aria-labelledby="runtime-host-title"
      className="min-w-0 rounded-md border border-divider bg-canvas p-2 text-2xs"
    >
      <h3 id="runtime-host-title" className="font-semibold">
        {translate('runtime.host.title')}
      </h3>
      <p className="mt-0.5 font-medium">{hostStateLabel(host)}</p>
      <p className="text-muted">
        {host.profile.platform}/{host.profile.arch} · {host.profile.accelerator}
      </p>
      {nvidia.state === 'unknown' || nvidia.state === 'unsupported' ? (
        <p className="text-muted">
          {nvidiaStateLabel(nvidia.state)} · {nvidiaReasonLabel(nvidia.reason)} ·{' '}
          {translate('runtime.host.devicesUnknown')}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-secondary">
        <MemoryFact label={translate('runtime.host.total')} fact={host.profile.totalMemoryBytes} />
        <MemoryFact label={translate('runtime.host.free')} fact={host.sample.freeMemoryBytes} />
        <MemoryFact label={translate('runtime.host.legacyEstimate')} fact={host.profile.legacyUsableMemoryBytes} />
        <MemoryFact label={translate('runtime.host.availableMemory')} fact={host.sample.availableMemoryBytes} />
        <Fact label={translate('runtime.host.pressure')} value={pressureLabel(host.sample.pressure.level)} />
        <MemoryFact label={translate('runtime.host.discreteVram')} fact={host.profile.discreteVramBytes} />
        <MemoryFact label={translate('runtime.host.gpuFree')} fact={host.sample.gpuFreeMemoryBytes} />
      </dl>
      {nvidia.state === 'available' || nvidia.state === 'partial' ? (
        <section className="mt-3 min-w-0" aria-labelledby="runtime-nvidia-devices-title">
          <h4 id="runtime-nvidia-devices-title" className="font-semibold">
            {translate('runtime.nvidia.devices')}
          </h4>
          <p className="text-muted">
            {nvidiaStateLabel(nvidia.state)}
            {nvidia.reason === null ? '' : ` · ${nvidiaReasonLabel(nvidia.reason)}`} ·{' '}
            {translate('runtime.nvidia.freeWarning')}
          </p>
          <ul
            className="mt-1 max-h-48 min-w-0 space-y-2 overflow-y-auto overscroll-contain pr-1"
            aria-label={translate('runtime.nvidia.devices')}
          >
            {nvidia.devices.map((device) => (
              <li
                key={`${device.providerIndex}:${device.uuid ?? device.displayName}`}
                className="min-w-0 border-l-2 border-control pl-2"
              >
                <p className="break-words font-mono font-medium">{device.displayName}</p>
                <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-secondary">
                  <Fact label={translate('runtime.nvidia.index')} value={String(device.providerIndex)} mono />
                  <Fact label={translate('runtime.nvidia.uuid')} value={redactNvidiaUuid(device.uuid)} mono />
                  <MemoryFact label={translate('runtime.nvidia.totalVram')} fact={device.totalVramBytes} />
                  <MemoryFact label={translate('runtime.nvidia.freeVram')} fact={device.freeVramBytes} />
                  <Fact label={translate('runtime.nvidia.source')} value={translate('runtime.nvidia.source.smi')} />
                  <Fact label={translate('runtime.nvidia.observedAt')} value={formatDateTime(device.observedAt)} />
                  <Fact label={translate('runtime.nvidia.confidence')} value={confidenceLabel(device.confidence)} />
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : nvidia.state === 'unavailable' ? (
        <p className="mt-2 font-medium text-danger">
          {nvidiaStateLabel(nvidia.state)} · {nvidiaReasonLabel(nvidia.reason)}
        </p>
      ) : null}
      {host.missingFields.length > 0 ? (
        <p className="mt-2 text-muted">
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
  if (source === 'nvidia_smi_memory_total') return translate('runtime.memory.source.nvidiaTotal')
  if (source === 'nvidia_smi_memory_free') return translate('runtime.memory.source.nvidiaFree')
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
  if (basis === 'device_total_vram') return translate('runtime.memory.basis.deviceTotalVram')
  if (basis === 'device_free_vram_not_safe_capacity') return translate('runtime.memory.basis.deviceFreeVram')
  return translate('runtime.memory.basis.gpuFreeUnknown')
}

function hostFieldLabel(field: RuntimeHostTelemetry['missingFields'][number]): string {
  if (field === 'total_unified_memory_bytes') return translate('runtime.host.total')
  if (field === 'total_system_memory_bytes') return translate('runtime.host.total')
  if (field === 'legacy_usable_memory_estimate_bytes') return translate('runtime.host.legacyEstimate')
  if (field === 'free_memory_bytes') return translate('runtime.host.free')
  if (field === 'available_memory_bytes') return translate('runtime.host.availableMemory')
  if (field === 'memory_pressure') return translate('runtime.host.pressure')
  if (field === 'discrete_vram_bytes') return translate('runtime.host.discreteVram')
  if (field === 'gpu_free_memory_bytes') return translate('runtime.host.gpuFree')
  return translate('runtime.nvidia.devices')
}

function nvidiaStateLabel(state: RuntimeHostTelemetry['nvidia']['state']): string {
  if (state === 'available') return translate('runtime.nvidia.available')
  if (state === 'partial') return translate('runtime.nvidia.partial')
  if (state === 'unavailable') return translate('runtime.nvidia.unavailable')
  if (state === 'unsupported') return translate('runtime.nvidia.unsupported')
  return translate('runtime.nvidia.unknown')
}

function redactNvidiaUuid(uuid: string | null): string {
  if (uuid === null) return translate('runtime.unknown')
  const body = uuid.slice(4)
  const suffix = body.length > 8 ? body.slice(-8) : body.slice(-4)
  return `GPU-…${suffix}`
}

function nvidiaReasonLabel(reason: RuntimeHostTelemetry['nvidia']['reason']): string {
  if (reason === 'legacy_snapshot') return translate('runtime.nvidia.reason.legacy')
  if (reason === 'platform_not_linux') return translate('runtime.nvidia.reason.platform')
  if (reason === 'nvidia_not_detected') return translate('runtime.nvidia.reason.notDetected')
  if (reason === 'command_missing') return translate('runtime.nvidia.reason.commandMissing')
  if (reason === 'command_failed') return translate('runtime.nvidia.reason.commandFailed')
  if (reason === 'timeout') return translate('runtime.nvidia.reason.timeout')
  if (reason === 'output_limit') return translate('runtime.nvidia.reason.outputLimit')
  if (reason === 'all_rows_malformed') return translate('runtime.nvidia.reason.allMalformed')
  if (reason === 'some_rows_malformed') return translate('runtime.nvidia.reason.someMalformed')
  if (reason === 'device_identity_partial') return translate('runtime.nvidia.reason.identityPartial')
  if (reason === 'inconsistent_rows') return translate('runtime.nvidia.reason.inconsistent')
  return translate('runtime.unknown')
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
