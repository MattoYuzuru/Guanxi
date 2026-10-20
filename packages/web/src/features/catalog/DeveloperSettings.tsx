/** Settings → Developer: the Developer mode switch and the entry to the component catalog. */
import { Toggle } from '../../components/ui.tsx'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, paths } from '../../lib/router.tsx'
import { useDeveloperMode } from './developer-mode.ts'

export function DeveloperSettings() {
  useLocale()
  const [developerMode, setDeveloperMode] = useDeveloperMode()
  return (
    <section className="surface rounded-xl p-3" aria-labelledby="settings-developer-title">
      <h2 id="settings-developer-title" className="mb-1.5 text-xs font-semibold">
        {translate('settings.section.developer')}
      </h2>
      <Toggle
        checked={developerMode}
        onChange={setDeveloperMode}
        label={translate('settings.developer.mode')}
        hint={translate('settings.developer.modeHint')}
      />
      {developerMode ? (
        <Link
          to={paths.developerComponents()}
          className="mt-1 inline-block text-xs text-[var(--accent)] underline underline-offset-2"
        >
          {translate('settings.developer.components')}
        </Link>
      ) : null}
    </section>
  )
}
