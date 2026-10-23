import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'

/** The Settings entry for the voice glossary (T1 "Voice and glossary"); the editor is its own page. */
export function GlossarySettingsLink() {
  return <section aria-labelledby="settings-voice-glossary-title" className="surface rounded-xl p-3">
    <h2 id="settings-voice-glossary-title" className="text-xs font-semibold">{t('voiceGlossary.settings.title')}</h2>
    <p className="mt-1 text-xs text-secondary">{t('voiceGlossary.settings.description')}</p>
    <Link to={paths.voiceGlossary()} className="mt-2 inline-flex min-h-6 items-center text-xs text-accent underline underline-offset-2 focus-visible:outline-focus">
      {t('voiceGlossary.settings.open')}
    </Link>
  </section>
}
