/**
 * Профиль модели: детали, шаблон, лицензия, слайдер окна и прогрев.
 *
 * Preset slider uses the bounded server projection. A custom value performs one
 * explicit on-demand request, so suggestions never become a hidden whitelist.
 */
import { useMemo, useState } from 'react'
import type { FitVerdict, Health, ModelCapabilityOverrideOutcome, ModelDetail, RunningModel } from '@guanxi/contract'
import { DEFAULT_CHAT_NUM_CTX } from '@guanxi/contract'
import { api, errorMessage } from '../../lib/api.ts'
import { useAsync } from '../../lib/useAsync.ts'
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  Input,
  Skeleton,
  StepSlider,
  Stat,
  cx,
} from '../../components/ui.tsx'
import { Link, paths, useNavigate } from '../../lib/router.tsx'
import {
  formatBytes,
  formatContextLength,
  formatDateTime,
  formatRelativeTime,
} from '../../lib/format.ts'
import { FitIndicator } from './FitIndicator.tsx'
import { exceedsDeclaredContextLimit, parsePositiveSafeInteger } from '../../lib/contextLength.ts'
import { translate } from '../../lib/locale.ts'
import { InstalledEvidenceDetails } from './InstalledEvidence.tsx'
import { CompletionProbe } from './CompletionProbe.tsx'
import { CapabilityOverrides } from './CapabilityOverrides.tsx'

export function ModelPage({ name, health }: { name: string; health: Health }) {
  const navigate = useNavigate()
  const [requestedContext, setRequestedContext] = useState<number | undefined>(undefined)
  const detail = useAsync(
    (signal) => api.getModel(name, requestedContext, signal),
    [name, requestedContext],
  )

  // A drift conflict from the override region survives the re-read (which remounts the profile).
  const [carriedOutcome, setCarriedOutcome] = useState<ModelCapabilityOverrideOutcome | null>(null)

  if (detail.loading) return <ModelSkeleton />

  if (detail.error || !detail.data) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-6">
        <Callout tone="danger" title={translate('model.error')}>
          {errorMessage(detail.error)}
          <span className="mt-1 block">{translate('common.recovering')}</span>
        </Callout>
        <Link
          to={paths.launcher()}
          className="mt-3 inline-block text-xs text-accent underline underline-offset-2"
        >
          {translate('model.back')}
        </Link>
      </div>
    )
  }

  return (
    <ModelProfile
      key={`${detail.data.digest}:${requestedContext ?? 'default'}:${detail.data.fit.contextLength}`}
      model={detail.data}
      health={health}
      requestedContext={requestedContext}
      onRequestContext={setRequestedContext}
      onRefresh={(carried) => { setCarriedOutcome(carried ?? null); detail.reload() }}
      carriedOutcome={carriedOutcome}
      onStartChat={(contextLength) =>
        navigate(
          `${paths.chat()}?model=${encodeURIComponent(name)}&numCtx=${contextLength}`,
        )
      }
    />
  )
}

function ModelProfile({
  model,
  health,
  onStartChat,
  onRequestContext,
  onRefresh,
  carriedOutcome,
  requestedContext,
}: {
  model: ModelDetail
  health: Health
  onStartChat: (contextLength: number) => void
  onRequestContext: (contextLength: number) => void
  onRefresh: (carried?: ModelCapabilityOverrideOutcome) => void
  carriedOutcome: ModelCapabilityOverrideOutcome | null
  requestedContext?: number
}) {
  /* Слайдер ходит по тем окнам, для которых сервер прислал вердикт. */
  const contextValues = useMemo(() => {
    const values = model.fitByContext.map((verdict) => verdict.contextLength).sort((a, b) => a - b)
    return values.length > 0 ? values : [model.contextLength]
  }, [model.fitByContext, model.contextLength])

  const defaultContext = useMemo(
    () => nearest(contextValues, requestedContext ?? DEFAULT_CHAT_NUM_CTX),
    [contextValues, requestedContext],
  )

  const [contextLength, setContextLength] = useState(defaultContext)
  const [contextDraft, setContextDraft] = useState(String(defaultContext))
  const [contextError, setContextError] = useState<string | null>(null)
  const [warmed, setWarmed] = useState<{ running: RunningModel; fit: FitVerdict } | null>(null)
  const [warming, setWarming] = useState(false)
  const [warmError, setWarmError] = useState<string | null>(null)

  const sliderFit = useMemo(() => {
    const match = model.fitByContext.find((verdict) => verdict.contextLength === contextLength)
    return match ?? model.fit
  }, [model.fitByContext, model.fit, contextLength])

  // После прогрева показываем факт вместо прогноза — но только для того окна,
  // под которое грели.
  const shownFit =
    warmed && warmed.fit.contextLength === contextLength ? warmed.fit : sliderFit
  const contextBlocked = exceedsDeclaredContextLimit(contextLength, model.contextLimit)

  const applyCustomContext = () => {
    const parsed = parsePositiveSafeInteger(contextDraft)
    if (parsed === null) {
      setContextError(translate('context.validation.positiveSafeInteger'))
      return
    }
    if (exceedsDeclaredContextLimit(parsed, model.contextLimit)) {
      setContextError(translate('context.limit.exceeded'))
      return
    }
    setContextError(null)
    onRequestContext(parsed)
  }

  const warm = async () => {
    setWarming(true)
    setWarmError(null)
    try {
      const result = await api.warmModel(model.name, contextLength)
      setWarmed(result)
    } catch (error) {
      setWarmError(errorMessage(error))
    } finally {
      setWarming(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-5">
      <Link
        to={paths.launcher()}
        className="mb-3 inline-block text-2xs text-secondary hover:text-foreground"
      >
        {translate('model.all')}
      </Link>

      {/* Шапка */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-lg font-semibold tracking-tight">{model.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
            <span>{model.family}</span>
            <span className="text-control">·</span>
            <span>{model.parameterSize}</span>
            <span className="text-control">·</span>
            <span>{model.quantization}</span>
            <span className="text-control">·</span>
            <span title={formatDateTime(model.modifiedAt)}>
              {translate('model.modified', { time: formatRelativeTime(model.modifiedAt) })}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {(model.descriptor.capabilities.state === 'declared' ? model.capabilities : []).map((capability) => (
              <Badge key={capability} tone="accent">
                {capability}
              </Badge>
            ))}
            {model.isCloud && <Badge tone="accent">{translate('model.cloud')}</Badge>}
          </div>
        </div>

        <div className="flex shrink-0 gap-1.5">
          <Button variant="secondary" onClick={warm} loading={warming} disabled={contextBlocked}>
            {warming ? translate('model.warming') : translate('model.warm')}
          </Button>
          <Button variant="primary" onClick={() => onStartChat(contextLength)} disabled={contextBlocked}>
            {translate('model.startChat')}
          </Button>
        </div>
      </header>

      {warming && (
        <Callout tone="info" title={translate('model.loading')}>
          {translate('model.loadingHint', {
            size: formatBytes(model.sizeBytes),
            context: formatContextLength(contextLength),
          })}
        </Callout>
      )}

      {warmError && (
        <Callout tone="danger" title={translate('model.warmError')}>
          {warmError}
        </Callout>
      )}

      <div className={cx('grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]', (warming || warmError) && 'mt-3')}>
        {/* Левая колонка */}
        <div className="min-w-0 space-y-4">
          <Panel title={translate('models.evidence.title')}>
            <InstalledEvidenceDetails descriptor={model.descriptor} />
          </Panel>

          <Panel title={translate('models.probe.title')}>
            <CompletionProbe model={model} contextLength={contextLength} />
          </Panel>

          {/* Deliberately its own region: a user assertion is not provider or runtime evidence. */}
          <Panel title={translate('models.override.title')}>
            <CapabilityOverrides model={model} onRefresh={onRefresh} carriedOutcome={carriedOutcome} />
          </Panel>

          <Panel title={translate('model.architecture')}>
            <ModelInfoTable info={model.modelInfo} />
          </Panel>

          {model.systemPrompt && (
            <Panel title={translate('model.systemPrompt')}>
              <pre className="max-h-64 overflow-auto rounded-md border border-divider bg-inset p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
                {model.systemPrompt}
              </pre>
            </Panel>
          )}

          {model.template && (
            <Panel title={translate('model.promptTemplate')}>
              <Disclosure summary={translate('model.promptTemplate.show')} defaultOpen={false}>
                <pre className="max-h-80 overflow-auto rounded-md border border-divider bg-inset p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
                  {model.template}
                </pre>
              </Disclosure>
            </Panel>
          )}

          {model.license && (
            <Panel title={translate('model.license')}>
              <Disclosure summary={translate('model.license.show')}>
                <pre className="max-h-80 overflow-auto rounded-md border border-divider bg-inset p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
                  {model.license}
                </pre>
              </Disclosure>
            </Panel>
          )}
        </div>

        {/* Правая колонка: влезаемость */}
        <div className="space-y-4">
          <Panel title={translate('model.fit')}>
            <StepSlider
              values={contextValues}
              value={contextLength}
              onChange={(value) => {
                setContextLength(value)
                setContextDraft(String(value))
                setContextError(null)
              }}
              format={formatContextLength}
              label={translate('model.context.size')}
            />

            <div className="mt-2">
              <label htmlFor="model-custom-context" className="text-2xs font-medium">
                {translate('context.custom.label')}
              </label>
              <div className="mt-1 flex min-w-0 gap-1.5">
                <Input
                  id="model-custom-context"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={contextDraft}
                  aria-invalid={contextError !== null}
                  aria-describedby="model-custom-context-hint"
                  onChange={(event) => setContextDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    applyCustomContext()
                  }}
                />
                <Button variant="secondary" size="sm" onClick={applyCustomContext}>
                  {translate('context.custom.apply')}
                </Button>
              </div>
              <p id="model-custom-context-hint" className="mt-1 text-2xs text-muted">
                {translate('context.custom.hint')}
              </p>
              {contextError ? (
                <p className="mt-1 text-2xs text-danger" role="alert">
                  {contextError}
                </p>
              ) : null}
            </div>

            <p className="mt-2 text-2xs text-muted">
              {model.contextLimit.state === 'declared' ? (
                <>
                  {translate('context.limit.declared')}: {formatContextLength(model.contextLimit.value)} ·{' '}
                  {model.contextLimit.source === 'ollama_api_tags'
                    ? translate('context.limit.source.tags')
                    : translate('context.limit.source.show')}{' '}
                  · {translate('context.limit.confidence.declared')} ·{' '}
                  {formatDateTime(model.contextLimit.observedAt)}
                </>
              ) : model.contextLimit.source === 'conflicting_provider_declarations' ? (
                <>
                  {translate('context.limit.conflicting')} ·{' '}
                  {translate('context.limit.confidence.unknown')} ·{' '}
                  {formatDateTime(model.contextLimit.observedAt)}
                </>
              ) : (
                <>
                  {translate('context.limit.unknown')} ·{' '}
                  {translate('context.limit.confidence.unknown')} ·{' '}
                  {formatDateTime(model.contextLimit.observedAt)}
                </>
              )}
            </p>

            <FitIndicator
              fit={shownFit}
              usableBytesOverride={health.hardware.usableMemoryBytes}
              defaultOpen
            />
          </Panel>

          {warmed && (
            <Panel title={translate('model.memory.current')}>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <Stat label={translate('model.memory.used')} value={formatBytes(warmed.running.sizeBytes)} />
                <Stat
                  label={translate('model.memory.accelerator')}
                  value={
                    warmed.running.sizeVramBytes === null
                      ? '—'
                      : formatBytes(warmed.running.sizeVramBytes)
                  }
                />
                <Stat label={translate('model.memory.layout')} value={warmed.running.processorLabel ?? '—'} />
                <Stat
                  label={translate('model.memory.window')}
                  value={
                    warmed.running.contextLength === null
                      ? '—'
                      : formatContextLength(warmed.running.contextLength)
                  }
                />
                {warmed.running.expiresAt && (
                  <div className="col-span-2">
                    <Stat
                      label={translate('model.memory.expires')}
                      value={formatRelativeTime(warmed.running.expiresAt)}
                      hint={formatDateTime(warmed.running.expiresAt)}
                    />
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                onClick={async () => {
                  await api.stopModel(model.name).catch(() => {})
                  setWarmed(null)
                }}
              >
                {translate('model.memory.unload')}
              </Button>
            </Panel>
          )}

          <Panel title={translate('model.hardware')}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <Stat
                label={translate('model.hardware.accelerator')}
                value={health.hardware.acceleratorName ?? health.hardware.accelerator}
              />
              <Stat label={translate('model.hardware.available')} value={formatBytes(health.hardware.usableMemoryBytes)} />
              <Stat label={translate('model.hardware.total')} value={formatBytes(health.hardware.totalMemoryBytes)} />
              <Stat label={translate('model.hardware.cpu')} value={String(health.hardware.cpuCores)} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="surface rounded-xl p-3">
      <h2 className="mb-2.5 text-xs font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function ModelInfoTable({ info }: { info: ModelDetail['modelInfo'] }) {
  const entries = Object.entries(info)
  if (entries.length === 0) {
    return <p className="text-2xs text-muted">{translate('model.parameters.empty')}</p>
  }

  return (
    <div className="max-h-80 overflow-auto rounded-md border border-divider">
      <table className="w-full text-2xs">
        <tbody>
          {entries.map(([key, value], index) => (
            <tr
              key={key}
              className={cx(
                'border-b border-divider last:border-0',
                index % 2 === 1 && 'bg-inset/50',
              )}
            >
              <td className="px-2 py-1 font-mono text-secondary">{key}</td>
              <td className="px-2 py-1 text-right font-mono tabular-nums break-all">
                {value === null ? '—' : String(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ModelSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-5 py-5">
      <Skeleton className="h-7 w-64" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Skeleton className="h-80" />
        <Skeleton className="h-64" />
      </div>
    </div>
  )
}

function nearest(values: number[], target: number): number {
  let best = values[0] ?? target
  for (const value of values) {
    if (Math.abs(value - target) < Math.abs(best - target)) best = value
  }
  return best
}
