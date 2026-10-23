import type { ReactNode } from 'react'
import { cx } from '../../components/ui.tsx'
import './models.css'

export interface Fact {
  label: string
  value: ReactNode
  /** Identifiers (digests, references) read better in the mono face. */
  mono?: boolean
  tone?: 'muted' | 'warning'
  /** A longer explanation, shown as the value's tooltip. */
  title?: string
}

/**
 * A model's facts as label and value pairs, the value emphasised by weight. It replaces facts
 * joined with punctuation (D-202): each fact keeps its own label, so nothing is read as a list
 * of commas. `false` and `null` entries are skipped, so callers can list optional facts inline.
 */
export function FactList({
  facts,
  label,
  className,
}: {
  facts: ReadonlyArray<Fact | null | false | undefined>
  label?: string
  className?: string
}) {
  const shown = facts.filter((fact): fact is Fact => Boolean(fact))
  if (shown.length === 0) return null
  return (
    <dl className={cx('model-facts', className)} aria-label={label}>
      {shown.map((fact) => (
        <div key={fact.label} className="model-fact">
          <dt>{fact.label}</dt>
          <dd data-mono={fact.mono || undefined} data-tone={fact.tone} title={fact.title}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
