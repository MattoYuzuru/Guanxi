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
import type { ReactNode } from 'react'
import { translate } from '../../lib/locale.ts'
import './runtime.css'

/**
 * Runtime detail for the status strip's runtime popover (D-202, D-203): admission, observed models
 * and host telemetry from the one shared quiet sample. No Retry and no "refreshing" caption: the
 * sample updates in place, and a failed read keeps the last sample with one sentence that says so.
 * Facts are label and value pairs with the value emphasised and its provenance as quiet meta,
 * never joined with punctuation; sections are separated by hairlines, not nested boxes.
 */
export function RuntimeDetails({ snapshot, stale }: { snapshot: RuntimeSnapshot | null; stale: boolean }) {
  if (!snapshot) {
    return <p className="text-12 text-secondary" role="status">
      {translate(stale ? 'runtime.error.summary' : 'runtime.checking')}
    </p>
  }
  return (
    <section aria-label={translate('runtime.bar.title')} className="runtime-details">
      <AdmissionProjection snapshot={snapshot} />
      <ModelsProjection snapshot={snapshot} />
      <HostProjection host={snapshot.host} />
    </section>
  )
}

function AdmissionProjection({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const { governor } = snapshot
  return (
    <section aria-labelledby="runtime-admission-title" className="runtime-section">
      <h3 id="runtime-admission-title" className="runtime-section-title">
        {translate('runtime.admission.title')}
      </h3>
      <p className="runtime-note">{translate('runtime.admission.scope')}</p>
      <p className="runtime-note">{translate('runtime.admission.permitPolicy')}</p>
      <p className="runtime-strong">
        {governor.accepting
          ? translate('runtime.admission.open')
          : translate('runtime.admission.closed')}
      </p>
      {governor.activeLease ? (
        <div>
          <h4 className="runtime-subtitle">{translate('runtime.active.title')}</h4>
          <RuntimeFacts>
            <RuntimeFact label={translate('runtime.operation')} value={operationLabel(governor.activeLease.operation)} />
            <RuntimeFact label={translate('runtime.priority')} value={priorityLabel(governor.activeLease.priority)} />
            <RuntimeFact label={translate('runtime.model')} value={governor.activeLease.model.name} mono />
            <RuntimeFact label={translate('runtime.owner')} value={ownerLabel(governor.activeLease.owner)} />
            <RuntimeFact label={translate('runtime.context')} value={formatContextLength(governor.activeLease.requestedContext)} />
            <RuntimeFact label={translate('runtime.acquired')} value={formatDateTime(governor.activeLease.acquiredAt)} />
            <RuntimeFact label={translate('runtime.elapsed')} value={formatElapsed(governor.activeLease.acquiredAt)} />
          </RuntimeFacts>
        </div>
      ) : (
        <p className="runtime-note">{translate('runtime.active.none')}</p>
      )}

      <div>
        <h4 className="runtime-subtitle">
          {translate('runtime.queue.title')} <span className="runtime-count">{governor.queued.length}</span>
        </h4>
        {governor.queued.length === 0 ? (
          <p className="runtime-note">{translate('runtime.queue.empty')}</p>
        ) : (
          <ol className="runtime-rows" aria-label={translate('runtime.queue.title')}>
            {governor.queued.map((waiter, index) => (
              <li key={waiter.ticketId} className="runtime-row">
                <p className="runtime-row-title">
                  {translate('runtime.queue.position').replace('{position}', String(index + 1))}{' '}
                  <span className="runtime-row-kind">{operationLabel(waiter.operation)}</span>
                </p>
                <RuntimeFacts>
                  <RuntimeFact label={translate('runtime.model')} value={waiter.model.name} mono />
                  <RuntimeFact label={translate('runtime.owner')} value={ownerLabel(waiter.owner)} />
                  <RuntimeFact label={translate('runtime.priority')} value={priorityLabel(waiter.priority)} />
                  <RuntimeFact label={translate('runtime.context')} value={formatContextLength(waiter.requestedContext)} />
                  <RuntimeFact label={translate('runtime.wait')} value={formatElapsed(waiter.enqueuedAt)} />
                </RuntimeFacts>
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
    <section aria-labelledby="runtime-models-title" className="runtime-section">
      <h3 id="runtime-models-title" className="runtime-section-title">
        {translate('runtime.models.title')}
      </h3>
      <RuntimeFacts>
        <RuntimeFact label={translate('runtime.models.source')} value={translate('runtime.source.ollama')} meta={[sourceStateLabel(snapshot.source.state)]} />
      </RuntimeFacts>

      {snapshot.models === null ? (
        <p className="runtime-strong" data-tone="danger">
          {snapshot.source.state === 'incompatible'
            ? translate('runtime.models.incompatible')
            : translate('runtime.models.unavailable')}
        </p>
      ) : snapshot.models.length === 0 ? (
        <div>
          <p className="runtime-strong">{translate('runtime.empty.title')}</p>
          <p className="runtime-note">{translate('runtime.empty.summary')}</p>
        </div>
      ) : (
        <ul className="runtime-rows" aria-label={translate('runtime.models.title')}>
          {snapshot.models.map((model) => (
            <RuntimeModelRow key={`${model.normalizedName}:${model.digest ?? ''}`} model={model} />
          ))}
        </ul>
      )}

      {activeNotObserved ? (
        <p className="runtime-strong" data-tone="danger">
          {translate('runtime.active.notObserved')}
        </p>
      ) : null}
    </section>
  )
}

function RuntimeModelRow({ model }: { model: RuntimeModelObservation }) {
  const fit = model.currentFit
  return (
    <li className="runtime-row">
      <p className="runtime-row-title" data-mono="">{model.name}</p>
      <p className="runtime-note">
        {model.ownerState === 'unknown'
          ? translate('runtime.owner.unknown.warning')
          : translate('runtime.owner.active.exact')}
      </p>
      <RuntimeFacts>
        <RuntimeFact label={translate('runtime.digest')} value={model.digest ?? translate('runtime.unknown')} mono />
        <RuntimeFact label={translate('runtime.context.observed')} value={model.contextLength === null ? translate('runtime.unknown') : formatContextLength(model.contextLength)} />
        <AllocationFact label={translate('runtime.allocation.runtime')} bytes={fit.runtimeAllocationBytes} />
        <AllocationFact label={translate('runtime.allocation.accelerator')} bytes={fit.runtimeAcceleratorAllocationBytes} />
        <RuntimeFact label={translate('runtime.fit.state')} value={fit.state === 'observed' ? translate('runtime.fit.observed') : translate('runtime.fit.unknown')} />
        <RuntimeFact label={translate('runtime.fit.basis')} value={fit.state === 'observed' ? translate('runtime.fit.currentResidency') : fitReasonLabel(fit.reason)} />
        <RuntimeFact label={translate('runtime.fit.requestedContext')} value={fit.requestedContext === null ? translate('runtime.unknown') : formatContextLength(fit.requestedContext)} />
        <RuntimeFact label={translate('runtime.fit.pressure')} value={pressureLabel(fit.pressureLevel)} />
      </RuntimeFacts>
      <p className="runtime-note">{translate('runtime.fit.noFutureGuarantee')}</p>
    </li>
  )
}

function HostProjection({ host }: { host: RuntimeHostTelemetry }) {
  const nvidia = host.nvidia
  return (
    <section aria-labelledby="runtime-host-title" className="runtime-section">
      <h3 id="runtime-host-title" className="runtime-section-title">
        {translate('runtime.host.title')}
      </h3>
      <p className="runtime-strong">{hostStateLabel(host)}</p>
      <RuntimeFacts>
        <RuntimeFact label={translate('runtime.host.platform')} value={`${host.profile.platform} ${host.profile.arch}`} mono />
        <RuntimeFact label={translate('runtime.host.accelerator')} value={host.profile.accelerator} />
        {nvidia.state === 'unknown' || nvidia.state === 'unsupported' ? (
          <RuntimeFact label={translate('runtime.nvidia.devices')} value={nvidiaStateLabel(nvidia.state)} meta={[nvidiaReasonLabel(nvidia.reason)]} />
        ) : null}
        <MemoryFact label={translate('runtime.host.total')} fact={host.profile.totalMemoryBytes} />
        <MemoryFact label={translate('runtime.host.free')} fact={host.sample.freeMemoryBytes} />
        <MemoryFact label={translate('runtime.host.legacyEstimate')} fact={host.profile.legacyUsableMemoryBytes} />
        <MemoryFact label={translate('runtime.host.availableMemory')} fact={host.sample.availableMemoryBytes} />
        <RuntimeFact label={translate('runtime.host.pressure')} value={pressureLabel(host.sample.pressure.level)} />
        <MemoryFact label={translate('runtime.host.discreteVram')} fact={host.profile.discreteVramBytes} />
        <MemoryFact label={translate('runtime.host.gpuFree')} fact={host.sample.gpuFreeMemoryBytes} />
      </RuntimeFacts>
      {nvidia.state === 'unknown' || nvidia.state === 'unsupported' ? (
        <p className="runtime-note">{translate('runtime.host.devicesUnknown')}</p>
      ) : null}
      {nvidia.state === 'available' || nvidia.state === 'partial' ? (
        <section className="runtime-subsection" aria-labelledby="runtime-nvidia-devices-title">
          <h4 id="runtime-nvidia-devices-title" className="runtime-subtitle">
            {translate('runtime.nvidia.devices')}
          </h4>
          <RuntimeFacts>
            <RuntimeFact label={translate('runtime.nvidia.state')} value={nvidiaStateLabel(nvidia.state)} meta={nvidia.reason === null ? [] : [nvidiaReasonLabel(nvidia.reason)]} />
          </RuntimeFacts>
          <p className="runtime-note">{translate('runtime.nvidia.freeWarning')}</p>
          <ul className="runtime-rows runtime-scroll" aria-label={translate('runtime.nvidia.devices')}>
            {nvidia.devices.map((device) => (
              <li key={`${device.providerIndex}:${device.uuid ?? device.displayName}`} className="runtime-row">
                <p className="runtime-row-title" data-mono="">{device.displayName}</p>
                <RuntimeFacts>
                  <RuntimeFact label={translate('runtime.nvidia.index')} value={String(device.providerIndex)} mono />
                  <RuntimeFact label={translate('runtime.nvidia.uuid')} value={redactNvidiaUuid(device.uuid)} mono />
                  <MemoryFact label={translate('runtime.nvidia.totalVram')} fact={device.totalVramBytes} />
                  <MemoryFact label={translate('runtime.nvidia.freeVram')} fact={device.freeVramBytes} />
                  <RuntimeFact label={translate('runtime.nvidia.source')} value={translate('runtime.nvidia.source.smi')} />
                  <RuntimeFact label={translate('runtime.nvidia.observedAt')} value={formatDateTime(device.observedAt)} />
                  <RuntimeFact label={translate('runtime.nvidia.confidence')} value={confidenceLabel(device.confidence)} />
                </RuntimeFacts>
              </li>
            ))}
          </ul>
        </section>
      ) : nvidia.state === 'unavailable' ? (
        <p className="runtime-strong" data-tone="danger">
          {nvidiaStateLabel(nvidia.state)}{' '}
          <span className="runtime-row-kind">{nvidiaReasonLabel(nvidia.reason)}</span>
        </p>
      ) : null}
      {host.missingFields.length > 0 ? (
        <p className="runtime-note">
          {translate('runtime.host.missing')}:{' '}
          {host.missingFields.map(hostFieldLabel).join(', ')}
        </p>
      ) : null}
    </section>
  )
}

/** Runtime facts as a description list (runtime.css); shared with the resource-conflict dialog. */
export function RuntimeFacts({ children }: { children: ReactNode }) {
  return <dl className="runtime-facts">{children}</dl>
}

/** A value with its provenance as quiet meta pieces beside it, separated by space, not commas. */
export function RuntimeFact({ label, value, mono = false, meta = [] }: { label: string; value: string; mono?: boolean; meta?: readonly string[] }) {
  return (
    <div className="runtime-fact">
      <dt>{label}</dt>
      <dd>
        <span className="runtime-fact-value" data-mono={mono || undefined}>{value}</span>
        {meta.length > 0 ? <>{' '}<span className="runtime-fact-meta">{meta.map((item, index) => <span key={index}>{index > 0 ? ' ' : ''}{item}</span>)}</span></> : null}
      </dd>
    </div>
  )
}

function MemoryFact({ label, fact }: { label: string; fact: RuntimeMemoryFact }) {
  return (
    <RuntimeFact
      label={label}
      value={fact.bytes === null ? translate('runtime.unknown') : formatBytes(fact.bytes)}
      meta={[confidenceLabel(fact.confidence), memorySourceLabel(fact.source), memoryBasisLabel(fact.basis)]}
    />
  )
}

function AllocationFact({ label, bytes }: { label: string; bytes: number | null }) {
  return (
    <RuntimeFact
      label={label}
      value={bytes === null ? translate('runtime.unknown') : formatBytes(bytes)}
      meta={[translate('runtime.confidence.observed'), translate('runtime.source.ollama')]}
    />
  )
}

function formatElapsed(iso: string): string {
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp)
    ? translate('runtime.unknown')
    : formatDuration(Math.max(0, Date.now() - timestamp))
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
