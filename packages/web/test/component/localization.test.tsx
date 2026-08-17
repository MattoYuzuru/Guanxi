import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '@alamo/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsPage } from '../../src/features/settings/SettingsPage.tsx'
import { Glossary } from '../../src/features/settings/Glossary.tsx'
import { Markdown } from '../../src/components/Markdown.tsx'
import { glossaryEntries, searchGlossary } from '../../src/lib/glossary.ts'
import {
  localeCatalogs,
  setActiveLocale,
  translate,
  type LocaleKey,
} from '../../src/lib/locale.ts'
import { LocaleProvider, useLocale } from '../../src/lib/locale-context.tsx'
import { ApiRequestError, ApiShapeError, api, errorMessage } from '../../src/lib/api.ts'
import {
  formatBytes,
  formatBytesPerSecond,
  formatContextLength,
  formatDuration,
  formatInteger,
  formatRelativeTime,
  formatTokens,
  formatTokensPerSecond,
} from '../../src/lib/format.ts'
import { sseStream } from '../../src/lib/sse.ts'
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

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('does not let an older bootstrap response overwrite a newer locale intent', async () => {
    let resolveSettings!: (settings: Settings) => void
    vi.spyOn(api, 'getSettings').mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve
    }))

    function Probe() {
      const { locale, source, setLocale } = useLocale()
      return (
        <>
          <p>{locale}:{source}:{translate('settings.title')}</p>
          <button onClick={() => setLocale('ru', 'pending')}>Preview Russian</button>
        </>
      )
    }

    setActiveLocale('en')
    render(<LocaleProvider><Probe /></LocaleProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Russian' }))
    expect(screen.getByText('ru:pending:Настройки')).toBeTruthy()
    resolveSettings({ ...SETTINGS, locale: 'en' })

    await waitFor(() => expect(api.getSettings).toHaveBeenCalledTimes(1))
    expect(screen.getByText('ru:pending:Настройки')).toBeTruthy()
    expect(document.documentElement.lang).toBe('ru')
  })

  it('localizes format units and Web-owned transport fallbacks at their source', async () => {
    setActiveLocale('en')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytesPerSecond(1024)).toBe('1 KB/s')
    expect(formatDuration(61_000)).toBe('1 min 1 s')
    expect(formatTokens(12_500)).toBe('12.5k')
    expect(formatContextLength(1_572_864)).toBe('1.5M')
    expect(formatTokensPerSecond(12.25)).toBe('12.3 tok/s')
    expect(formatInteger(32_768)).toBe('32,768')
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Could not connect to the Alamo server')
    expect(errorMessage(new ApiShapeError('/api/example', [])))
      .toBe('The response from /api/example does not match the application contract')
    expect(errorMessage(new ApiRequestError(400, {
      code: 'validation_failed',
      message: 'Некорректное тело',
      details: null,
    }, 'Некорректное тело')))
      .toBe('The request contains an invalid or unsupported value.')

    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null)))
    const stream = sseStream({ url: '/api/example', schema: z.object({ seq: z.number() }), maxRetries: 0 })
    await expect(stream.next()).rejects.toThrow('The response has no body, so streaming cannot continue')

    setActiveLocale('ru')
    expect(formatBytes(0)).toBe('0 Б')
    expect(formatBytesPerSecond(1024)).toBe('1 КБ/с')
    expect(formatDuration(61_000)).toBe('1 мин 1 с')
    expect(formatTokens(12_500)).toBe('12.5k')
    expect(formatContextLength(1_572_864)).toBe('1.5M')
    expect(formatTokensPerSecond(12.25)).toBe('12.3 ток/с')
    expect(formatInteger(32_768)).toMatch(/^32\s768$/u)
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Не удалось соединиться с сервером Alamo')
    expect(errorMessage(new ApiRequestError(400, {
      code: 'validation_failed',
      message: 'Invalid body',
      details: null,
    }, 'Invalid body')))
      .toBe('Запрос содержит недопустимое или неподдерживаемое значение.')

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-14T16:00:00.000Z'))
    expect(formatRelativeTime('2026-08-14T15:59:59.000Z')).toBe('только что')
    setActiveLocale('en')
    expect(formatRelativeTime('2026-08-14T15:59:59.000Z')).toBe('just now')
  })

  it('rerenders memoized locale consumers after delayed settings bootstrap', async () => {
    let resolveSettings!: (settings: Settings) => void
    vi.spyOn(api, 'getSettings').mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve
    }))

    setActiveLocale('en')
    render(
      <LocaleProvider>
        <Markdown source={'```\ncopy me\n```'} />
      </LocaleProvider>,
    )
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()

    resolveSettings(SETTINGS)
    expect(await screen.findByRole('button', { name: 'Копировать код' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull()
  })
})

describe('Settings language and glossary', () => {
  it('shows an initial Settings load failure and retries through the authoritative loader', async () => {
    const getSettings = vi.spyOn(api, 'getSettings')
      .mockRejectedValueOnce(new Error('safe settings load failure'))
      .mockResolvedValueOnce(SETTINGS)
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })

    setActiveLocale('en')
    render(
      <LocaleProvider>
        <ThemeProvider><SettingsPage /></ThemeProvider>
      </LocaleProvider>,
    )

    expect(await screen.findByText('safe settings load failure')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Язык')).toBeTruthy()
    expect(getSettings).toHaveBeenCalledTimes(2)
  })

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
    let langMutations = 0
    const observer = new MutationObserver((records) => {
      langMutations += records.filter((record) => record.attributeName === 'lang').length
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
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
    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(listModels).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(langMutations).toBe(1))
    observer.disconnect()
  })

  it('locks the settings draft while a save response is pending', async () => {
    let resolveUpdate!: (settings: Settings) => void
    vi.spyOn(api, 'getSettings').mockResolvedValue(SETTINGS)
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    vi.spyOn(api, 'updateSettings').mockReturnValue(new Promise((resolve) => {
      resolveUpdate = resolve
    }))

    setActiveLocale('ru')
    render(
      <LocaleProvider>
        <ThemeProvider><SettingsPage /></ThemeProvider>
      </LocaleProvider>,
    )
    const language = await screen.findByLabelText('Язык')
    fireEvent.change(language, { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(language.matches(':disabled')).toBe(true)
    resolveUpdate({ ...SETTINGS, locale: 'en' })
    expect(await screen.findByText('Settings saved')).toBeTruthy()
    expect(document.documentElement.lang).toBe('en')
  })

  it('shows an English save error and retries the same selected locale once', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({ ...SETTINGS, locale: 'en' })
    vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
    const updateSettings = vi.spyOn(api, 'updateSettings')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ...SETTINGS, locale: 'en' })

    setActiveLocale('en')
    render(
      <LocaleProvider>
        <ThemeProvider><SettingsPage /></ThemeProvider>
      </LocaleProvider>,
    )
    await screen.findByLabelText('Language')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Could not connect to the Alamo server')).toBeTruthy()
    expect(screen.queryByText('Settings saved')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Settings saved')).toBeTruthy()
    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings.mock.calls.map(([body]) => body.locale)).toEqual(['en', 'en'])
  })

  it('keeps localized glossary empty and no-result states keyboard reachable', () => {
    for (const locale of ['en', 'ru'] as const) {
      setActiveLocale(locale)
      const { unmount } = render(<Glossary entries={[]} />)
      const search = screen.getByRole('textbox', {
        name: locale === 'en' ? 'Search glossary' : 'Поиск по глоссарию',
      })
      search.focus()
      fireEvent.change(search, { target: { value: 'missing' } })
      expect(document.activeElement).toBe(search)
      expect(screen.getByText(
        locale === 'en'
          ? 'No glossary entries match this search.'
          : 'По этому запросу ничего не найдено.',
      )).toBeTruthy()
      unmount()
    }
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
