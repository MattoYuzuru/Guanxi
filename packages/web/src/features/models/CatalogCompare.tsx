import { useId, useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogModel, CatalogVariant } from '@guanxi/contract'
import { Button, Modal } from '../../components/ui.tsx'
import { formatBytes, formatContextLength, formatDateTime } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { FactList, type Fact } from './Facts.tsx'

export interface CatalogComparisonRow {
  model: CatalogModel
  variant: CatalogVariant & { normalizedName: string }
}

export function exactCatalogRows(models: readonly CatalogModel[]): CatalogComparisonRow[] {
  const candidates = models.flatMap((model) => model.variants.flatMap((variant) =>
    variant.normalizedName === null ? [] : [{
      model,
      variant: variant as CatalogVariant & { normalizedName: string },
    }],
  ))
  const counts = new Map<string, number>()
  for (const row of candidates) {
    counts.set(row.variant.normalizedName, (counts.get(row.variant.normalizedName) ?? 0) + 1)
  }
  return candidates.filter((row) => counts.get(row.variant.normalizedName) === 1)
}

export function CatalogCompare({
  rows,
  selectedTargets,
  onRemove,
  onSwap,
}: {
  rows: readonly CatalogComparisonRow[]
  selectedTargets: readonly string[]
  onRemove: (target: string) => void
  onSwap: () => void
}) {
  // Element ids come from useId: the view can mount more than once (P3).
  const idBase = useId()
  const ids = { catalogCompareDescription: `${idBase}-catalog-compare-description` }
  const [open, setOpen] = useState(false)
  const openRef = useRef<HTMLButtonElement>(null)
  const swapRef = useRef<HTMLButtonElement>(null)
  const focusAfterRemoveRef = useRef<string | null>(null)
  const selected = useMemo(() => selectedTargets.flatMap((target) => {
    const row = rows.find((candidate) => candidate.variant.normalizedName === target)
    return row ? [row] : []
  }), [rows, selectedTargets])

  useEffect(() => {
    if (selected.length === 2) return
    setOpen(false)
    const target = focusAfterRemoveRef.current
    focusAfterRemoveRef.current = null
    if (target === null) return
    queueMicrotask(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(
        '[data-catalog-compare-target]',
      )].find((candidate) => candidate.dataset.catalogCompareTarget === target)
      button?.focus()
    })
  }, [selected.length])

  const remove = (target: string) => {
    focusAfterRemoveRef.current = selectedTargets.find((value) => value !== target) ?? null
    onRemove(target)
  }

  return (
    <>
      <Button
        ref={openRef}
        variant="secondary"
        size="sm"
        disabled={selected.length !== 2}
        onClick={() => setOpen(true)}
      >
        {translate('catalog.compare.open')} ({selected.length}/2)
      </Button>
      <Modal
        open={open && selected.length === 2}
        onClose={() => setOpen(false)}
        title={translate('catalog.compare.title')}
        describedBy={ids.catalogCompareDescription}
        returnFocusRef={openRef}
        initialFocusRef={swapRef}
        closeLabel={translate('catalog.compare.close')}
        width={920}
        footer={
          <>
            <Button ref={swapRef} variant="secondary" onClick={onSwap}>
              {translate('catalog.compare.swap')}
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              {translate('catalog.compare.done')}
            </Button>
          </>
        }
      >
        <p id={ids.catalogCompareDescription} className="mb-3 text-xs text-secondary">
          {translate('catalog.compare.description')}
        </p>
        <div className="grid min-w-0 gap-3 md:grid-cols-2" aria-label={translate('catalog.compare.region')}>
          {selected.map((row) => (
            <CompareColumn key={row.variant.normalizedName} row={row} onRemove={remove} />
          ))}
        </div>
        <p className="mt-3 text-2xs text-muted">
          {translate('catalog.compare.boundary')}
        </p>
      </Modal>
    </>
  )
}

function CompareColumn({
  row,
  onRemove,
}: {
  row: CatalogComparisonRow
  onRemove: (target: string) => void
}) {
  const variant = row.variant
  return (
    <section className="min-w-0 rounded-lg border border-divider bg-inset p-3" aria-label={variant.normalizedName}>
      <h3 className="break-all font-mono text-xs font-semibold">{variant.normalizedName}</h3>
      <FactList
        className="mt-2"
        facts={[
          { label: translate('catalog.compare.tag'), value: variant.tag, mono: true },
          { label: translate('catalog.compare.claimedSize'), value: variant.sizeBytes === null ? unknown() : formatBytes(variant.sizeBytes) },
          { label: translate('catalog.compare.parameters'), value: variant.parameterSize ?? unknown() },
          { label: translate('catalog.compare.claimedContext'), value: variant.contextLength === null ? unknown() : formatContextLength(variant.contextLength) },
          ...fitFacts(variant),
          { label: translate('catalog.compare.source'), value: sourceText(variant) },
          { label: translate('models.facts.freshness'), value: freshnessText(variant) },
          { label: translate('catalog.compare.observed'), value: variant.sourceObservedAt ? formatDateTime(variant.sourceObservedAt) : unknown() },
          { label: translate('catalog.compare.fetched'), value: variant.sourceFetchedAt ? formatDateTime(variant.sourceFetchedAt) : unknown() },
          ...installationFacts(variant),
        ]}
      />
      <Button
        variant="ghost"
        size="sm"
        className="mt-3 w-full"
        aria-label={`${translate('catalog.compare.remove')} ${variant.normalizedName}`}
        onClick={() => onRemove(variant.normalizedName)}
      >
        {translate('catalog.compare.remove')}
      </Button>
    </section>
  )
}

function fitFacts(variant: CatalogVariant): Fact[] {
  const label = translate('catalog.compare.fit')
  if (variant.fit.state === 'unknown') {
    return [{ label, value: unknown(), tone: 'warning' }, { label: translate('models.facts.reason'), value: variant.fit.reason, mono: true }]
  }
  return [
    { label, value: translate(`catalog.filters.value.${variant.fit.verdict.level}` as LocaleKey) },
    { label: translate('models.facts.basis'), value: translate('catalog.compare.claimedFitBasis'), tone: 'muted' },
    { label: translate('models.facts.context'), value: formatContextLength(variant.fit.contextLength) },
  ]
}

function installationFacts(variant: CatalogVariant): Fact[] {
  const label = translate('catalog.compare.installation')
  if (variant.installation.state === 'installed') {
    return [
      { label, value: translate('catalog.filters.value.installed') },
      { label: translate('models.facts.digest'), value: variant.installation.digest, mono: true },
      { label: translate('models.facts.observed'), value: formatDateTime(variant.installation.observedAt) },
    ]
  }
  if (variant.installation.state === 'not_installed') {
    return [
      { label, value: translate('catalog.filters.value.not_installed') },
      { label: translate('models.facts.observed'), value: formatDateTime(variant.installation.observedAt) },
    ]
  }
  return [{ label, value: unknown(), tone: 'warning' }, { label: translate('models.facts.reason'), value: variant.installation.reason, mono: true }]
}

function sourceText(variant: CatalogVariant): string {
  return variant.source === null ? unknown() : translate(`catalog.filters.value.${variant.source}` as LocaleKey)
}

function freshnessText(variant: CatalogVariant): string {
  return translate(`catalog.filters.value.${variant.freshness}` as LocaleKey)
}

function unknown(): string {
  return translate('catalog.filters.unknown')
}
