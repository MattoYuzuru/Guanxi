/**
 * Настройки приложения.
 *
 * Секреты (ключ веб-поиска) хранятся здесь же, но наружу не отдаются никогда —
 * в ответе API есть только признак `hasApiKey`. Единственный способ узнать ключ —
 * прочитать файл базы, что и так требует доступа к машине.
 */
import type { Settings, WebSearchProvider } from '@alamo/contract'
import { DEFAULT_NUM_CTX } from '@alamo/contract'
import type { Db } from './db.ts'

const KEYS = {
  ollamaHost: 'ollama_host',
  defaultModel: 'default_model',
  defaultNumCtx: 'default_num_ctx',
  autoApproveTools: 'auto_approve_tools',
  enableBash: 'enable_bash',
  prewarmEnabled: 'prewarm_enabled',
  webSearchProvider: 'web_search_provider',
  webSearchBaseUrl: 'web_search_base_url',
  webSearchApiKey: 'web_search_api_key',
  theme: 'theme',
} as const

export interface SettingsDefaults {
  ollamaHost: string
}

export class SettingsStore {
  private readonly db: Db
  private readonly defaults: SettingsDefaults

  constructor(db: Db, defaults: SettingsDefaults) {
    this.db = db
    this.defaults = defaults
  }

  private raw(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  private write(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  get(): Settings {
    return {
      ollamaHost: this.raw(KEYS.ollamaHost) ?? this.defaults.ollamaHost,
      defaultModel: this.raw(KEYS.defaultModel),
      defaultNumCtx: Number(this.raw(KEYS.defaultNumCtx) ?? DEFAULT_NUM_CTX),
      autoApproveTools: this.raw(KEYS.autoApproveTools) === 'true',
      enableBash: this.raw(KEYS.enableBash) === 'true',
      prewarmEnabled: this.raw(KEYS.prewarmEnabled) !== 'false',
      webSearch: {
        provider: (this.raw(KEYS.webSearchProvider) ?? 'none') as WebSearchProvider,
        baseUrl: this.raw(KEYS.webSearchBaseUrl),
        hasApiKey: this.raw(KEYS.webSearchApiKey) !== null,
      },
      theme: (this.raw(KEYS.theme) ?? 'system') as Settings['theme'],
    }
  }

  /** Ключ веб-поиска для внутреннего использования. Наружу не уходит. */
  webSearchApiKey(): string | null {
    return this.raw(KEYS.webSearchApiKey) ?? process.env['OLLAMA_API_KEY'] ?? null
  }

  update(patch: {
    ollamaHost?: string
    defaultModel?: string | null
    defaultNumCtx?: number
    autoApproveTools?: boolean
    enableBash?: boolean
    prewarmEnabled?: boolean
    webSearch?: { provider?: WebSearchProvider; baseUrl?: string | null; apiKey?: string | null }
    theme?: Settings['theme']
  }): Settings {
    if (patch.ollamaHost !== undefined) this.write(KEYS.ollamaHost, patch.ollamaHost)
    if (patch.defaultModel !== undefined) this.write(KEYS.defaultModel, patch.defaultModel)
    if (patch.defaultNumCtx !== undefined) this.write(KEYS.defaultNumCtx, String(patch.defaultNumCtx))
    if (patch.autoApproveTools !== undefined)
      this.write(KEYS.autoApproveTools, String(patch.autoApproveTools))
    if (patch.enableBash !== undefined) this.write(KEYS.enableBash, String(patch.enableBash))
    if (patch.prewarmEnabled !== undefined)
      this.write(KEYS.prewarmEnabled, String(patch.prewarmEnabled))
    if (patch.theme !== undefined) this.write(KEYS.theme, patch.theme)

    if (patch.webSearch) {
      if (patch.webSearch.provider !== undefined)
        this.write(KEYS.webSearchProvider, patch.webSearch.provider)
      if (patch.webSearch.baseUrl !== undefined)
        this.write(KEYS.webSearchBaseUrl, patch.webSearch.baseUrl)
      // Пустая строка означает «удалить ключ», а не «сохранить пустой».
      if (patch.webSearch.apiKey !== undefined)
        this.write(KEYS.webSearchApiKey, patch.webSearch.apiKey || null)
    }

    return this.get()
  }
}
