/**
 * Индикатор влезаемости — главная фича карточки модели.
 *
 * Показываем три вещи, и все три важны:
 *  1. цвет + `summary` (готовый русский текст из контракта, его не переписываем);
 *  2. степень доверия к числам — `basis`: прогноз, факт или подсказка вендора;
 *  3. по раскрытию — разбор: из чего сложился requiredBytes и сколько есть.
 */
import type { FitVerdict } from '@guanxi/contract'
import { Badge, Disclosure, FIT_COLOR_VAR, Meter, Stat, cx, fitLabel } from '../../components/ui.tsx'
import { formatBytes, formatContextLength, formatUtilization } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'

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
      <span className="opacity-70">({translate(basis.label)})</span>
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
}: {
  fit: FitVerdict
  /** Если общий объём железа известен точнее, чем в вердикте. */
  usableBytesOverride?: number
  compact?: boolean
  defaultOpen?: boolean
}) {
  const color = FIT_COLOR_VAR[fit.level]
  const basis = BASIS_META[fit.basis]
  const usable = usableBytesOverride ?? fit.usableBytes

  // utilization может быть больше 1 — шкалу нормируем, но отметку 100 % рисуем.
  const scale = Math.max(1, fit.utilization)
  const marker = scale > 1 ? 1 / scale : undefined
  const deficit = fit.requiredBytes - usable

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <p
          className={cx('min-w-0 font-medium', compact ? 'text-2xs' : 'text-xs')}
          style={{ color }}
        >
          {fit.summary}
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
        label={translate('fit.aria', { summary: fit.summary })}
      />

      <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-muted">
        <span className="truncate">
          {translate('fit.summary', {
            required: formatBytes(fit.requiredBytes),
            available: formatBytes(usable),
            context: formatContextLength(fit.contextLength),
          })}
        </span>
        <Badge tone={basis.tone} title={translate(basis.hint)} className="shrink-0">
          {translate(basis.label)}
        </Badge>
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
    </div>
  )
}
