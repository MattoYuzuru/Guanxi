/*
 * Guanxi pattern. Source and observation time for every number (principle 1, Truth over confidence),
 * as an absolute time: views stay current by themselves, so no "N s ago" caption (D-203);
 * unknown renders as Unknown plus the source that would answer it, never as 0 or a blank.
 */
import type { ComponentProps } from 'react'
import type { UiMessageKey } from '../../i18n/messages.ts'
import { intlLocale, useUiLocale, useUiText } from '../../i18n/context.tsx'
import { cx } from '../../lib/cx.ts'
import { Badge } from '../badge/badge.tsx'
import './provenance-label.css'

export type Confidence = 'high' | 'medium' | 'low'

export interface ProvenanceLabelProps extends Omit<ComponentProps<'span'>, 'className' | 'children'> {
  /** Machine name of the source, shown in the mono face (for example `ollama /api/ps`). */
  source: string
  /** ISO time of the observation; `null` means the value is unknown. */
  observedAt: string | null
  /** Reference time for the age; defaults to now. Stories pass a fixed time. */
  now?: string
  /** After this many seconds the label switches to the aged "as of HH:MM" warning. */
  staleAfterSeconds?: number
  /** Guanxi metered or inferred the value. */
  estimated?: boolean
  confidence?: Confidence
  className?: string
}

const CONFIDENCE: Record<Confidence, UiMessageKey> = {
  high: 'ui.provenance.confidence.high',
  medium: 'ui.provenance.confidence.medium',
  low: 'ui.provenance.confidence.low',
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
]

export function formatAge(seconds: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return format.format(-Math.round(seconds / size), unit)
    }
  }
  return format.format(0, 'second')
}

export function ProvenanceLabel({
  source,
  observedAt,
  now,
  staleAfterSeconds = 300,
  estimated = false,
  confidence,
  className,
  ...props
}: ProvenanceLabelProps) {
  const t = useUiText()
  const locale = intlLocale(useUiLocale())
  const observed = observedAt === null ? null : new Date(observedAt)
  const sourceNode = <span className="gx-provenance-source">{source}</span>

  let body
  let state: 'unknown' | 'fresh' | 'aged'
  if (observed === null || Number.isNaN(observed.getTime())) {
    state = 'unknown'
    const [before, after] = t('ui.provenance.unknownSource', { source: '\u0000' }).split('\u0000')
    body = (
      <>
        {before}
        {sourceNode}
        {after}
      </>
    )
  } else {
    const reference = now ? new Date(now) : new Date()
    const seconds = Math.max(0, (reference.getTime() - observed.getTime()) / 1000)
    state = seconds > staleAfterSeconds ? 'aged' : 'fresh'
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(observed)
    const ageText = state === 'aged' ? t('ui.provenance.asOf', { time }) : time
    body = (
      <>
        {sourceNode}{' '}
        <time dateTime={observed.toISOString()} title={observed.toISOString()}>
          {ageText}
        </time>
      </>
    )
  }

  return (
    <span
      data-slot="provenance-label"
      data-state={state}
      className={cx('gx-provenance', className)}
      {...props}
    >
      {body}
      {estimated ? <Badge tone="warning">{t('ui.provenance.estimated')}</Badge> : null}
      {confidence ? (
        <span className="gx-provenance-confidence">{t(CONFIDENCE[confidence])}</span>
      ) : null}
    </span>
  )
}
