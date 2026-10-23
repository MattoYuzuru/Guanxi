import type {
  InstalledModelDescriptor,
  ModelCapabilityEvidence,
} from '@guanxi/contract'
import { Badge } from '../../components/ui.tsx'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

export function InstalledEvidenceSummary({
  descriptor,
}: {
  descriptor: InstalledModelDescriptor
}) {
  const evidence = descriptor.capabilities
  const freshness = evidenceFreshness(descriptor)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" aria-label={translate('models.evidence.label')}>
      <Badge tone={evidenceTone(evidence)}>{evidenceState(evidence)}</Badge>
      <Badge tone={freshnessTone(freshness)}>
        {freshnessState(freshness)}
      </Badge>
      <Badge tone="outline">{evidenceSources(evidence)}</Badge>
      <span className="text-2xs text-muted">
        {translate('models.evidence.observed')} {formatDateTime(evidence.observedAt)}
      </span>
    </div>
  )
}

export function InstalledEvidenceDetails({
  descriptor,
}: {
  descriptor: InstalledModelDescriptor
}) {
  const evidence = descriptor.capabilities
  const freshness = evidenceFreshness(descriptor)
  return (
    <div className="space-y-3 text-2xs">
      <dl className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
        <dt className="text-muted">{translate('models.evidence.reference')}</dt>
        <dd className="min-w-0 break-all font-mono">
          {descriptor.reference.state === 'canonical'
            ? descriptor.reference.normalized
            : translate('models.evidence.unknown')}
        </dd>
        <dt className="text-muted">{translate('models.evidence.artifact')}</dt>
        <dd className="min-w-0 break-all font-mono">
          {descriptor.artifact.state === 'exact_digest'
            ? descriptor.artifact.digest
            : translate('models.evidence.unknown')}
        </dd>
        <dt className="text-muted">{translate('models.evidence.installation')}</dt>
        <dd>
          {descriptor.installation.state === 'installed'
            ? translate('models.evidence.installed')
            : translate('models.evidence.unknown')}
         , {evidenceSourceLabel(descriptor.installation.source)},{' '}
          {formatDateTime(descriptor.installation.observedAt)}
        </dd>
        <dt className="text-muted">{translate('models.evidence.capabilities')}</dt>
        <dd className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone={evidenceTone(evidence)}>{evidenceState(evidence)}</Badge>
            <span>{evidenceReason(evidence)}</span>
          </div>
          {evidence.declarations.length === 0 ? (
            <p>{translate('models.evidence.noDeclarations')}</p>
          ) : (
            <ul className="space-y-1.5">
              {evidence.declarations.map((declaration) => (
                <li
                  key={`${declaration.source}:${declaration.observedAt}`}
                  className="rounded-md border border-divider bg-inset p-2"
                >
                  <span className="font-medium">
                    {evidenceSourceLabel(declaration.source)}
                  </span>
                 , {translate('models.evidence.declaredConfidence')},{' '}
                  {formatDateTime(declaration.observedAt)}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {declaration.capabilities.length === 0 ? (
                      <span>{translate('models.evidence.emptyDeclaration')}</span>
                    ) : declaration.capabilities.map((capability) => (
                      <Badge key={capability} tone="accent">{capability}</Badge>
                    ))}
                  </div>
                  <p className="mt-1 break-all text-secondary">
                    {declaration.basis.artifact.state === 'exact_digest'
                      ? declaration.basis.artifact.digest
                      : translate('models.evidence.identityUnknown')}
                   , {declaration.basis.runtime.state === 'sourced'
                      ? `Ollama ${declaration.basis.runtime.version}`
                      : translate('models.evidence.runtimeUnknown')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-muted">{translate('models.evidence.freshness')}</dt>
        <dd className="space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone={freshnessTone(freshness)}>
              {freshnessState(freshness)}
            </Badge>
            <span>{freshnessSource(freshness.source)}</span>
          </div>
          <p>{freshnessExplanation(freshness)}</p>
          {freshness.observedAt ? (
            <p className="text-muted">
              {translate('models.evidence.observed')} {formatDateTime(freshness.observedAt)}
              {'validatedAt' in freshness
                ? `, ${translate('models.evidence.validated')} ${formatDateTime(freshness.validatedAt)}`
                : ''}
            </p>
          ) : null}
        </dd>
      </dl>
      <p className="text-muted">
        {translate('models.evidence.declarationBoundary')}
      </p>
    </div>
  )
}

function evidenceFreshness(
  descriptor: InstalledModelDescriptor,
): InstalledModelDescriptor['freshness'] {
  return descriptor.freshness ?? {
    state: 'unknown',
    source: 'none',
    observedAt: null,
    reason: 'legacy_response',
    offline: false,
  }
}

function evidenceTone(evidence: ModelCapabilityEvidence): 'green' | 'yellow' | 'outline' {
  if (evidence.state === 'degraded') return 'yellow'
  return 'outline'
}

function freshnessTone(
  freshness: InstalledModelDescriptor['freshness'],
): 'yellow' | 'outline' {
  return freshness.state === 'stale' || freshness.offline ? 'yellow' : 'outline'
}

function freshnessState(freshness: InstalledModelDescriptor['freshness']): string {
  if (freshness.state === 'fresh') return translate('models.evidence.freshness.fresh')
  if (freshness.state === 'stale') return translate('models.evidence.freshness.staleOffline')
  return translate('models.evidence.freshness.unknown')
}

function freshnessSource(source: InstalledModelDescriptor['freshness']['source']): string {
  if (source === 'provider') return translate('models.evidence.freshness.source.provider')
  if (source === 'process_cache') return translate('models.evidence.freshness.source.process')
  if (source === 'persistent_cache') return translate('models.evidence.freshness.source.persistent')
  return translate('models.evidence.freshness.source.none')
}

function freshnessExplanation(freshness: InstalledModelDescriptor['freshness']): string {
  if (freshness.state === 'fresh') {
    return freshness.source === 'provider'
      ? translate('models.evidence.freshness.explanation.provider')
      : translate('models.evidence.freshness.explanation.cache')
  }
  if (freshness.state === 'stale') {
    return translate('models.evidence.freshness.explanation.staleOffline')
  }
  switch (freshness.reason) {
    case 'legacy_response':
      return translate('models.evidence.freshness.reason.legacy')
    case 'identity_unavailable':
      return translate('models.evidence.freshness.reason.identityUnavailable')
    case 'identity_changed':
      return translate('models.evidence.freshness.reason.identityChanged')
    case 'provider_unavailable':
      return translate('models.evidence.freshness.reason.providerUnavailable')
    case 'provider_malformed':
    case 'conflicting_provider_data':
      return translate('models.evidence.freshness.reason.providerInvalid')
    case 'cache_expired':
      return translate('models.evidence.freshness.reason.cacheExpired')
  }
}

function evidenceState(evidence: ModelCapabilityEvidence): string {
  if (evidence.state === 'declared') return translate('models.evidence.state.declared')
  if (evidence.state === 'degraded') return translate('models.evidence.state.degraded')
  return translate('models.evidence.state.unknown')
}

function evidenceSources(evidence: ModelCapabilityEvidence): string {
  const sources = [...new Set(evidence.declarations.map((item) => item.source))]
  if (sources.length === 0) return translate('models.evidence.source.none')
  return sources.map(evidenceSourceLabel).join(' + ')
}

function evidenceSourceLabel(source: string): string {
  if (source === 'ollama_api_tags') return translate('models.evidence.source.tags')
  if (source === 'ollama_api_show') return translate('models.evidence.source.show')
  return translate('models.evidence.source.legacy')
}

function evidenceReason(evidence: ModelCapabilityEvidence): string {
  switch (evidence.reason) {
    case null:
      return translate('models.evidence.reason.matching')
    case 'artifact_identity_ambiguous':
      return translate('models.evidence.reason.identityAmbiguous')
    case 'artifact_identity_changed':
      return translate('models.evidence.reason.identityChanged')
    case 'conflicting_provider_declarations':
      return translate('models.evidence.reason.conflict')
    case 'provider_field_missing':
      return translate('models.evidence.reason.missing')
    case 'provider_malformed':
      return translate('models.evidence.reason.malformed')
    case 'provider_unavailable':
      return translate('models.evidence.reason.unavailable')
    case 'field_not_reported':
      return translate('models.evidence.reason.notReported')
    case 'legacy_response':
      return translate('models.evidence.reason.legacy')
  }
}
