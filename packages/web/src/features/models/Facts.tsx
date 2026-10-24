import type { ReactNode } from 'react'
import { Icon, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@guanxi/ui'
import { cx } from '../../components/ui.tsx'
import { translate } from '../../lib/locale.ts'
import './models.css'

export interface Fact {
  label: string
  value: ReactNode
  /** Identifiers (digests, references) read better in the mono face. */
  mono?: boolean
  tone?: 'muted' | 'warning'
  /** A longer explanation, behind a named info icon with a popover (keyboard and touch reach it). */
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
          <dd data-mono={fact.mono || undefined} data-tone={fact.tone}>
            {fact.value}
            {/* No native title (review 7): the explanation is a design popover. */}
            {fact.title ? <Popover>
              <PopoverTrigger render={<IconButton size="sm" className="model-fact-about" label={translate('models.facts.about', { fact: fact.label })} icon={<Icon name="info" />} />} />
              <PopoverContent align="start">
                <PopoverTitle>{fact.label}</PopoverTitle>
                <p className="gx-popover-description">{fact.title}</p>
              </PopoverContent>
            </Popover> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
