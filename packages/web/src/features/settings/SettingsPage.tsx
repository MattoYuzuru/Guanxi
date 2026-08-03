/**
 * Настройки локального сервера. Секрет провайдера поиска никогда не читается
 * обратно: сервер возвращает только hasApiKey.
 */
import { useEffect, useState, type FormEvent } from 'react'
import type { Settings, WebSearchProvider } from '@alamo/contract'
import { DEFAULT_NUM_CTX } from '@alamo/contract'
import {
  Button,
  Callout,
  Field,
  Input,
  Select,
  Skeleton,
  Toggle,
} from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { translate } from '../../lib/locale.ts'
import { useTheme } from '../../lib/theme.tsx'
import { useAsync } from '../../lib/useAsync.ts'

type Draft = Omit<Settings, 'webSearch'> & {
  webSearch: Settings['webSearch'] & { apiKey: string; clearApiKey: boolean }
}

export function SettingsPage() {
  const loaded = useAsync((signal) => api.getSettings(signal), [])
  const models = useAsync((signal) => api.listModels(undefined, signal), [])
  const { setPreference } = useTheme()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded.data) return
    setDraft({
      ...loaded.data,
      webSearch: {
        ...loaded.data.webSearch,
        apiKey: '',
        clearApiKey: false,
      },
    })
  }, [loaded.data])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return

    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const apiKey =
        draft.webSearch.clearApiKey
          ? ''
          : draft.webSearch.apiKey.trim()
            ? draft.webSearch.apiKey.trim()
            : undefined

      const result = await api.updateSettings({
        ollamaHost: draft.ollamaHost.trim(),
        defaultModel: draft.defaultModel,
        defaultNumCtx: draft.defaultNumCtx,
        autoApproveTools: draft.autoApproveTools,
        enableBash: draft.enableBash,
        prewarmEnabled: draft.prewarmEnabled,
        theme: draft.theme,
        webSearch: {
          provider: draft.webSearch.provider,
          baseUrl: draft.webSearch.baseUrl,
          ...(apiKey !== undefined ? { apiKey } : {}),
        },
      })

      setPreference(result.theme)
      setDraft({
        ...result,
        webSearch: { ...result.webSearch, apiKey: '', clearApiKey: false },
      })
      setSaved(true)
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  if (loaded.loading || !draft) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-5 py-5">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (loaded.error) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-5">
        <Callout
          tone="danger"
          title="Не удалось загрузить настройки"
          action={
            <Button size="sm" onClick={loaded.reload}>
              Повторить
            </Button>
          }
        >
          {errorMessage(loaded.error)}
        </Callout>
      </div>
    )
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous))

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-5">
      <h1 className="text-lg font-semibold tracking-tight">Настройки</h1>
      <p className="mt-0.5 mb-4 text-xs text-[var(--fg-muted)]">
        Хранятся локально в SQLite. API-ключ наружу не возвращается.
      </p>

      {saveError && (
        <div className="mb-3">
          <Callout tone="danger" title="Не удалось сохранить">
            {saveError}
          </Callout>
        </div>
      )}
      {saved && (
        <div className="mb-3">
          <Callout tone="info" title="Настройки сохранены">
            Новый адрес Ollama применяется к следующему запросу.
          </Callout>
        </div>
      )}

      <form onSubmit={save} className="space-y-4">
        <Panel title="Ollama и модели">
          <Field
            label="Адрес Ollama"
            hint="Обычно http://127.0.0.1:11434. Для удалённой Ollama укажите полный URL."
          >
            <Input
              value={draft.ollamaHost}
              onChange={(event) => update('ollamaHost', event.target.value)}
              required
            />
          </Field>

          <Field label="Модель по умолчанию">
            <Select
              value={draft.defaultModel ?? ''}
              onChange={(value) => update('defaultModel', value || null)}
              options={[
                { value: '', label: 'Выбирать при создании' },
                ...(models.data?.models ?? []).map((model) => ({
                  value: model.name,
                  label: model.name,
                  disabled: model.capabilities.includes('embedding'),
                })),
              ]}
            />
          </Field>

          <Field label="Контекст агента по умолчанию" hint="От 512 токенов до лимита модели.">
            <Input
              type="number"
              min={512}
              max={1_048_576}
              step={512}
              value={draft.defaultNumCtx}
              onChange={(event) =>
                update('defaultNumCtx', Number(event.target.value) || DEFAULT_NUM_CTX)
              }
            />
          </Field>
          <Toggle
            checked={draft.prewarmEnabled}
            onChange={(value) => update('prewarmEnabled', value)}
            label={translate('settings.prewarm.label')}
            hint={translate('settings.prewarm.hint')}
          />
        </Panel>

        <Panel title="Инструменты">
          <Toggle
            checked={draft.autoApproveTools}
            onChange={(value) => update('autoApproveTools', value)}
            label="Автоподтверждение по умолчанию"
            hint="Операции записи будут выполняться без модалки. Для незнакомого проекта безопаснее выключить."
          />
          <Toggle
            checked={draft.enableBash}
            onChange={(value) => update('enableBash', value)}
            label="Разрешить bash"
            hint="Команда оболочки не ограничена workspace-jail и всегда считается опасной."
          />
        </Panel>

        <Panel title="Web search">
          <Field label="Провайдер">
            <Select
              value={draft.webSearch.provider}
              onChange={(value) =>
                setDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        webSearch: {
                          ...previous.webSearch,
                          provider: value as WebSearchProvider,
                        },
                      }
                    : previous,
                )
              }
              options={[
                { value: 'none', label: 'Выключен' },
                { value: 'ollama', label: 'Ollama Web Search' },
                { value: 'searxng', label: 'SearXNG' },
                { value: 'brave', label: 'Brave Search' },
                { value: 'tavily', label: 'Tavily' },
              ]}
            />
          </Field>

          <Field label="Base URL" hint="Нужен для собственного SearXNG или совместимого endpoint.">
            <Input
              value={draft.webSearch.baseUrl ?? ''}
              onChange={(event) =>
                setDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        webSearch: {
                          ...previous.webSearch,
                          baseUrl: event.target.value || null,
                        },
                      }
                    : previous,
                )
              }
            />
          </Field>

          <Field
            label="API-ключ"
            hint={
              draft.webSearch.hasApiKey
                ? 'Ключ уже сохранён. Пустое поле оставит его без изменений.'
                : 'После сохранения сервер вернёт только признак наличия ключа.'
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={draft.webSearch.apiKey}
              disabled={draft.webSearch.clearApiKey}
              placeholder={draft.webSearch.hasApiKey ? '••••••••' : ''}
              onChange={(event) =>
                setDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        webSearch: {
                          ...previous.webSearch,
                          apiKey: event.target.value,
                        },
                      }
                    : previous,
                )
              }
            />
          </Field>

          {draft.webSearch.hasApiKey && (
            <Toggle
              checked={draft.webSearch.clearApiKey}
              onChange={(value) =>
                setDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        webSearch: { ...previous.webSearch, clearApiKey: value },
                      }
                    : previous,
                )
              }
              label="Удалить сохранённый ключ"
            />
          )}
        </Panel>

        <Panel title="Интерфейс">
          <Field label="Тема">
            <Select
              value={draft.theme}
              onChange={(value) => update('theme', value as Settings['theme'])}
              options={[
                { value: 'system', label: 'Системная' },
                { value: 'light', label: 'Светлая' },
                { value: 'dark', label: 'Тёмная' },
              ]}
            />
          </Field>
        </Panel>

        <div className="flex justify-end">
          <Button variant="primary" type="submit" loading={saving}>
            Сохранить
          </Button>
        </div>
      </form>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="surface rounded-xl p-3">
      <h2 className="mb-1.5 text-xs font-semibold">{title}</h2>
      {children}
    </section>
  )
}
