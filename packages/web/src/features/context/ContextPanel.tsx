/**
 * Панель контекста.
 *
 * Здесь два сюжета, и оба про ожидание:
 *
 * 1. KV-кэш. Попадание — ответ начинается мгновенно, промах — десятки секунд
 *    тишины. На целевом железе замерено: 41.8 с против 0.3 с на тех же 7.8k
 *    токенов. Это надо показывать не сноской, а крупно.
 *
 * 2. Компакция. Она не бесплатная оптимизация, а размен: место в окне сейчас
 *    в обмен на длинный prefill следующего хода. Цену (`estimatedRepefillMs`)
 *    показываем ДО нажатия, а не после.
 */
import { useEffect, useRef, useState } from 'react'
import type { ContextState, Usage } from '@guanxi/contract'
import { Badge, Button, Meter, Stat, cx } from '../../components/ui.tsx'
import { errorMessage } from '../../lib/api.ts'
import { formatDuration, formatPercent, formatTokens, formatTokensPerSecond } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

/** Замер с целевого железа — им объясняем, почему кэш важен. */
const CACHE_MISS_REFERENCE_MS = 41_800
const CACHE_HIT_REFERENCE_MS = 300

export function ContextPanel({
  context,
  usage,
  compacting,
  onCompact,
  disabled,
}: {
  context: ContextState | null
  usage: Usage | null
  compacting: boolean
  onCompact: () => Promise<unknown>
  disabled?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [compactError, setCompactError] = useState<string | null>(null)
  const compactErrorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (compactError) compactErrorRef.current?.focus()
  }, [compactError])

  if (!context) {
    return (
      <div className="p-3 text-2xs text-[var(--fg-subtle)]">
        {translate('context.unavailable')}
      </div>
    )
  }

  const fraction = context.allocatedTokens > 0 ? context.usedTokens / context.allocatedTokens : 0
  const tone =
    context.percent >= 90
      ? 'var(--color-fit-red)'
      : context.percent >= 70
        ? 'var(--color-fit-yellow)'
        : 'var(--accent)'

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/* Окно */}
      <section>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold">{translate('context.panel.title')}</h3>
          <span className="font-mono text-xs tabular-nums" style={{ color: tone }}>
            {formatPercent(context.percent, context.percent < 10 ? 1 : 0)}
          </span>
        </div>

        <Meter value={fraction} tone={tone} height={7} label={translate('context.panel.fill')} />

        <div className="mt-1.5 flex items-center justify-between font-mono text-2xs text-[var(--fg-subtle)] tabular-nums">
          <span>{translate('context.used', { tokens: formatTokens(context.usedTokens) })}</span>
          <span>{translate('context.of', { tokens: formatTokens(context.allocatedTokens) })}</span>
        </div>

        {context.percent >= 90 && (
          <p className="mt-1.5 text-2xs text-[var(--color-fit-red)]">
            {translate('context.almostFull')}
          </p>
        )}
      </section>

      {/* KV-кэш */}
      <CacheIndicator context={context} usage={usage} />

      {/* Скорость */}
      {usage && <SpeedSection usage={usage} />}

      {/* Компакция */}
      <section className="mt-auto border-t border-[var(--border)] pt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">{translate('context.compact.title')}</h3>
          {!context.compactable && <Badge tone="neutral">{translate('context.compact.empty')}</Badge>}
        </div>

        {/* Цена — до нажатия, а не после */}
        <div className="mb-2 rounded-md border border-[var(--color-fit-yellow)]/35 bg-[var(--color-fit-yellow)]/8 px-2 py-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xs text-[var(--fg-muted)]">{translate('context.compact.nextCost')}</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-[var(--color-fit-yellow)]">
              +{formatDuration(context.estimatedRepefillMs)}
            </span>
          </div>
          <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
            {translate('chat.checkpoint.cacheCost')}
          </p>
        </div>

        {confirming ? (
          <div className="space-y-1.5">
            <p className="text-2xs text-[var(--fg-muted)]">
              {translate('chat.checkpoint.confirm').replace(
                '{duration}',
                formatDuration(context.estimatedRepefillMs),
              )}
            </p>
            {compactError && (
              <div
                ref={compactErrorRef}
                role="alert"
                tabIndex={-1}
                className="rounded-md border border-[var(--color-fit-red)]/50 bg-[var(--color-fit-red)]/8 px-2 py-1.5 text-2xs text-[var(--color-fit-red)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              >
                <div className="font-semibold">{translate('chat.checkpoint.error')}</div>
                <div className="mt-0.5 break-words">{compactError}</div>
              </div>
            )}
            <div className="flex gap-1.5">
              <Button
                variant="primary"
                size="sm"
                className="flex-1"
                loading={compacting}
                onClick={async () => {
                  setCompactError(null)
                  try {
                    await onCompact()
                    setConfirming(false)
                  } catch (error) {
                    setCompactError(errorMessage(error))
                  }
                }}
              >
                {compactError
                  ? translate('chat.checkpoint.retry')
                  : translate('chat.checkpoint.confirmAction')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={compacting}
                onClick={() => {
                  setCompactError(null)
                  setConfirming(false)
                }}
              >
                {translate('context.compact.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="md"
            className="w-full"
            disabled={!context.compactable || disabled || compacting}
            loading={compacting}
            onClick={() => {
              setCompactError(null)
              setConfirming(true)
            }}
          >
            {translate('context.compact.title')}
          </Button>
        )}
      </section>
    </div>
  )
}

/* ────────────────────────────── KV-кэш ─────────────────────────────────── */

function CacheIndicator({ context, usage }: { context: ContextState; usage: Usage | null }) {
  const hit = context.cacheHit
  const color = hit ? 'var(--color-fit-green)' : 'var(--color-fit-yellow)'

  // Доля префикса, которую не пришлось считать заново.
  const cachedFraction =
    context.usedTokens > 0 ? Math.min(1, context.cachedTokens / context.usedTokens) : 0

  const actualPrefill = usage?.promptEvalDurationMs ?? null

  return (
    <section
      className="rounded-lg border px-2.5 py-2"
      style={{ borderColor: `${color}55`, background: `${color}12` }}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold" style={{ color }}>
          {hit ? translate('context.cache.hitTitle') : translate('context.cache.missTitle')}
        </h3>
        <span className="font-mono text-2xs tabular-nums" style={{ color }}>
          {translate('context.cache.cached', { tokens: formatTokens(context.cachedTokens) })}
        </span>
      </div>

      <Meter
        value={cachedFraction}
        tone={color}
        height={4}
        label={translate('context.cache.share', { percent: formatPercent(cachedFraction * 100) })}
      />

      <p className="mt-1.5 text-2xs text-[var(--fg-muted)]">
        {hit
          ? translate('context.cache.hitDescription')
          : translate('context.cache.missDescription')}
      </p>

      {/* Наглядное сравнение: цифры с реального железа */}
      <div className="mt-2 space-y-1">
        <CacheBar
          label={translate('context.cache.hit')}
          ms={CACHE_HIT_REFERENCE_MS}
          maxMs={CACHE_MISS_REFERENCE_MS}
          color="var(--color-fit-green)"
          active={hit}
        />
        <CacheBar
          label={translate('context.cache.miss')}
          ms={CACHE_MISS_REFERENCE_MS}
          maxMs={CACHE_MISS_REFERENCE_MS}
          color="var(--color-fit-yellow)"
          active={!hit}
        />
      </div>

      <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
        {translate('context.cache.reference')}
        {actualPrefill !== null && (
          <>
            {' '}
            <span className="font-mono">
              {translate('context.cache.currentTurn', { duration: formatDuration(actualPrefill) })}
            </span>
          </>
        )}
      </p>
    </section>
  )
}

function CacheBar({
  label,
  ms,
  maxMs,
  color,
  active,
}: {
  label: string
  ms: number
  maxMs: number
  color: string
  active: boolean
}) {
  return (
    <div className={cx('flex items-center gap-2', !active && 'opacity-45')}>
      <span className="w-16 shrink-0 text-2xs">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, (ms / maxMs) * 100)}%`, background: color }}
        />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-2xs tabular-nums">
        {formatDuration(ms)}
      </span>
      {active && (
        <span className="shrink-0 text-2xs font-semibold" style={{ color }}>
          ←
        </span>
      )}
    </div>
  )
}

/* ────────────────────────────── Скорость ───────────────────────────────── */

function SpeedSection({ usage }: { usage: Usage }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold">{translate('context.lastTurn.title')}</h3>

      {/* Prefill и генерация — разные вещи, и ждать приходится по-разному */}
      <div className="mb-2 flex h-5 overflow-hidden rounded border border-[var(--border)]">
        <PhaseSegment
          label={translate('context.lastTurn.prefill')}
          ms={usage.promptEvalDurationMs}
          total={usage.totalDurationMs}
          color="var(--color-fit-yellow)"
        />
        <PhaseSegment
          label={translate('context.lastTurn.generation')}
          ms={usage.evalDurationMs}
          total={usage.totalDurationMs}
          color="var(--accent)"
        />
        <PhaseSegment
          label={translate('context.lastTurn.loading')}
          ms={usage.loadDurationMs}
          total={usage.totalDurationMs}
          color="var(--fg-subtle)"
        />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Stat
          label={translate('context.lastTurn.prompt')}
          value={formatDuration(usage.promptEvalDurationMs)}
          hint={translate('context.lastTurn.inputTokens', { tokens: formatTokens(usage.promptTokens) })}
        />
        <Stat
          label={translate('context.lastTurn.generation')}
          value={formatDuration(usage.evalDurationMs)}
          hint={translate('context.lastTurn.outputTokens', { tokens: formatTokens(usage.evalTokens) })}
        />
        <Stat label={translate('context.lastTurn.speed')} value={formatTokensPerSecond(usage.tokensPerSecond)} />
        <Stat label={translate('context.lastTurn.total')} value={formatDuration(usage.totalDurationMs)} />
      </div>
    </section>
  )
}

function PhaseSegment({
  label,
  ms,
  total,
  color,
}: {
  label: string
  ms: number
  total: number
  color: string
}) {
  if (ms <= 0 || total <= 0) return null
  const percent = (ms / total) * 100
  if (percent < 0.5) return null

  return (
    <div
      className="flex items-center justify-center overflow-hidden text-2xs whitespace-nowrap"
      style={{ width: `${percent}%`, background: `${color}33`, color }}
      title={`${label}: ${formatDuration(ms)} (${formatPercent(percent)})`}
    >
      {percent > 18 && <span className="px-1">{label}</span>}
    </div>
  )
}

/** Компактная строка контекста для узких мест (шапка треда). */
export function ContextChip({ context }: { context: ContextState | null }) {
  if (!context) return null

  const tone =
    context.percent >= 90
      ? 'var(--color-fit-red)'
      : context.percent >= 70
        ? 'var(--color-fit-yellow)'
        : 'var(--fg-muted)'

  return (
    <span
      className="flex items-center gap-1.5 font-mono text-2xs tabular-nums"
      style={{ color: tone }}
      title={translate('context.chip.title', {
        used: formatTokens(context.usedTokens),
        allocated: formatTokens(context.allocatedTokens),
      })}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: context.cacheHit ? 'var(--color-fit-green)' : 'var(--color-fit-yellow)' }}
        title={context.cacheHit ? translate('context.cache.hitTitle') : translate('context.cache.missTitle')}
      />
      {formatPercent(context.percent)}
    </span>
  )
}
