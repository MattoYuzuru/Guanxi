/**
 * Settings → Design system: the entry to the live component catalog. One interface (owner
 * feedback 2026-10-23 supersedes D-137's Developer-mode gate): no mode switch hides it.
 */
import { Icon } from '@guanxi/ui'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, paths } from '../../lib/router.tsx'

export function DeveloperSettings() {
  useLocale()
  return (
    <section className="rounded-panel border border-divider bg-surface p-3" aria-labelledby="settings-design-title">
      <h2 id="settings-design-title" className="mb-1.5 font-heading text-12">
        {translate('settings.section.design')}
      </h2>
      <Link
        to={paths.developerComponents()}
        className="inline-flex items-center gap-1.5 text-12 text-accent underline underline-offset-2"
      >
        <Icon name="layers" size={14} />
        {translate('settings.developer.components')}
      </Link>
    </section>
  )
}
