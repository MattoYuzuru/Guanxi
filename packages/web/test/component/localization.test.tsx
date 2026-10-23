import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CatalogModel, Settings } from '@guanxi/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsPage } from '../../src/features/settings/SettingsPage.tsx'
import { Glossary } from '../../src/features/settings/Glossary.tsx'
import { Markdown } from '../../src/components/Markdown.tsx'
import { ModelCard } from '../../src/features/models/ModelCard.tsx'
import { ProjectPresentationPicker } from '../../src/features/projects/ProjectPresentationPicker.tsx'
import { QuickRunsPage } from '../../src/features/quick-runs/QuickRunsPage.tsx'
import { RecipesPage } from '../../src/features/recipes/RecipesPage.tsx'
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

const MEMOIZED_CATALOG_MODEL = {
  name: 'cloud-fixture',
  description: 'provider-owned fixture description',
  variants: [],
  contextLength: null,
  capabilities: [],
  vramBytes: null,
  isCloud: true,
  requiredPlan: null,
  installed: false,
  fit: {
    state: 'unknown',
    source: 'catalog_claim',
    contextLength: 8_192,
    verdict: null,
    reason: 'size_unknown',
  },
  installedProjection: 'variant_aggregate_compatibility',
  fitProjection: 'largest_variant_compatibility',
  source: 'bundled',
  freshness: 'fallback',
  sourceObservedAt: '2026-08-14T16:00:00.000Z',
  sourceFetchedAt: null,
} as unknown as CatalogModel

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
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Could not connect to the Guanxi server')
    const shapeError = new ApiShapeError('/api/example', [])
    expect(errorMessage(shapeError))
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
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Не удалось соединиться с сервером Guanxi')
    expect(errorMessage(shapeError))
      .toBe('Ответ /api/example не соответствует контракту приложения')
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
        <ModelCard data={{ kind: 'catalog', model: MEMOIZED_CATALOG_MODEL }} />
      </LocaleProvider>,
    )
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
    expect(screen.getByTitle('Runs in Ollama Cloud and does not consume local memory')).toBeTruthy()

    resolveSettings(SETTINGS)
    expect(await screen.findByRole('button', { name: 'Копировать код' })).toBeTruthy()
    expect(await screen.findByTitle('Считается в облаке Ollama, локальная память не тратится')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull()
    expect(screen.queryByTitle('Runs in Ollama Cloud and does not consume local memory')).toBeNull()
  })

  it('rerenders memoized Quick Run and Recipe scope names after delayed settings bootstrap', async () => {
    let resolveSettings!: (settings: Settings) => void
    vi.spyOn(api, 'getSettings').mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve
    }))
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'listQuickRuns').mockResolvedValue({
      quickRunVersion: 1,
      scope: 'projectless',
      projectId: null,
      quickRuns: [],
    })
    vi.spyOn(api, 'listRecipes').mockResolvedValue({
      recipeVersion: 1,
      scope: 'projectless',
      projectId: null,
      recipes: [],
    })

    setActiveLocale('en')
    render(
      <LocaleProvider>
        <QuickRunsPage />
        <RecipesPage />
      </LocaleProvider>,
    )
    await waitFor(() => expect(
      screen.getAllByRole('heading', { name: 'Without a Project', exact: true }),
    ).toHaveLength(2))

    resolveSettings(SETTINGS)
    await waitFor(() => expect(
      screen.getAllByRole('heading', { name: 'Без проекта', exact: true }),
    ).toHaveLength(2))
    expect(screen.queryByRole('heading', { name: 'Without a Project', exact: true })).toBeNull()
  })

  it('refilters memoized Project icons after delayed settings bootstrap', async () => {
    let resolveSettings!: (settings: Settings) => void
    vi.spyOn(api, 'getSettings').mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve
    }))

    setActiveLocale('en')
    render(
      <LocaleProvider>
        <ProjectPresentationPicker
          projectName="Fixture"
          initialIconKey="folder"
          initialColorToken="slate"
          onClose={() => undefined}
          onSave={async () => undefined}
        />
      </LocaleProvider>,
    )
    const search = screen.getByRole('textbox', { name: 'Search icons' })
    fireEvent.change(search, { target: { value: 'папка' } })
    expect(screen.getByText('No icons match this search and category.')).toBeTruthy()

    resolveSettings(SETTINGS)
    expect(await screen.findByRole('gridcell', { name: 'Папка' })).toBeTruthy()
    expect(screen.queryByText('Для этого поиска и категории иконок не найдено.')).toBeNull()
  })
})

const LEGACY_GLOSSARY_KEYS = [
  'chat',
  'quick-run',
  'project',
  'recipe',
  'agent-run',
  'artifact',
  'job',
  'installed-model',
  'loaded-model',
  'model-weights',
  'context-window',
  'chat-history',
  'kv-cache',
  'reasoning',
  'retention',
  'skill',
  'mcp-connection',
] as const

const TARGET_GLOSSARY_KEYS = [
  'session',
  'run',
  'attempt',
  'node',
  'connection',
  'workspace',
  'block',
  'developer-mode',
  'visual-mode',
  'layout',
  'side-chat',
  'lease',
] as const

describe('Settings language and glossary', () => {
  it('shows an initial Settings load failure and recovers by itself through the authoritative loader', async () => {
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
    expect(screen.queryAllByRole('button', { name: /retry/iu })).toHaveLength(0)
    expect(screen.getByText(/Guanxi tries again by itself/u)).toBeTruthy()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByLabelText('Язык', undefined, { timeout: 5_000 })).toBeTruthy()
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
    const language = await screen.findByLabelText('Language')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Could not connect to the Guanxi server')).toBeTruthy()
    expect(screen.queryByText('Settings saved')).toBeNull()
    fireEvent.change(language, { target: { value: 'ru' } })
    expect(await screen.findByText('Не удалось соединиться с сервером Guanxi')).toBeTruthy()
    expect(screen.queryByText('Could not connect to the Guanxi server')).toBeNull()
    fireEvent.change(language, { target: { value: 'en' } })
    expect(await screen.findByText('Could not connect to the Guanxi server')).toBeTruthy()
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
      expect(screen.getByText(
        locale === 'en'
          ? 'No glossary entries are available.'
          : 'В глоссарии пока нет статей.',
      )).toBeTruthy()
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
    expect(keys.slice(0, LEGACY_GLOSSARY_KEYS.length)).toEqual([...LEGACY_GLOSSARY_KEYS])
    expect(keys.slice(LEGACY_GLOSSARY_KEYS.length)).toEqual([...TARGET_GLOSSARY_KEYS])
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of glossaryEntries) {
      for (const locale of ['en', 'ru'] as const) {
        expect(entry[locale].term.trim(), `${entry.key}:${locale}:term`).not.toBe('')
        expect(entry[locale].definition.trim(), `${entry.key}:${locale}:definition`).not.toBe('')
        expect(entry[locale].example.trim(), `${entry.key}:${locale}:example`).not.toBe('')
      }
    }

    const targetTerms = [
      ['session', 'Session', 'Сессия'],
      ['run', 'Run', 'Запуск'],
      ['attempt', 'Attempt', 'Попытка'],
      ['node', 'Node', 'Узел'],
      ['connection', 'Connection', 'Подключение'],
      ['workspace', 'Workspace', 'Рабочее пространство'],
      ['block', 'Block', 'Блок'],
      ['developer-mode', 'Developer mode', 'Режим разработчика'],
      ['visual-mode', 'Visual mode', 'Визуальный режим'],
      ['layout', 'Layout', 'Раскладка'],
      ['side-chat', 'Side chat', 'Боковой чат'],
      ['lease', 'Lease', 'Lease'],
    ] as const
    for (const [key, english, russian] of targetTerms) {
      const entry = glossaryEntries.find((candidate) => candidate.key === key)
      expect(entry, key).toBeDefined()
      expect(entry?.en.term, key).toBe(english)
      expect(entry?.ru.term, key).toBe(russian)
    }

    expect(searchGlossary(glossaryEntries, 'CHAT', 'en').some((entry) => entry.key === 'chat')).toBe(true)
    expect(searchGlossary(glossaryEntries, 'ускоряет продолжение', 'ru').map((entry) => entry.key))
      .toContain('kv-cache')
    expect(searchGlossary(glossaryEntries, 'Диктовка ПРОМПТА', 'ru').map((entry) => entry.key))
      .toContain('recipe')
    expect(searchGlossary(glossaryEntries, 'folder', 'en').map((entry) => entry.key))
      .toContain('project')
    expect(searchGlossary(glossaryEntries, 'папкой', 'ru').map((entry) => entry.key))
      .toContain('project')

    const keysFor = (query: string, locale: 'en' | 'ru') =>
      searchGlossary(glossaryEntries, query, locale).map((entry) => entry.key)
    expect(keysFor('lossless', 'en')).toContain('session')
    expect(keysFor('durable', 'en')).toContain('run')
    expect(keysFor('fencing token', 'en')).toContain('attempt')
    expect(keysFor('fenced handover', 'en')).toContain('lease')
    expect(keysFor('second holder', 'en')).toContain('lease')
    expect(keysFor('Save to session log', 'en')).toContain('side-chat')
    expect(keysFor('model-autonomy mode', 'en')).toContain('visual-mode')
    expect(keysFor('does not require a filesystem folder', 'en')).toContain('workspace')
    expect(keysFor('только дописываемой', 'ru')).toContain('session')
    expect(keysFor('второго владельца', 'ru')).toContain('lease')
    expect(keysFor('Сохранить в журнал сессии', 'ru')).toContain('side-chat')
    expect(keysFor('автономии модели', 'ru')).toContain('visual-mode')
    expect(keysFor('не требует папки', 'ru')).toContain('workspace')

    expect(searchGlossary(glossaryEntries, 'definitely absent', 'en')).toEqual([])
    expect(searchGlossary(glossaryEntries, '', 'en', 2)).toHaveLength(2)
    expect(searchGlossary([], '', 'en')).toEqual([])
  })

  it('keeps target term boundaries and owner decisions explicit', () => {
    const entryFor = (key: string) => {
      const entry = glossaryEntries.find((candidate) => candidate.key === key)
      expect(entry, key).toBeDefined()
      if (!entry) throw new Error(`missing glossary entry: ${key}`)
      return entry
    }

    const session = entryFor('session')
    expect(session.en.definition).toMatch(/lossless/u)
    expect(session.en.definition).toMatch(/append-only/u)
    expect(session.en.definition).toMatch(/not a Run and not a Chat/u)
    expect(session.en.definition).toMatch(/retention policy/u)
    expect(session.en.example).toMatch(/retention policy/u)
    expect(session.ru.definition).toMatch(/полной/u)
    expect(session.ru.definition).toMatch(/не является ни запуском, ни чатом/u)
    expect(session.ru.definition).toMatch(/политик[аи] хранения/u)
    expect(session.ru.example).toMatch(/политик[аи] хранения/u)

    const run = entryFor('run')
    expect(run.en.definition).toMatch(/durable/u)
    expect(run.en.definition).toMatch(/new Attempts/u)
    expect(run.en.definition).toMatch(/execution slot/u)
    expect(run.en.definition).toMatch(/current fencing grant/u)
    expect(run.ru.definition).toMatch(/слотом исполнения/u)
    expect(run.ru.definition).toMatch(/текущим fencing-грантом/u)
    expect(run.ru.definition).not.toMatch(/одним fencing-токеном/u)
    const attempt = entryFor('attempt')
    expect(attempt.en.definition).toMatch(/execution segment of a Run/u)
    expect(attempt.en.definition).toMatch(/fencing token/u)
    expect(attempt.en.definition)
      .toMatch(/two Attempts of one Run never execute at the same time/u)
    expect(attempt.ru.definition).toMatch(/две попытки одного запуска никогда не выполняются одновременно/u)
    expect(attempt.en.example).toMatch(/granting Node has confirmed/u)
    expect(attempt.en.example)
      .toMatch(/expiry, release, fenced handover or an audited admin break/u)
    expect(attempt.en.example).toMatch(/timeout alone never/u)
    expect(attempt.ru.example).toMatch(/выдавший узел подтвердил/u)
    expect(attempt.ru.example)
      .toMatch(/истечением, освобождением, передачей с fencing или аудируемым административным разрывом/u)
    expect(attempt.ru.example).toMatch(/таймаут никогда не/u)
    expect(run.key).not.toBe(attempt.key)
    expect(run.en.definition).not.toBe(attempt.en.definition)

    const lease = entryFor('lease')
    for (const transition of [
      'transaction on the granting Node',
      'grant',
      'release',
      'expiry',
      'fenced handover',
      'audited admin break',
    ]) {
      expect(lease.en.definition, transition).toContain(transition)
    }
    expect(lease.en.definition).toMatch(/timeout stops renewal.*never creates a second holder/iu)
    expect(lease.ru.definition).toMatch(/транзакцией на выдавшем узле/u)
    expect(lease.ru.definition).toMatch(/Таймаут прекращает продление и никогда не создаёт второго владельца/u)
    expect(lease.en.example).toMatch(/granting Node/u)
    expect(lease.en.example)
      .toMatch(/confirming expiry, release, fenced handover or an audited admin break/u)
    expect(lease.en.example).toMatch(/timeout alone never creates a second holder/u)
    expect(lease.en.example).not.toMatch(/must expire before/u)
    expect(lease.ru.example).toMatch(/выдавший узел/u)
    expect(lease.ru.example)
      .toMatch(/подтвердив истечение, освобождение, передачу с fencing или аудируемый административный разрыв/u)
    expect(lease.ru.example).toMatch(/сам таймаут никогда не создаёт второго владельца/u)
    expect(lease.ru.example).not.toMatch(/должна истечь, прежде чем/u)

    const sideChat = entryFor('side-chat')
    expect(sideChat.en.definition).toMatch(/reads a Session without writing to it/u)
    expect(sideChat.en.definition).toMatch(/ephemeral by default/u)
    expect(sideChat.en.definition).toContain('Save to session log')
    expect(sideChat.en.definition).toContain('Send to main')
    expect(sideChat.ru.definition).toMatch(/По умолчанию боковой чат временный/u)
    expect(sideChat.ru.definition).toContain('Сохранить в журнал сессии')
    expect(sideChat.ru.definition).toContain('Отправить в основной чат')

    const visual = entryFor('visual-mode')
    expect(visual.en.definition).toMatch(/not a model-autonomy mode/u)
    expect(visual.en.definition)
      .toMatch(/does not grant the model extra freedom, permissions or decisions/u)
    expect(visual.ru.definition).toMatch(/не режим автономии модели/u)
    expect(visual.ru.definition).toMatch(/не даёт модели дополнительной свободы, прав или решений/u)

    const workspace = entryFor('workspace')
    expect(workspace.en.definition).toMatch(/not a Project/u)
    expect(workspace.en.definition).toMatch(/does not require a filesystem folder/u)
    const project = entryFor('project')
    expect(project.en.example).toMatch(/without making the Project itself a folder/u)
    expect(project.ru.example).toMatch(/не обязан быть папкой/u)

    for (const key of TARGET_GLOSSARY_KEYS) {
      const copy = entryFor(key)
      expect(copy.en.definition).not.toMatch(/\d|[$€₽]|\b(?:GB|VRAM|GPU|CPU|RAM)\b/u)
      expect(copy.ru.definition).not.toMatch(/\d|[$€₽]|\b(?:GB|VRAM|GPU|CPU|RAM)\b/u)
    }
  })

  it('interpolates the central product name into both Node definitions', async () => {
    const { PRODUCT_NAME } = await import('../../src/lib/brand.ts')
    const node = glossaryEntries.find((entry) => entry.key === 'node')
    expect(node, 'node').toBeDefined()
    expect(node?.en.definition).toContain(PRODUCT_NAME)
    expect(node?.ru.definition).toContain(PRODUCT_NAME)

    vi.resetModules()
    vi.doMock('../../src/lib/brand.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/lib/brand.ts')>()
      return { ...actual, PRODUCT_NAME: 'RenamedProduct' }
    })
    try {
      const { glossaryEntries: renamedEntries } = await import('../../src/lib/glossary.ts')
      const renamedNode = renamedEntries.find((entry) => entry.key === 'node')
      expect(renamedNode?.en.definition).toContain('RenamedProduct')
      expect(renamedNode?.ru.definition).toContain('RenamedProduct')
      expect(renamedNode?.en.definition).not.toContain(PRODUCT_NAME)
      expect(renamedNode?.ru.definition).not.toContain(PRODUCT_NAME)
    } finally {
      vi.doUnmock('../../src/lib/brand.ts')
      vi.resetModules()
    }
  })
})
