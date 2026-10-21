import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogModel, CatalogVariant, PullStreamEvent } from '@guanxi/contract'
import { Button, Meter, Modal, cx } from '../../components/ui.tsx'
import { api, streamOllamaReferencePull } from '../../lib/api.ts'
import {
  formatBytes,
  formatContextLength,
  formatDateTime,
  formatPercent,
} from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'

type Progress = Extract<PullStreamEvent, { type: 'progress' }>['data']

type SelectedVariant = CatalogVariant & { normalizedName: string }

type FlowState =
  | { kind: 'idle' }
  | { kind: 'confirming'; variant: SelectedVariant }
  | { kind: 'pulling'; variant: SelectedVariant; progress: Progress | null }
  | { kind: 'cancelled'; variant: SelectedVariant }
  | { kind: 'error'; variant: SelectedVariant; message: string }
  | {
      kind: 'success'
      variant: SelectedVariant
      refresh: 'exact' | 'missing' | 'failed'
      digest: string | null
      observedAt: string | null
    }

export function CatalogVariantInstall({
  model,
  selectedContextLength,
  onInstalled,
  compareTargets = [],
  onToggleCompare,
  onPullActiveChange,
}: {
  model: CatalogModel
  selectedContextLength?: number
  onInstalled?: (name: string) => void
  compareTargets?: readonly string[]
  onToggleCompare?: (variant: CatalogVariant) => void
  onPullActiveChange?: (active: boolean) => void
}) {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null)
  const [state, setState] = useState<FlowState>({ kind: 'idle' })
  const installRef = useRef<HTMLButtonElement>(null)
  const selectedVariantRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const pullIntentRef = useRef(false)
  const mountedRef = useRef(true)

  const selected = selectedTarget === null
    ? null
    : model.variants.find((variant) => variant.normalizedName === selectedTarget) ?? null
  const active = state.kind === 'pulling'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort('catalog-variant-unmount')
    }
  }, [])

  useEffect(() => {
    if (state.kind === 'confirming') confirmRef.current?.focus()
    if (state.kind === 'pulling') cancelRef.current?.focus()
  }, [state.kind])

  // Once the refreshed catalog reports the variant installed, the footer swaps the
  // install button for links. That happens either before the dialog closes (the dialog
  // has no focus target left) or after it (the focused button disappears). In both
  // cases keep focus on the chosen variant instead of dropping it to the document.
  const selectedInstalled = selected?.installation.state === 'installed'
  useEffect(() => {
    if (state.kind !== 'idle') return
    if (document.activeElement !== null && document.activeElement !== document.body) return
    selectedVariantRef.current?.focus()
  }, [state.kind, selectedInstalled])

  useEffect(() => {
    onPullActiveChange?.(active)
    return () => {
      if (active) onPullActiveChange?.(false)
    }
  }, [active, onPullActiveChange])

  const choose = (variant: CatalogVariant) => {
    if (active || variant.normalizedName === null) return
    setSelectedTarget(variant.normalizedName)
    setState({ kind: 'idle' })
  }

  const openConfirmation = () => {
    if (!selected || selected.normalizedName === null || active) return
    setState({ kind: 'confirming', variant: selected as SelectedVariant })
  }

  const close = useCallback(() => {
    if (active) return
    setState({ kind: 'idle' })
  }, [active])

  const start = async (variant: SelectedVariant) => {
    if (pullIntentRef.current) return
    pullIntentRef.current = true
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ kind: 'pulling', variant, progress: null })
    try {
      let completed = false
      for await (const event of streamOllamaReferencePull({
        reference: variant.normalizedName,
        confirmedModelName: variant.normalizedName,
      }, controller.signal)) {
        if (!mountedRef.current) return
        if (event.type === 'progress') {
          setState({ kind: 'pulling', variant, progress: event.data })
        } else if (event.type === 'error') {
          setState({ kind: 'error', variant, message: pullError(event.data.code) })
          return
        } else {
          completed = true
        }
      }
      if (controller.signal.aborted) {
        if (mountedRef.current) setState({ kind: 'cancelled', variant })
        return
      }
      if (!completed) {
        setState({
          kind: 'error', variant,
          message: translate('models.catalogVariant.error.protocol'),
        })
        return
      }

      try {
        const installed = await api.listModels(undefined, controller.signal)
        if (!mountedRef.current) return
        const exact = installed.models.filter(
          (entry) =>
            entry.descriptor.reference.state === 'canonical'
            && entry.descriptor.reference.normalized === variant.normalizedName
            && entry.descriptor.artifact.state === 'exact_digest'
            && entry.descriptor.installation.state === 'installed',
        )
        const artifact = exact.length === 1 ? exact[0]!.descriptor.artifact : null
        const digest = artifact?.state === 'exact_digest'
          ? artifact.digest
          : null
        const installation = exact.length === 1 ? exact[0]!.descriptor.installation : null
        setState({
          kind: 'success', variant,
          refresh: digest === null ? 'missing' : 'exact',
          digest,
          observedAt:
            digest !== null && installation?.state === 'installed'
              ? installation.observedAt
              : null,
        })
        onInstalled?.(variant.normalizedName)
      } catch {
        if (controller.signal.aborted) {
          if (mountedRef.current) setState({ kind: 'cancelled', variant })
          return
        }
        if (mountedRef.current) {
          setState({
            kind: 'success', variant, refresh: 'failed', digest: null,
            observedAt: null,
          })
        }
      }
    } catch {
      if (controller.signal.aborted) {
        if (mountedRef.current) setState({ kind: 'cancelled', variant })
      } else if (mountedRef.current) {
        setState({
          kind: 'error', variant,
          message: translate('models.catalogVariant.error.connection'),
        })
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      pullIntentRef.current = false
    }
  }

  const modalVariant = 'variant' in state ? state.variant : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <fieldset className="mb-2" disabled={active}>
        <legend className="mb-1 text-2xs font-medium text-secondary">
          {translate('models.catalogVariant.choose')}
        </legend>
        <div className="space-y-1" role="group" aria-label={translate('models.catalogVariant.choose')}>
          {model.variants.map((variant, index) => {
            const selectable = variant.normalizedName !== null
            const selectedNow = selectable && variant.normalizedName === selectedTarget
            const compared = selectable && compareTargets.includes(variant.normalizedName!)
            const compareFull = compareTargets.length >= 2 && !compared
            return (
              <div key={`${variant.tag}:${index}`} className="flex min-w-0 gap-1">
                <button
                  ref={selectedNow ? selectedVariantRef : undefined}
                  type="button"
                  disabled={!selectable || active}
                  aria-pressed={selectedNow}
                  aria-label={selectable
                    ? `${translate('models.catalogVariant.select')} ${variant.tag}`
                    : `${variant.tag}: ${translate('models.catalogVariant.invalid')}`}
                  onClick={() => choose(variant)}
                  className={cx(
                    'min-h-11 min-w-0 flex-1 rounded border px-2 py-1 text-left font-mono text-2xs transition-colors sm:min-h-8',
                    selectedNow
                      ? 'border-accent bg-accent/10 text-secondary'
                      : 'border-divider text-secondary hover:border-control',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus',
                    'disabled:cursor-not-allowed disabled:opacity-45',
                  )}
                >
                  {variant.tag}
                </button>
                {onToggleCompare ? (
                  <button
                    type="button"
                    disabled={!selectable || active || compareFull}
                    data-catalog-compare-target={variant.normalizedName ?? undefined}
                    aria-pressed={compared}
                    aria-label={`${compared ? translate('catalog.compare.remove') : translate('catalog.compare.add')} ${variant.normalizedName ?? variant.tag}`}
                    onClick={() => onToggleCompare(variant)}
                    className="min-h-11 shrink-0 rounded border border-divider px-2 text-2xs hover:border-control disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-8"
                  >
                    {compared ? '−' : '+'}
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      </fieldset>

      {selected && selected.normalizedName !== null ? (
        <VariantFacts variant={selected as SelectedVariant} />
      ) : (
        <p className="mb-2 flex-1 text-2xs text-muted" role="status">
          {translate('models.catalogVariant.required')}
        </p>
      )}

      <footer className="mt-auto">
        {selected?.installation.state === 'installed' && selected.normalizedName !== null ? (
          <div className="space-y-1.5">
            <p className="break-all text-2xs text-[var(--color-fit-green)]" role="status">
              {translate('models.catalogVariant.installed')}{' '}
              <span className="font-mono">{selected.installation.digest}</span>
            </p>
            <div className="flex gap-1.5">
              <Link
                to={paths.model(selected.normalizedName)}
                className="flex h-8 flex-1 items-center justify-center rounded-md border border-control bg-surface px-3 text-xs font-medium"
              >
                {translate('models.catalogVariant.profile')}
              </Link>
              <Link
                to={`${paths.chat()}?model=${encodeURIComponent(selected.normalizedName)}${selectedContextLength === undefined ? '' : `&numCtx=${selectedContextLength}`}`}
                className="flex h-8 flex-1 items-center justify-center rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground"
              >
                {translate('models.catalogVariant.chat')}
              </Link>
            </div>
          </div>
        ) : (
          <Button
            ref={installRef}
            variant="primary"
            className="h-11 w-full sm:h-8"
            disabled={!selected || selected.normalizedName === null || active}
            onClick={openConfirmation}
          >
            {active
              ? translate('models.catalogVariant.active')
              : selected
                ? translate('models.catalogVariant.install')
                : translate('models.catalogVariant.selectFirst')}
          </Button>
        )}
      </footer>

      <Modal
        open={state.kind !== 'idle'}
        onClose={close}
        title={translate('models.catalogVariant.title')}
        describedBy={state.kind === 'confirming' ? 'catalog-variant-confirm-description' : undefined}
        returnFocusRef={installRef}
        dismissable={!active}
        closeLabel={translate('models.catalogVariant.close')}
        footer={
          state.kind === 'confirming' ? (
            <>
              <Button variant="ghost" onClick={close}>
                {translate('models.catalogVariant.back')}
              </Button>
              <Button
                ref={confirmRef}
                variant="primary"
                aria-label={translate('models.catalogVariant.confirm.aria')}
                onClick={() => void start(state.variant)}
              >
                {translate('models.catalogVariant.confirm')}
              </Button>
            </>
          ) : state.kind === 'pulling' ? (
            <Button
              ref={cancelRef}
              variant="secondary"
              onClick={() => controllerRef.current?.abort('explicit-cancel')}
            >
              {translate('models.catalogVariant.cancel')}
            </Button>
          ) : state.kind === 'error' || state.kind === 'cancelled' ? (
            <>
              <Button variant="ghost" onClick={close}>
                {translate('models.catalogVariant.close.short')}
              </Button>
              <Button variant="primary" onClick={() => void start(state.variant)}>
                {translate('models.catalogVariant.retry')}
              </Button>
            </>
          ) : state.kind === 'success' ? (
            <Button variant="primary" onClick={close}>
              {translate('models.catalogVariant.done')}
            </Button>
          ) : undefined
        }
      >
        {state.kind === 'confirming' && modalVariant ? (
          <div className="space-y-3">
            <p id="catalog-variant-confirm-description" className="text-xs text-secondary">
              {translate('models.catalogVariant.confirm.warning')}
            </p>
            <VariantFacts variant={modalVariant} detailed />
            <p className="text-2xs text-muted">
              {translate('models.catalogVariant.mutable')}
            </p>
          </div>
        ) : null}

        {state.kind === 'pulling' ? (
          <PullProgress variant={state.variant} progress={state.progress} />
        ) : null}

        {state.kind === 'error' || state.kind === 'cancelled' ? (
          <div role="alert" className="rounded-md border border-danger/30 p-3">
            <p className="font-medium">
              {state.kind === 'cancelled'
                ? translate('models.catalogVariant.cancelled')
                : translate('models.catalogVariant.failed')}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {state.kind === 'cancelled'
                ? translate('models.catalogVariant.cancelled.detail')
                : state.message}
            </p>
          </div>
        ) : null}

        {state.kind === 'success' ? (
          <div
            role={state.refresh === 'exact' ? 'status' : 'alert'}
            className="space-y-2 rounded-md border border-divider p-3"
          >
            <p className="font-medium">{translate('models.catalogVariant.success')}</p>
            <p className="break-all font-mono text-xs">{state.variant.normalizedName}</p>
            <p className="text-xs text-secondary">
              {state.refresh === 'exact'
                ? translate('models.catalogVariant.refresh.exact')
                : state.refresh === 'missing'
                  ? translate('models.catalogVariant.refresh.missing')
                  : translate('models.catalogVariant.refresh.failed')}
            </p>
            {state.digest ? <p className="break-all font-mono text-2xs">{state.digest}</p> : null}
            {state.observedAt ? (
              <p className="text-2xs text-muted">
                {translate('models.catalogVariant.installation.observed')}{' '}
                {formatDateTime(state.observedAt)}
              </p>
            ) : null}
            <p className="text-2xs text-muted">
              {translate('models.catalogVariant.success.boundary')}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function VariantFacts({
  variant,
  detailed = false,
}: {
  variant: SelectedVariant
  detailed?: boolean
}) {
  return (
    <div className="mb-2 space-y-1.5 rounded-md border border-divider bg-inset p-2">
      <p className="break-all font-mono text-xs font-medium">{variant.normalizedName}</p>
      <p className="text-2xs text-secondary">
        {translate('models.catalogVariant.claimedSize')}: {' '}
        {variant.sizeBytes === null ? translate('models.catalogVariant.unknown') : formatBytes(variant.sizeBytes)}
        {' · '}{translate('models.catalogVariant.parameters')}: {' '}
        {variant.parameterSize ?? translate('models.catalogVariant.unknown')}
      </p>
      {variant.contextLength !== null ? (
        <p className="text-2xs text-secondary">
          {translate('models.catalogVariant.claimedContext')}: {formatContextLength(variant.contextLength)}
        </p>
      ) : null}
      <VariantFit variant={variant} />
      <p className="text-2xs text-secondary">
        {sourceLabel(variant)} · {freshnessLabel(variant)}
      </p>
      <p className="text-2xs text-secondary">
        {translate('models.catalogVariant.source.observed')}: {' '}
        {variant.sourceObservedAt
          ? formatDateTime(variant.sourceObservedAt)
          : translate('models.catalogVariant.unknown')}
        {' · '}{translate('models.catalogVariant.source.fetched')}: {' '}
        {variant.sourceFetchedAt
          ? formatDateTime(variant.sourceFetchedAt)
          : translate('models.catalogVariant.unknown')}
      </p>
      <VariantInstallation variant={variant} />
      {detailed ? (
        <p className="text-2xs text-secondary">
          {translate('models.catalogVariant.claimBoundary')}
        </p>
      ) : null}
    </div>
  )
}

function VariantInstallation({ variant }: { variant: CatalogVariant }) {
  if (variant.installation.state === 'installed') {
    return (
      <p className="text-2xs text-muted">
        {translate('models.catalogVariant.installation.installed')}{' '}
        {formatDateTime(variant.installation.observedAt)}
      </p>
    )
  }
  if (variant.installation.state === 'not_installed') {
    return (
      <p className="text-2xs text-muted">
        {translate('models.catalogVariant.installation.notInstalled')}{' '}
        {formatDateTime(variant.installation.observedAt)}
      </p>
    )
  }
  return (
    <p className="text-2xs text-secondary" role="status">
      {translate(`models.catalogVariant.installation.unknown.${variant.installation.reason}`)}
    </p>
  )
}

function VariantFit({ variant }: { variant: CatalogVariant }) {
  if (variant.fit.state === 'unknown') {
    return (
      <p className="text-2xs text-secondary" role="status">
        {variant.fit.reason === 'size_unknown'
          ? translate('models.catalogVariant.fit.sizeUnknown')
          : translate('models.catalogVariant.fit.invalid')}
      </p>
    )
  }
  const verdict = variant.fit.verdict
  return (
    <p className="text-2xs text-secondary">
      {translate(`models.catalogVariant.fit.${verdict.level}`)} · {' '}
      {formatBytes(verdict.requiredBytes)} / {formatBytes(verdict.usableBytes)} · {' '}
      {formatContextLength(verdict.contextLength)} · {translate('models.catalogVariant.fit.claimed')}
    </p>
  )
}

function PullProgress({ variant, progress }: { variant: SelectedVariant; progress: Progress | null }) {
  const percent = progress?.percent ?? null
  return (
    <div className="space-y-2" role="status" aria-live="polite" aria-atomic="true">
      <p className="font-medium">{translate('models.catalogVariant.pulling')}</p>
      <p className="break-all font-mono text-xs">{variant.normalizedName}</p>
      <p className="text-xs text-secondary">{pullStatus(progress?.status)}</p>
      {percent === null ? (
        <div
          className="sheen h-1 w-full rounded-full bg-inset"
          aria-label={translate('models.catalogVariant.progress.indeterminate')}
        />
      ) : (
        <Meter value={percent / 100} label={translate('models.catalogVariant.progress')} />
      )}
      <p className="font-mono text-2xs text-muted">
        {percent === null
          ? translate('models.catalogVariant.progress.unknown')
          : formatPercent(percent, 1)}
        {progress?.completedBytes !== null && progress?.completedBytes !== undefined
          ? ` · ${formatBytes(progress.completedBytes)}`
          : ''}
      </p>
    </div>
  )
}

function sourceLabel(variant: CatalogVariant): string {
  if (variant.source === 'local_cache') return translate('models.catalogVariant.source.cache')
  if (variant.source === 'bundled') return translate('models.catalogVariant.source.bundled')
  if (variant.source === 'remote') return translate('models.catalogVariant.source.remote')
  return translate('models.catalogVariant.source.unknown')
}

function freshnessLabel(variant: CatalogVariant): string {
  if (variant.freshness === 'fresh') return translate('models.catalogVariant.freshness.fresh')
  if (variant.freshness === 'stale') return translate('models.catalogVariant.freshness.stale')
  if (variant.freshness === 'fallback') return translate('models.catalogVariant.freshness.fallback')
  return translate('models.catalogVariant.freshness.unknown')
}

function pullStatus(status: string | undefined): string {
  const normalized = status?.toLowerCase() ?? ''
  if (normalized.includes('manifest')) return translate('models.catalogVariant.phase.manifest')
  if (normalized.includes('verif')) return translate('models.catalogVariant.phase.verifying')
  if (normalized.includes('success')) return translate('models.catalogVariant.phase.finishing')
  if (normalized.includes('download') || normalized.includes('pull')) {
    return translate('models.catalogVariant.phase.downloading')
  }
  return translate('models.catalogVariant.phase.working')
}

function pullError(code: string): string {
  if (code === 'ollama_unavailable') return translate('models.catalogVariant.error.unavailable')
  if (code === 'runtime_protocol') return translate('models.catalogVariant.error.protocol')
  return translate('models.catalogVariant.error.provider')
}
