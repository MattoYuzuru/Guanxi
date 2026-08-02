/**
 * Индикатор влезаемости — главная фича карточки модели.
 *
 * Показываем три вещи, и все три важны:
 *  1. цвет + `summary` (готовый русский текст из контракта, его не переписываем);
 *  2. степень доверия к числам — `basis`: прогноз, факт или подсказка вендора;
 *  3. по раскрытию — разбор: из чего сложился requiredBytes и сколько есть.
 */
import type { FitVerdict } from '@alamo/contract'
import { Badge, Disclosure, FIT_COLOR_VAR, FIT_LABEL, Meter, Stat, cx } from '../../components/ui.tsx'
import { formatBytes, formatContextLength, formatUtilization } from '../../lib/format.ts'

/** Степени доверия. Различие принципиальное: прогноз может ошибаться, факт — нет. */
const BASIS_META: Record<
  FitVerdict['basis'],
  { label: string; short: string; hint: string; tone: 'neutral' | 'accent' | 'outline' }
> = {
  estimate: {
    label: 'прогноз',
    short: '≈',
    hint: 'Посчитано по формуле до загрузки модели. Реальность может отличаться на 10-15 %.',
    tone: 'outline',
  },
  measured: {
    label: 'замер',
    short: '=',
    hint: 'Факт после прогрева: столько заняла модель по данным ollama ps.',
    tone: 'accent',
  },
  vendor_hint: {
    label: 'со слов вендора',
    short: '?',
    hint: 'Взято из подсказки каталога, на этом железе не проверялось.',
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
      title={basis.hint}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {FIT_LABEL[fit.level]}
      <span className="opacity-70">· {basis.label}</span>
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
          title={`Заполнение памяти при окне ${formatContextLength(fit.contextLength)}`}
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
        label={`Влезаемость: ${fit.summary}`}
      />

      <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-[var(--fg-subtle)]">
        <span className="truncate">
          {formatBytes(fit.requiredBytes)} из {formatBytes(usable)} ·{' '}
          {formatContextLength(fit.contextLength)} окно
        </span>
        <Badge tone={basis.tone} title={basis.hint} className="shrink-0">
          {basis.label}
        </Badge>
      </div>

      <Disclosure
        className="mt-2"
        defaultOpen={defaultOpen}
        summary="Разбор расчёта"
        tone={undefined}
      >
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-inset)] p-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Stat
              label="Вес модели"
              value={formatBytes(fit.modelBytes)}
              hint="Сами веса в памяти"
            />
            <Stat
              label="KV-кэш"
              value={formatBytes(fit.kvCacheBytes)}
              hint={`Под окно ${formatContextLength(fit.contextLength)} токенов. Растёт линейно с размером окна.`}
            />
            <Stat
              label="Нужно всего"
              value={formatBytes(fit.requiredBytes)}
              tone={color}
              hint="Вес модели + KV-кэш"
            />
            <Stat
              label="Доступно"
              value={formatBytes(usable)}
              hint="Сколько памяти реально может занять ускоритель"
            />
          </div>

          {deficit > 0 && (
            <p className="mt-2 text-2xs" style={{ color: FIT_COLOR_VAR.red }}>
              Не хватает {formatBytes(deficit)}. Часть слоёв уйдёт на CPU — генерация
              замедлится в несколько раз.
            </p>
          )}

          {fit.measured && (
            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="mb-1 text-2xs font-medium text-[var(--fg-muted)]">
                Замер после прогрева
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                <Stat label="Занято по факту" value={formatBytes(fit.measured.sizeBytes)} />
                <Stat label="На ускорителе" value={`${fit.measured.gpuPercent} %`} />
                <div className="col-span-2">
                  <Stat label="Раскладка" value={fit.measured.processorLabel} />
                </div>
              </div>
            </div>
          )}

          <p className="mt-2 text-2xs text-[var(--fg-subtle)]">{basis.hint}</p>
        </div>
      </Disclosure>
    </div>
  )
}
