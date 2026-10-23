import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'

/** The Settings entry for the voice glossary (T1 "Voice and glossary"); the editor is its own page. */
export function GlossarySettingsLink() {
  return <section aria-labelledby="settings-voice-glossary-title" className="flex min-w-0 flex-col gap-1 rounded-panel border border-divider bg-surface p-3">
    <h2 id="settings-voice-glossary-title" className="text-14 font-heading">{t('voiceGlossary.settings.title')}</h2>
    <p className="text-12 text-secondary">{t('voiceGlossary.settings.description')}</p>
    <Link to={paths.voiceGlossary()} className="inline-flex min-h-6 w-fit items-center text-13 text-accent underline underline-offset-2 focus-visible:outline-focus">
      {t('voiceGlossary.settings.open')}
    </Link>
  </section>
}
