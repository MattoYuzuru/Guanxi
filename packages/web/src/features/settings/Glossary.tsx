import { useMemo, useState } from 'react'
import { Input } from '../../components/ui.tsx'
import {
  glossaryEntries,
  searchGlossary,
  type GlossaryEntry,
} from '../../lib/glossary.ts'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { PRODUCT_NAME } from '../../lib/brand.ts'

export function Glossary({ entries = glossaryEntries }: { entries?: readonly GlossaryEntry[] }) {
  const { locale } = useLocale()
  const [query, setQuery] = useState('')
  const matches = useMemo(
    () => searchGlossary(entries, query, locale),
    [entries, locale, query],
  )

  return (
    <section aria-labelledby="settings-glossary-title" className="surface rounded-xl p-3">
      <h2 id="settings-glossary-title" className="text-xs font-semibold">
        {translate('settings.glossary.title')}
      </h2>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">
        {translate('settings.glossary.description', { product: PRODUCT_NAME })}
      </p>
      <label className="mt-3 block text-xs font-medium" htmlFor="settings-glossary-search">
        {translate('settings.glossary.search.label')}
      </label>
      <Input
        id="settings-glossary-search"
        className="mt-1"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={translate('settings.glossary.search.placeholder')}
        aria-controls="settings-glossary-results"
      />
      <p className="mt-1 text-2xs text-[var(--fg-muted)]" role="status" aria-live="polite">
        {translate('settings.glossary.matches', { count: matches.length })}
      </p>
      <div id="settings-glossary-results" className="mt-2 space-y-2">
        {matches.length === 0 ? (
          <p className="rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--fg-muted)]">
            {translate(entries.length === 0 && query.trim() === ''
              ? 'settings.glossary.emptyCatalog'
              : 'settings.glossary.empty')}
          </p>
        ) : matches.map((entry) => {
          const copy = entry[locale]
          return (
            <article key={entry.key} className="rounded-lg border border-[var(--border)] p-3">
              <h3 className="text-xs font-semibold">{copy.term}</h3>
              <p className="mt-1 text-xs text-[var(--fg-muted)]">{copy.definition}</p>
              <p className="mt-2 text-xs">
                <span className="font-medium">{translate('settings.glossary.example')}</span>{' '}
                {copy.example}
              </p>
            </article>
          )
        })}
      </div>
    </section>
  )
}
