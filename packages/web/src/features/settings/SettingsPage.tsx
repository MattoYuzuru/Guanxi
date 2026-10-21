/**
 * Настройки локального сервера. Секрет провайдера поиска никогда не читается
 * обратно: сервер возвращает только hasApiKey.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Settings, UiLocale, WebSearchProvider } from '@guanxi/contract'
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
import { useLocale } from '../../lib/locale-context.tsx'
import { parsePositiveSafeInteger } from '../../lib/contextLength.ts'
import { useTheme } from '../../lib/theme.tsx'
import { useAsync } from '../../lib/useAsync.ts'
import { Glossary } from './Glossary.tsx'
import { DeveloperSettings } from '../catalog/DeveloperSettings.tsx'
import { ConnectionsSettings } from '../connections/ConnectionsPage.tsx'

type Draft = Omit<Settings, 'webSearch'> & {
  webSearch: Settings['webSearch'] & { apiKey: string; clearApiKey: boolean }
}

type SaveFailure =
  | { kind: 'invalid_context' }
  | { kind: 'request'; error: unknown }

export function SettingsPage() {
  const models = useAsync((signal) => api.listModels(undefined, signal), [])
  const { setPreference } = useTheme()
  const {
    source: localeSource,
    settings,
    settingsLoading,
    settingsError,
    setLocale,
    acceptSettings,
    reloadSettings,
  } = useLocale()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<SaveFailure | null>(null)
  const saveErrorRef = useRef<HTMLDivElement>(null)
  const savingRef = useRef(false)
  const [defaultNumCtxText, setDefaultNumCtxText] = useState('')

  useEffect(() => {
    if (!settings) return
    setDraft({
      ...settings,
      webSearch: {
        ...settings.webSearch,
        apiKey: '',
        clearApiKey: false,
      },
    })
    setDefaultNumCtxText(String(settings.defaultNumCtx))
  }, [settings])

  useEffect(() => {
    if (saveError) saveErrorRef.current?.focus()
  }, [saveError])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || savingRef.current) return
    const defaultNumCtx = parsePositiveSafeInteger(defaultNumCtxText)
    if (defaultNumCtx === null) {
      setSaveError({ kind: 'invalid_context' })
      return
    }

    savingRef.current = true
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
        defaultNumCtx,
        autoApproveTools: draft.autoApproveTools,
        enableBash: draft.enableBash,
        prewarmEnabled: draft.prewarmEnabled,
        locale: draft.locale,
        theme: draft.theme,
        webSearch: {
          provider: draft.webSearch.provider,
          baseUrl: draft.webSearch.baseUrl,
          ...(apiKey !== undefined ? { apiKey } : {}),
        },
      })

      setPreference(result.theme)
      acceptSettings(result)
      setDraft({
        ...result,
        webSearch: { ...result.webSearch, apiKey: '', clearApiKey: false },
      })
      setDefaultNumCtxText(String(result.defaultNumCtx))
      setSaved(true)
    } catch (error) {
      setSaveError({ kind: 'request', error })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (settingsLoading || (!draft && settingsError === null)) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-5 py-5">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (settingsError || !draft) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-5">
        <Callout
          tone="danger"
          title={translate('settings.load.error')}
          action={
            <Button size="sm" onClick={reloadSettings}>
              {translate('settings.retry')}
            </Button>
          }
        >
          {settingsError ? errorMessage(settingsError) : translate('settings.load.error')}
        </Callout>
      </div>
    )
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous))
  const updateLocale = (locale: UiLocale) => {
    update('locale', locale)
    setSaved(false)
    setLocale(locale, 'pending')
  }
  const defaultNumCtxInvalid = parsePositiveSafeInteger(defaultNumCtxText) === null

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-5">
      <h1 className="text-lg font-semibold tracking-tight">{translate('settings.title')}</h1>
      <p className="mt-0.5 mb-4 text-xs text-[var(--fg-muted)]">
        {translate('settings.description')}
      </p>

      {saveError && (
        <div ref={saveErrorRef} className="mb-3" role="alert" tabIndex={-1}>
          <Callout tone="danger" title={translate('settings.save.error')}>
            {saveError.kind === 'invalid_context'
              ? translate('context.validation.positiveSafeInteger')
              : errorMessage(saveError.error)}
          </Callout>
        </div>
      )}
      {saved && (
        <div className="mb-3">
          <Callout tone="info" title={translate('settings.save.success')}>
            {translate('settings.save.successHint')}
          </Callout>
        </div>
      )}

      {localeSource === 'stored_invalid' && (
        <div className="mb-3">
          <Callout tone="warning" title={translate('settings.interface.language')}>
            {translate('settings.locale.invalidStored')}
          </Callout>
        </div>
      )}
      {localeSource === 'unavailable' && (
        <div className="mb-3">
          <Callout tone="warning" title={translate('settings.interface.language')}>
            {translate('settings.locale.unavailable')}
          </Callout>
        </div>
      )}
      {localeSource === 'pending' && (
        <p className="mb-3 text-xs text-[var(--fg-muted)]" role="status">
          {translate('settings.locale.pending')}
        </p>
      )}

      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={saving} className="space-y-4 border-0 p-0">
        <Panel title={translate('settings.section.ollama')}>
          <Field
            label={translate('settings.ollama.address')}
            hint={translate('settings.ollama.addressHint')}
            htmlFor="settings-ollama-address"
          >
            <Input
              id="settings-ollama-address"
              value={draft.ollamaHost}
              onChange={(event) => update('ollamaHost', event.target.value)}
              required
            />
          </Field>

          <Field label={translate('settings.ollama.defaultModel')} htmlFor="settings-default-model">
            <Select
              id="settings-default-model"
              value={draft.defaultModel ?? ''}
              onChange={(value) => update('defaultModel', value || null)}
              options={[
                { value: '', label: translate('settings.ollama.chooseOnCreate') },
                ...(models.data?.models ?? []).map((model) => ({
                  value: model.name,
                  label: model.name,
                  disabled: model.capabilities.includes('embedding'),
                })),
              ]}
            />
          </Field>

          <Field
            label={translate('settings.context.label')}
            hint={translate('settings.context.hint')}
            htmlFor="settings-default-context"
          >
            <Input
              id="settings-default-context"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={defaultNumCtxText}
              onChange={(event) => setDefaultNumCtxText(event.target.value)}
              aria-invalid={defaultNumCtxInvalid}
              aria-describedby={defaultNumCtxInvalid ? 'settings-default-context-error' : undefined}
            />
            {defaultNumCtxInvalid ? (
              <p id="settings-default-context-error" className="mt-1 text-2xs text-[var(--danger)]" role="alert">
                {translate('context.validation.positiveSafeInteger')}
              </p>
            ) : null}
          </Field>
          <Toggle
            checked={draft.prewarmEnabled}
            onChange={(value) => update('prewarmEnabled', value)}
            label={translate('settings.prewarm.label')}
            hint={translate('settings.prewarm.hint')}
          />
        </Panel>

        <Panel title={translate('settings.section.tools')}>
          <Toggle
            checked={draft.autoApproveTools}
            onChange={(value) => update('autoApproveTools', value)}
            label={translate('settings.tools.autoApprove')}
            hint={translate('settings.tools.autoApproveHint')}
          />
          <Toggle
            checked={draft.enableBash}
            onChange={(value) => update('enableBash', value)}
            label={translate('settings.tools.bash')}
            hint={translate('settings.tools.bashHint')}
          />
        </Panel>

        <Panel title={translate('settings.section.webSearch')}>
          <Field label={translate('settings.webSearch.provider')} htmlFor="settings-web-provider">
            <Select
              id="settings-web-provider"
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
                { value: 'none', label: translate('settings.webSearch.disabled') },
                { value: 'ollama', label: 'Ollama Web Search' },
                { value: 'searxng', label: 'SearXNG' },
                { value: 'brave', label: 'Brave Search' },
                { value: 'tavily', label: 'Tavily' },
              ]}
            />
          </Field>

          <Field
            label={translate('settings.webSearch.baseUrl')}
            hint={translate('settings.webSearch.baseUrlHint')}
            htmlFor="settings-web-base-url"
          >
            <Input
              id="settings-web-base-url"
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
            label={translate('settings.webSearch.apiKey')}
            htmlFor="settings-web-api-key"
            hint={
              draft.webSearch.hasApiKey
                ? translate('settings.webSearch.apiKeyStoredHint')
                : translate('settings.webSearch.apiKeyEmptyHint')
            }
          >
            <Input
              id="settings-web-api-key"
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
              label={translate('settings.webSearch.removeKey')}
            />
          )}
        </Panel>

        <Panel title={translate('settings.section.interface')}>
          <Field label={translate('settings.interface.theme')} htmlFor="settings-theme">
            <Select
              id="settings-theme"
              value={draft.theme}
              onChange={(value) => update('theme', value as Settings['theme'])}
              options={[
                { value: 'system', label: translate('theme.system') },
                { value: 'light', label: translate('theme.light') },
                { value: 'dark', label: translate('theme.dark') },
              ]}
            />
          </Field>
          <Field
            label={translate('settings.interface.language')}
            hint={translate('settings.interface.languageHint')}
            htmlFor="settings-locale"
          >
            <Select
              id="settings-locale"
              value={draft.locale}
              onChange={(value) => updateLocale(value as UiLocale)}
              options={[
                { value: 'en', label: translate('settings.interface.english') },
                { value: 'ru', label: translate('settings.interface.russian') },
              ]}
            />
          </Field>
        </Panel>

        <div className="flex justify-end">
          <Button variant="primary" type="submit" loading={saving}>
            {translate('settings.save')}
          </Button>
        </div>
        </fieldset>
      </form>
      <div className="mt-4">
        <ConnectionsSettings />
      </div>
      <div className="mt-4">
        <Glossary />
      </div>
      <div className="mt-4">
        <DeveloperSettings />
      </div>
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
