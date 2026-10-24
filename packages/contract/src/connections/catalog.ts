import { z } from 'zod'
import type { Connection } from './index.ts'

/**
 * The owner-facing provider catalog. One entry per `connectionProviderSchema`
 * value; the provider enum itself is unchanged. Product labels are literal
 * names; UI chrome around them stays in locale keys.
 *
 * This file deliberately imports the connection types with `import type` only:
 * the runtime enum lives in `./index.ts`, which re-exports this module, and a
 * value import would create an ESM cycle.
 */
export const providerCategorySchema = z.enum(['llm_api', 'local_runtime', 'agent_subscription', 'search', 'speech'])
export type ProviderCategory = z.infer<typeof providerCategorySchema>

/** Stable display order for category sections. */
export const providerCategoryOrder: readonly ProviderCategory[] = Object.freeze([
  'llm_api', 'local_runtime', 'agent_subscription', 'search', 'speech',
])

export const providerBaseUrlPolicySchema = z.enum(['none', 'optional', 'required'])
export type ProviderBaseUrlPolicy = z.infer<typeof providerBaseUrlPolicySchema>

export const providerModelSourceSchema = z.enum(['catalog', 'endpoint', 'local', 'none'])
export type ProviderModelSource = z.infer<typeof providerModelSourceSchema>

export interface ProviderCatalogEntry {
  provider: Connection['provider']
  category: ProviderCategory
  kind: Connection['kind']
  auth: Connection['auth']
  label: string
  /** Credential format only, never a credential. `null` means the provider has no key. */
  keyHint: string | null
  docsUrl: string | null
  baseUrl: ProviderBaseUrlPolicy
  models: ProviderModelSource
}

const entry = (value: ProviderCatalogEntry): Readonly<ProviderCatalogEntry> => Object.freeze(value)

export const providerCatalog: readonly Readonly<ProviderCatalogEntry>[] = Object.freeze([
  entry({
    provider: 'claude-code', category: 'agent_subscription', kind: 'agent', auth: 'cli_login',
    label: 'Claude Code', keyHint: 'starts with sk-ant-oat', docsUrl: null, baseUrl: 'none', models: 'none',
  }),
  entry({
    provider: 'codex', category: 'agent_subscription', kind: 'agent', auth: 'cli_login',
    label: 'Codex', keyHint: null, docsUrl: null, baseUrl: 'none', models: 'none',
  }),
  entry({
    provider: 'copilot', category: 'agent_subscription', kind: 'agent', auth: 'cli_login',
    label: 'GitHub Copilot', keyHint: null, docsUrl: null, baseUrl: 'none', models: 'none',
  }),
  // This hint names the `sk-ant-usr` family. `assertApiKey` accepts it only with the
  // `lead/k5-usr-key-family` change, which the lead integrates alongside this branch.
  entry({
    provider: 'anthropic', category: 'llm_api', kind: 'model_api', auth: 'api_key',
    label: 'Anthropic', keyHint: 'starts with sk-ant-api or sk-ant-usr',
    docsUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'none', models: 'catalog',
  }),
  entry({
    provider: 'openai', category: 'llm_api', kind: 'model_api', auth: 'api_key',
    label: 'OpenAI', keyHint: 'starts with sk-',
    docsUrl: 'https://platform.openai.com/api-keys', baseUrl: 'optional', models: 'catalog',
  }),
  entry({
    provider: 'google', category: 'llm_api', kind: 'model_api', auth: 'api_key',
    label: 'Google Gemini', keyHint: 'starts with AIza',
    docsUrl: 'https://aistudio.google.com/app/apikey', baseUrl: 'none', models: 'catalog',
  }),
  entry({
    provider: 'openrouter', category: 'llm_api', kind: 'model_api', auth: 'api_key',
    label: 'OpenRouter', keyHint: 'starts with sk-or-v1-',
    docsUrl: 'https://openrouter.ai/settings/keys', baseUrl: 'none', models: 'catalog',
  }),
  entry({
    provider: 'deepseek', category: 'llm_api', kind: 'model_api', auth: 'api_key',
    label: 'DeepSeek', keyHint: 'starts with sk-',
    docsUrl: 'https://platform.deepseek.com/api_keys', baseUrl: 'none', models: 'catalog',
  }),
  entry({
    provider: 'ollama', category: 'local_runtime', kind: 'local_runtime', auth: 'none',
    label: 'Ollama', keyHint: null, docsUrl: null, baseUrl: 'none', models: 'local',
  }),
  entry({
    provider: 'brave', category: 'search', kind: 'service', auth: 'api_key',
    label: 'Brave Search', keyHint: '32-character API token',
    docsUrl: 'https://api.search.brave.com/app/keys', baseUrl: 'none', models: 'none',
  }),
  entry({
    provider: 'tavily', category: 'search', kind: 'service', auth: 'api_key',
    label: 'Tavily', keyHint: 'starts with tvly-',
    docsUrl: 'https://app.tavily.com/home', baseUrl: 'none', models: 'none',
  }),
  entry({
    provider: 'openai-stt', category: 'speech', kind: 'service', auth: 'api_key',
    label: 'OpenAI speech-to-text', keyHint: 'starts with sk-',
    docsUrl: 'https://platform.openai.com/api-keys', baseUrl: 'none', models: 'none',
  }),
])
