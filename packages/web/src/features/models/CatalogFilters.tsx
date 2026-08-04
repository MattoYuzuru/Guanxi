import { useEffect, useState } from 'react'
import type {
  CatalogCapabilityFilter,
  CatalogFitFilter,
  CatalogFreshnessFilter,
  CatalogInstallationFilter,
  CatalogProviderScopeFilter,
  CatalogSourceFilter,
  ListCatalogQuery,
} from '@alamo/contract'
import { Button, Input } from '../../components/ui.tsx'
import { formatBytes, formatContextLength } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

export interface CatalogFilterState {
  installation: CatalogInstallationFilter[]
  fit: CatalogFitFilter[]
  providerScope: CatalogProviderScopeFilter[]
  source: CatalogSourceFilter[]
  freshness: CatalogFreshnessFilter[]
  capability: CatalogCapabilityFilter[]
  minClaimedContext?: number
  contextUnknown: boolean
  maxClaimedArtifactSize?: number
  artifactSizeUnknown: boolean
}

export const EMPTY_CATALOG_FILTERS: CatalogFilterState = {
  installation: [], fit: [], providerScope: [], source: [], freshness: [],
  capability: [], contextUnknown: false, artifactSizeUnknown: false,
}

export function catalogFilterQuery(filters: CatalogFilterState): ListCatalogQuery {
  return {
    installation: filters.installation,
    fit: filters.fit,
    providerScope: filters.providerScope,
    source: filters.source,
    freshness: filters.freshness,
    capability: filters.capability,
    minClaimedContext: filters.contextUnknown ? undefined : filters.minClaimedContext,
    contextClaim: filters.contextUnknown ? 'unknown' : undefined,
    maxClaimedArtifactSize:
      filters.artifactSizeUnknown ? undefined : filters.maxClaimedArtifactSize,
    artifactSizeClaim: filters.artifactSizeUnknown ? 'unknown' : undefined,
  }
}

export function hasCatalogFilters(filters: CatalogFilterState): boolean {
  return Object.values(catalogFilterQuery(filters)).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  )
}

export function CatalogFilters({
  value,
  onChange,
  onClear,
}: {
  value: CatalogFilterState
  onChange: (value: CatalogFilterState) => void
  onClear: () => void
}) {
  const [contextDraft, setContextDraft] = useState(
    value.minClaimedContext === undefined ? '' : String(value.minClaimedContext),
  )
  const [sizeDraft, setSizeDraft] = useState(
    value.maxClaimedArtifactSize === undefined ? '' : String(value.maxClaimedArtifactSize),
  )
  const [contextError, setContextError] = useState(false)
  const [sizeError, setSizeError] = useState(false)

  useEffect(() => {
    setContextDraft(value.minClaimedContext === undefined ? '' : String(value.minClaimedContext))
    setSizeDraft(value.maxClaimedArtifactSize === undefined ? '' : String(value.maxClaimedArtifactSize))
    setContextError(false)
    setSizeError(false)
  }, [value.minClaimedContext, value.maxClaimedArtifactSize])

  const applyNumber = (
    draft: string,
    key: 'minClaimedContext' | 'maxClaimedArtifactSize',
    setError: (value: boolean) => void,
  ) => {
    if (draft.trim() === '') {
      setError(false)
      onChange({ ...value, [key]: undefined })
      return
    }
    const parsed = Number(draft)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      setError(true)
      return
    }
    setError(false)
    onChange({ ...value, [key]: parsed })
  }

  return (
    <div className="min-w-0">
      <details className="group rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <span>{translate('catalog.filters.open')}</span>
          <span aria-hidden="true" className="text-[var(--fg-subtle)] group-open:rotate-180">⌄</span>
        </summary>
        <div className="grid min-w-0 gap-4 border-t border-[var(--border)] p-3 sm:grid-cols-2 lg:grid-cols-3">
          <CheckboxGroup
            legend={translate('catalog.filters.installation')}
            values={INSTALLATION_OPTIONS}
            selected={value.installation}
            onToggle={(next) => onChange({ ...value, installation: next })}
          />
          <CheckboxGroup
            legend={translate('catalog.filters.fit')}
            values={FIT_OPTIONS}
            selected={value.fit}
            onToggle={(next) => onChange({ ...value, fit: next })}
          />
          <CheckboxGroup
            legend={translate('catalog.filters.scope')}
            values={SCOPE_OPTIONS}
            selected={value.providerScope}
            onToggle={(next) => onChange({ ...value, providerScope: next })}
          />
          <CheckboxGroup
            legend={translate('catalog.filters.source')}
            values={SOURCE_OPTIONS}
            selected={value.source}
            onToggle={(next) => onChange({ ...value, source: next })}
          />
          <CheckboxGroup
            legend={translate('catalog.filters.freshness')}
            values={FRESHNESS_OPTIONS}
            selected={value.freshness}
            onToggle={(next) => onChange({ ...value, freshness: next })}
          />
          <CheckboxGroup
            legend={translate('catalog.filters.capability')}
            values={CAPABILITY_OPTIONS}
            selected={value.capability}
            onToggle={(next) => onChange({ ...value, capability: next })}
          />
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-2xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
              {translate('catalog.filters.claimedContext')}
            </legend>
            <label className="block text-2xs text-[var(--fg-muted)]">
              {translate('catalog.filters.minimum')}
              <Input
                className="mt-1 w-full"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={contextDraft}
                disabled={value.contextUnknown}
                aria-invalid={contextError}
                onChange={(event) => setContextDraft(event.target.value)}
                onBlur={() => applyNumber(contextDraft, 'minClaimedContext', setContextError)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  applyNumber(contextDraft, 'minClaimedContext', setContextError)
                }}
              />
            </label>
            <UnknownToggle
              checked={value.contextUnknown}
              onChange={(checked) => onChange({
                ...value, contextUnknown: checked,
                minClaimedContext: checked ? undefined : value.minClaimedContext,
              })}
            />
            {contextError ? <ValidationError /> : null}
          </fieldset>
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-2xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
              {translate('catalog.filters.claimedSize')}
            </legend>
            <label className="block text-2xs text-[var(--fg-muted)]">
              {translate('catalog.filters.maximumBytes')}
              <Input
                className="mt-1 w-full"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={sizeDraft}
                disabled={value.artifactSizeUnknown}
                aria-invalid={sizeError}
                onChange={(event) => setSizeDraft(event.target.value)}
                onBlur={() => applyNumber(sizeDraft, 'maxClaimedArtifactSize', setSizeError)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  applyNumber(sizeDraft, 'maxClaimedArtifactSize', setSizeError)
                }}
              />
            </label>
            <UnknownToggle
              checked={value.artifactSizeUnknown}
              onChange={(checked) => onChange({
                ...value, artifactSizeUnknown: checked,
                maxClaimedArtifactSize: checked ? undefined : value.maxClaimedArtifactSize,
              })}
            />
            {sizeError ? <ValidationError /> : null}
          </fieldset>
        </div>
      </details>

      {hasCatalogFilters(value) ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" aria-label={translate('catalog.filters.applied')}>
          {filterSummary(value).map((item) => (
            <span key={item} className="max-w-full break-words rounded-full border border-[var(--border)] bg-[var(--bg-inset)] px-2 py-1 text-2xs">
              {item}
            </span>
          ))}
          <Button variant="ghost" size="sm" onClick={onClear}>
            {translate('catalog.filters.clear')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function CheckboxGroup<T extends string>({
  legend, values, selected, onToggle,
}: {
  legend: string
  values: readonly T[]
  selected: readonly T[]
  onToggle: (values: T[]) => void
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">{legend}</legend>
      <div className="grid grid-cols-2 gap-1.5">
        {values.map((option) => (
          <label key={option} className="flex min-h-8 items-center gap-2 text-2xs">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => onToggle(
                selected.includes(option)
                  ? selected.filter((value) => value !== option)
                  : [...selected, option],
              )}
            />
            <span>{filterValueLabel(option)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function UnknownToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-8 items-center gap-2 text-2xs">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{translate('catalog.filters.explicitUnknown')}</span>
    </label>
  )
}

function ValidationError() {
  return <p role="alert" className="text-2xs text-[var(--danger)]">{translate('catalog.filters.invalidNumber')}</p>
}

export function filterSummary(value: CatalogFilterState): string[] {
  const result: string[] = []
  const add = (label: string, values: readonly string[]) => {
    if (values.length) result.push(`${label}: ${values.map(filterValueLabel).join(', ')}`)
  }
  add(translate('catalog.filters.installation'), value.installation)
  add(translate('catalog.filters.fit'), value.fit)
  add(translate('catalog.filters.scope'), value.providerScope)
  add(translate('catalog.filters.source'), value.source)
  add(translate('catalog.filters.freshness'), value.freshness)
  add(translate('catalog.filters.capability'), value.capability)
  if (value.contextUnknown) result.push(`${translate('catalog.filters.claimedContext')}: ${translate('catalog.filters.unknown')}`)
  else if (value.minClaimedContext !== undefined) result.push(`${translate('catalog.filters.claimedContext')} ≥ ${formatContextLength(value.minClaimedContext)}`)
  if (value.artifactSizeUnknown) result.push(`${translate('catalog.filters.claimedSize')}: ${translate('catalog.filters.unknown')}`)
  else if (value.maxClaimedArtifactSize !== undefined) result.push(`${translate('catalog.filters.claimedSize')} ≤ ${formatBytes(value.maxClaimedArtifactSize)}`)
  return result
}

function filterValueLabel(value: string): string {
  return translate(`catalog.filters.value.${value}` as FilterValueKey)
}

type FilterValueKey =
  | 'catalog.filters.value.installed' | 'catalog.filters.value.not_installed'
  | 'catalog.filters.value.unknown' | 'catalog.filters.value.green'
  | 'catalog.filters.value.yellow' | 'catalog.filters.value.red'
  | 'catalog.filters.value.local' | 'catalog.filters.value.cloud'
  | 'catalog.filters.value.local_cache' | 'catalog.filters.value.bundled'
  | 'catalog.filters.value.remote' | 'catalog.filters.value.fresh'
  | 'catalog.filters.value.stale' | 'catalog.filters.value.fallback'
  | 'catalog.filters.value.completion' | 'catalog.filters.value.tools'
  | 'catalog.filters.value.vision' | 'catalog.filters.value.insert'
  | 'catalog.filters.value.thinking' | 'catalog.filters.value.embedding'

const INSTALLATION_OPTIONS: readonly CatalogInstallationFilter[] = ['installed', 'not_installed', 'unknown']
const FIT_OPTIONS: readonly CatalogFitFilter[] = ['green', 'yellow', 'red', 'unknown']
const SCOPE_OPTIONS: readonly CatalogProviderScopeFilter[] = ['local', 'cloud']
const SOURCE_OPTIONS: readonly CatalogSourceFilter[] = ['local_cache', 'bundled', 'remote']
const FRESHNESS_OPTIONS: readonly CatalogFreshnessFilter[] = ['fresh', 'stale', 'fallback', 'unknown']
const CAPABILITY_OPTIONS: readonly CatalogCapabilityFilter[] = ['completion', 'tools', 'vision', 'insert', 'thinking', 'embedding', 'unknown']
