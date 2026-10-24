import { describe, expect, it } from 'vitest'
import { localeCatalogs } from '../../src/lib/locale.ts'
import { en as uiEnglish, ru as uiRussian } from '../../../ui/src/i18n/messages.ts'

// D-203, static and bilingual: views stay current by themselves, so no catalogue carries a Retry,
// Refresh or Reload control label, and relative ages ("N s ago") appear only where a live
// connection is known to have stopped. Checked over the merged web catalogues and the design
// system's messages in both languages.
const catalogues = { 'web en': localeCatalogs.en, 'web ru': localeCatalogs.ru, 'ui en': uiEnglish, 'ui ru': uiRussian }

// Crash boundaries: the page itself failed to load, and reloading the page is the remedy.
const PAGE_RELOAD = new Set(['error.reload', 'developer.catalog.reload'])
// Offline states that say when a stopped connection last delivered data.
const STOPPED_AT_AGE = new Set(['notifications.offline.lastKnown', 'inspector.live.offline'])
const LABEL = /^(Retry|Refresh|Reload|Try again|Повторить|Обновить|Перезагрузить|Попробовать снова)(\s[^.;:]{0,40})?$/iu

describe('no retry or refresh controls in copy (D-203)', () => {
  it('no catalogue key names a retry, refresh or reload control', () => {
    const offenders = Object.entries(catalogues).flatMap(([name, catalogue]) => Object.keys(catalogue)
      .filter(key => /\.(retry|refresh|reload)(\.short)?$/iu.test(key) && !PAGE_RELOAD.has(key)).map(key => `${name}: ${key}`))
    expect(offenders).toEqual([])
  })

  it('no message in either language is a bare retry, refresh or reload label', () => {
    const offenders = Object.entries(catalogues).flatMap(([name, catalogue]) => Object.entries(catalogue)
      .filter(([key, text]) => LABEL.test(String(text).trim()) && !PAGE_RELOAD.has(key)).map(([key, text]) => `${name}: ${key} = ${String(text)}`))
    expect(offenders).toEqual([])
  })

  it('relative ages appear only for a stopped connection', () => {
    const offenders = Object.entries(catalogues).flatMap(([name, catalogue]) => Object.entries(catalogue)
      .filter(([key, text]) => /\{age\}/u.test(String(text)) && !STOPPED_AT_AGE.has(key)).map(([key]) => `${name}: ${key}`))
    expect(offenders).toEqual([])
    expect(Object.values(catalogues).every(catalogue => Object.keys(catalogue).length > 50)).toBe(true)
  })
})
