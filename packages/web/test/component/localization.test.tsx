import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '@alamo/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../../src/features/settings/SettingsPage.tsx'
import { glossaryEntries, searchGlossary } from '../../src/lib/glossary.ts'
import {
  localeCatalogs,
  setActiveLocale,
  translate,
  type LocaleKey,
} from '../../src/lib/locale.ts'
import { LocaleProvider, useLocale } from '../../src/lib/locale-context.tsx'
import { api } from '../../src/lib/api.ts'
import { ThemeProvider } from '../../src/lib/theme.tsx'

const SETTINGS: Settings = {
  ollamaHost: 'http://127.0.0.1:11434',
  defaultModel: null,
  defaultNumCtx: 32_768,
  autoApproveTools: false,
  enableBash: false,
  prewarmEnabled: true,
  locale: 'ru',
  localeSource: 'user_setting',
  webSearch: { provider: 'none', baseUrl: null, hasApiKey: false },
  theme: 'system',
}

afterEach(() => vi.restoreAllMocks())

describe('locale catalogs', () => {
  it('keeps a non-empty English source, complete curated Russian coverage, and exact variables', () => {
    const englishKeys = Object.keys(localeCatalogs.en).sort()
    expect(Object.keys(localeCatalogs.ru).sort()).toEqual(englishKeys)
    for (const key of englishKeys) {
      expect(localeCatalogs.en[key as LocaleKey].trim(), key).not.toBe('')
      expect(localeCatalogs.ru[key as LocaleKey].trim(), key).not.toBe('')
      const placeholders = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)]
        .map((match) => match[1]).sort()
      expect(placeholders(localeCatalogs.ru[key as LocaleKey]), key)
        .toEqual(placeholders(localeCatalogs.en[key as LocaleKey]))
    }

    setActiveLocale('en')
    expect(translate('settings.glossary.matches', { count: 3 })).toBe('3 matching entries')
    expect(translate('settings.glossary.matches', {}))
      .toBe('[translation variables mismatch: settings.glossary.matches]')
    expect(translate('settings.glossary.matches', { count: 3, extra: 1 }))
      .toBe('[translation variables mismatch: settings.glossary.matches]')
    expect(translate('missing.key' as LocaleKey)).toBe('[missing translation: missing.key]')
  })

  it('uses the provider setting as the only locale source and updates root lang', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({ ...SETTINGS, locale: 'en' })

    function Probe() {
      const { locale, source } = useLocale()
      return <p>{locale}:{source}:{translate('settings.title')}</p>
    }

    setActiveLocale('ru')
    render(<LocaleProvider><Probe /></LocaleProvider>)
    expect(screen.getByText('ru:loading:Настройки')).toBeTruthy()
    expect(await screen.findByText('en:user_setting:Settings')).toBeTruthy()
    expect(document.documentElement.lang).toBe('en')
    expect(api.getSettings).toHaveBeenCalledTimes(1)
  })
})

describe('Settings language and glossary', () => {
  it('previews and persists one locale change without extra model requests or losing focus', async () => {
    const getSettings = vi.spyOn(api, 'getSettings').mockResolvedValue(SETTINGS)
    const listModels = vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const updateSettings = vi.spyOn(api, 'updateSettings').mockImplementation(async (patch) => ({
      ...SETTINGS,
      ...patch,
      locale: patch.locale ?? SETTINGS.locale,
      localeSource: 'user_setting',
    }))

    setActiveLocale('ru')
    render(
      <LocaleProvider>
        <ThemeProvider><SettingsPage /></ThemeProvider>
      </LocaleProvider>,
    )

    const language = await screen.findByLabelText('Язык')
    language.focus()
    fireEvent.change(language, { target: { value: 'en' } })
    expect(document.activeElement).toBe(language)
    expect(document.documentElement.lang).toBe('en')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByText('Language preview is not saved yet.')).toBeTruthy()
    expect(listModels).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
    expect(await screen.findByText('Settings saved')).toBeTruthy()
    expect(getSettings).toHaveBeenCalledTimes(2)
    expect(listModels).toHaveBeenCalledTimes(1)
  })

  it('searches bounded localized term, definition and example copy', () => {
    const keys = glossaryEntries.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of glossaryEntries) {
      for (const locale of ['en', 'ru'] as const) {
        expect(entry[locale].term.trim(), `${entry.key}:${locale}:term`).not.toBe('')
        expect(entry[locale].definition.trim(), `${entry.key}:${locale}:definition`).not.toBe('')
        expect(entry[locale].example.trim(), `${entry.key}:${locale}:example`).not.toBe('')
      }
    }
    expect(searchGlossary(glossaryEntries, 'CHAT', 'en').some((entry) => entry.key === 'chat')).toBe(true)
    expect(searchGlossary(glossaryEntries, 'ускоряет продолжение', 'ru').map((entry) => entry.key))
      .toContain('kv-cache')
    expect(searchGlossary(glossaryEntries, 'Диктовка ПРОМПТА', 'ru').map((entry) => entry.key))
      .toContain('recipe')
    expect(searchGlossary(glossaryEntries, 'definitely absent', 'en')).toEqual([])
    expect(searchGlossary(glossaryEntries, '', 'en', 2)).toHaveLength(2)
    expect(searchGlossary([], '', 'en')).toEqual([])
  })
})
