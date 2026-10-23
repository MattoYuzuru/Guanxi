import type { Settings, UpdateSettingsBody } from '@guanxi/contract'

/**
 * What a node answers to a settings update: the patch applied to the stored settings. The web
 * search API key is write-only, so the answer only says whether one is stored.
 */
export function applySettingsPatch(base: Settings, patch: UpdateSettingsBody): Settings {
  const search = patch.webSearch
  return {
    ...base,
    ollamaHost: patch.ollamaHost ?? base.ollamaHost,
    defaultModel: patch.defaultModel === undefined ? base.defaultModel : patch.defaultModel,
    defaultNumCtx: patch.defaultNumCtx ?? base.defaultNumCtx,
    autoApproveTools: patch.autoApproveTools ?? base.autoApproveTools,
    enableBash: patch.enableBash ?? base.enableBash,
    prewarmEnabled: patch.prewarmEnabled ?? base.prewarmEnabled,
    locale: patch.locale ?? base.locale,
    theme: patch.theme ?? base.theme,
    webSearch: search === undefined ? base.webSearch : {
      provider: search.provider ?? base.webSearch.provider,
      baseUrl: search.baseUrl === undefined ? base.webSearch.baseUrl : search.baseUrl,
      hasApiKey: search.apiKey === undefined ? base.webSearch.hasApiKey : Boolean(search.apiKey),
    },
  }
}
