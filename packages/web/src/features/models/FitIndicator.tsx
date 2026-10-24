/**
 * Индикатор влезаемости — главная фича карточки модели.
 *
 * Показываем три вещи, и все три важны:
 *  1. цвет + причина: код `reason` из контракта, текст локализуем здесь (русский `summary`
 *     узла в интерфейсе не показываем);
 *  2. степень доверия к числам — `basis`: прогноз, факт или подсказка вендора;
 *  3. по раскрытию — разбор: из чего сложился requiredBytes и сколько есть.
 */
import type { FitVerdict } from '@guanxi/contract'
import { Disclosure, FIT_COLOR_VAR, Meter, Stat, cx, fitLabel } from '../../components/ui.tsx'
import { formatBytes, formatContextLength, formatUtilization } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { FactList } from './Facts.tsx'

/**
 * The localised reason for a verdict's level. Older nodes send no `reason`; then the localised
 * level is the honest fallback (the node's Russian `summary` is never shown).
 */
export function fitReasonText(fit: FitVerdict, usableBytes: number = fit.usableBytes): string {
  if (!fit.reason) return fitLabel(fit.level)
  const required = formatBytes(fit.requiredBytes)
  const available = formatBytes(usableBytes)
  const size = formatBytes(fit.measured?.sizeBytes ?? fit.requiredBytes)
  switch (fit.reason) {
    case 'cloud': return translate('fit.reason.cloud')
    case 'insufficient_data': return translate('fit.reason.insufficient_data')
    case 'loaded_partial_gpu': return translate('fit.reason.loaded_partial_gpu', { gpuPercent: String(fit.measured?.gpuPercent ?? 0) })
    case 'loaded_on_accelerator': return translate('fit.reason.loaded_on_accelerator', { size })
    case 'loaded_tight': return translate('fit.reason.loaded_tight', { size, available })
    case 'vendor_requires': return translate('fit.reason.vendor_requires', { required })
    case 'headroom': return translate('fit.reason.headroom', { required, available })
    case 'tight': return translate('fit.reason.tight', { required, available })
    case 'spills_to_cpu': return translate('fit.reason.spills_to_cpu', { required, available })
    case 'vendor_exceeds': return translate('fit.reason.vendor_exceeds', { required, available })
  }
}

/** Степени доверия. Различие принципиальное: прогноз может ошибаться, факт — нет. */
const BASIS_META: Record<
  FitVerdict['basis'],
  { label: LocaleKey; short: string; hint: LocaleKey; tone: 'neutral' | 'accent' | 'outline' }
> = {
  estimate: {
    label: 'fit.basis.estimate',
    short: '≈',
    hint: 'fit.basis.estimateHint',
    tone: 'outline',
  },
  measured: {
    label: 'fit.basis.measured',
    short: '=',
    hint: 'fit.basis.measuredHint',
    tone: 'accent',
  },
  vendor_hint: {
    label: 'fit.basis.vendor',
    short: '?',
    hint: 'fit.basis.vendorHint',
    tone: 'neutral',
  },
}

export function FitBadge({ fit }: { fit: FitVerdict }) {
  const basis = BASIS_META[fit.basis]
  const color = FIT_COLOR_VAR[fit.level]

  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs leading-4 font-medium"
      style={{ color, borderColor: `${color}55`, background: `${color}1f` }}
      title={translate(basis.hint)}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {fitLabel(fit.level)}
      <span className="opacity-70">{translate(basis.label)}</span>
    </span>
  )
}

/**
 * Полный индикатор. `compact` — вариант для карточки в карусели, где места мало.
 */
export function FitIndicator({
  fit,
  usableBytesOverride,
  compact = false,
  defaultOpen = false,
  summary = false,
}: {
  fit: FitVerdict
  /** Если общий объём железа известен точнее, чем в вердикте. */
  usableBytesOverride?: number
  compact?: boolean
  defaultOpen?: boolean
  /** The verdict and its meter only; the facts and the breakdown live elsewhere (a card's details). */
  summary?: boolean
}) {
  const color = FIT_COLOR_VAR[fit.level]
  const basis = BASIS_META[fit.basis]
  const usable = usableBytesOverride ?? fit.usableBytes

  // utilization может быть больше 1 — шкалу нормируем, но отметку 100 % рисуем.
  const scale = Math.max(1, fit.utilization)
  const marker = scale > 1 ? 1 / scale : undefined
  const deficit = fit.requiredBytes - usable
  const reason = fitReasonText(fit, usable)

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <p
          className={cx('min-w-0 font-medium', compact ? 'text-2xs' : 'text-xs')}
          style={{ color }}
        >
          {reason}
        </p>
        <span
          className="shrink-0 font-mono text-2xs tabular-nums"
          style={{ color }}
          title={translate('fit.memoryUsage', { context: formatContextLength(fit.contextLength) })}
        >
          {formatUtilization(fit.utilization)}
        </span>
      </div>

      <Meter
        value={fit.utilization / scale}
        tone={color}
        marker={marker}
        height={compact ? 4 : 5}
        className="mt-1.5"
        label={translate('fit.aria', { summary: reason })}
      />
      {summary ? null : <>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-muted">
        <FactList
          facts={[
            { label: translate('models.facts.memory'), value: `${formatBytes(fit.requiredBytes)} / ${formatBytes(usable)}` },
            { label: translate('models.facts.context'), value: formatContextLength(fit.contextLength) },
            { label: translate('models.facts.basis'), value: translate(basis.label), title: translate(basis.hint) },
          ]}
        />
      </div>

      <Disclosure
        className="mt-2"
        defaultOpen={defaultOpen}
        summary={translate('fit.breakdown')}
        tone={undefined}
      >
        <div className="rounded-md border border-divider bg-inset p-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Stat
              label={translate('fit.weight')}
              value={formatBytes(fit.modelBytes)}
              hint={translate('fit.weightHint')}
            />
            <Stat
              label={translate('fit.cache')}
              value={formatBytes(fit.kvCacheBytes)}
              hint={translate('fit.cacheHint', { context: formatContextLength(fit.contextLength) })}
            />
            <Stat
              label={translate('fit.required')}
              value={formatBytes(fit.requiredBytes)}
              tone={color}
              hint={translate('fit.requiredHint')}
            />
            <Stat
              label={translate('fit.available')}
              value={formatBytes(usable)}
              hint={translate('fit.availableHint')}
            />
          </div>

          {deficit > 0 && (
            <p className="mt-2 text-2xs" style={{ color: FIT_COLOR_VAR.red }}>
              {translate('fit.deficit', { bytes: formatBytes(deficit) })}
            </p>
          )}

          {fit.measured && (
            <div className="mt-2 border-t border-divider pt-2">
              <div className="mb-1 text-2xs font-medium text-secondary">
                {translate('fit.measurement.title')}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                <Stat label={translate('fit.measured')} value={formatBytes(fit.measured.sizeBytes)} />
                <Stat label={translate('fit.accelerator')} value={`${fit.measured.gpuPercent} %`} />
                <div className="col-span-2">
                  <Stat label={translate('fit.layout')} value={fit.measured.processorLabel} />
                </div>
              </div>
            </div>
          )}

          <p className="mt-2 text-2xs text-secondary">{translate(basis.hint)}</p>
        </div>
      </Disclosure>
      </>}
    </div>
  )
}
