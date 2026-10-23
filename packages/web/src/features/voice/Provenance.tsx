import { formatTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'

/** Source and age of a displayed value (principle 1): the machine name in the mono face, then the absolute time it was observed, never a relative age (D-203). */
export function Provenance({ source, observedAt }: { source: string; observedAt: string }) {
  return <p className="text-12 text-secondary">
    <code className="font-mono">{source}</code> <time dateTime={observedAt}>{t('voiceGlossary.asOf', { time: formatTime(observedAt) })}</time>
  </p>
}
