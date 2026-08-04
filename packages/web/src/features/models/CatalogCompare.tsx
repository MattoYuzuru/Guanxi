import { useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogModel, CatalogVariant } from '@alamo/contract'
import { Button, Modal } from '../../components/ui.tsx'
import { formatBytes, formatContextLength, formatDateTime } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'

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
  const [open, setOpen] = useState(false)
  const openRef = useRef<HTMLButtonElement>(null)
  const swapRef = useRef<HTMLButtonElement>(null)
  const selected = useMemo(() => selectedTargets.flatMap((target) => {
    const row = rows.find((candidate) => candidate.variant.normalizedName === target)
    return row ? [row] : []
  }), [rows, selectedTargets])

  useEffect(() => {
    if (selected.length !== 2) setOpen(false)
  }, [selected.length])

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
        describedBy="catalog-compare-description"
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
        <p id="catalog-compare-description" className="mb-3 text-xs text-[var(--fg-muted)]">
          {translate('catalog.compare.description')}
        </p>
        <div className="grid min-w-0 gap-3 md:grid-cols-2" aria-label={translate('catalog.compare.region')}>
          {selected.map((row) => (
            <CompareColumn key={row.variant.normalizedName} row={row} onRemove={onRemove} />
          ))}
        </div>
        <p className="mt-3 text-2xs text-[var(--fg-subtle)]">
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
    <section className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-inset)] p-3" aria-label={variant.normalizedName}>
      <h3 className="break-all font-mono text-xs font-semibold">{variant.normalizedName}</h3>
      <p className="mt-1 text-2xs text-[var(--fg-muted)]">
        {translate('catalog.compare.tag')}: <span className="font-mono">{variant.tag}</span>
      </p>
      <Fact label={translate('catalog.compare.claimedSize')} value={variant.sizeBytes === null ? unknown() : formatBytes(variant.sizeBytes)} />
      <Fact label={translate('catalog.compare.parameters')} value={variant.parameterSize ?? unknown()} />
      <Fact label={translate('catalog.compare.claimedContext')} value={variant.contextLength === null ? unknown() : formatContextLength(variant.contextLength)} />
      <Fact label={translate('catalog.compare.fit')} value={fitText(variant)} />
      <Fact label={translate('catalog.compare.source')} value={`${sourceText(variant)} · ${freshnessText(variant)}`} />
      <Fact label={translate('catalog.compare.observed')} value={variant.sourceObservedAt ? formatDateTime(variant.sourceObservedAt) : unknown()} />
      <Fact label={translate('catalog.compare.fetched')} value={variant.sourceFetchedAt ? formatDateTime(variant.sourceFetchedAt) : unknown()} />
      <Fact label={translate('catalog.compare.installation')} value={installationText(variant)} />
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p className="mt-2 min-w-0 text-2xs">
      <span className="block font-medium text-[var(--fg-muted)]">{label}</span>
      <span className="block break-words text-[var(--fg)]">{value}</span>
    </p>
  )
}

function fitText(variant: CatalogVariant): string {
  if (variant.fit.state === 'unknown') return `${unknown()} · ${variant.fit.reason}`
  return `${translate(`catalog.filters.value.${variant.fit.verdict.level}` as LocaleKey)} · ${translate('catalog.compare.claimedFitBasis')} · ${formatContextLength(variant.fit.contextLength)}`
}

function installationText(variant: CatalogVariant): string {
  if (variant.installation.state === 'installed') {
    return `${translate('catalog.filters.value.installed')} · ${variant.installation.digest} · ${formatDateTime(variant.installation.observedAt)}`
  }
  if (variant.installation.state === 'not_installed') {
    return `${translate('catalog.filters.value.not_installed')} · ${formatDateTime(variant.installation.observedAt)}`
  }
  return `${unknown()} · ${variant.installation.reason}`
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
