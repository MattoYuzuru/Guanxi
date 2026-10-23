import { formatRelativeTime, formatTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'

/** Source and age of a displayed value (principle 1): the machine name in the mono face, then when it was observed. */
export function Provenance({ source, observedAt }: { source: string; observedAt: string }) {
  return <p className="text-12 text-secondary">
    <code className="font-mono">{source}</code> <time dateTime={observedAt}>{t('voiceGlossary.asOf', { time: formatTime(observedAt), age: formatRelativeTime(observedAt) })}</time>
  </p>
}
