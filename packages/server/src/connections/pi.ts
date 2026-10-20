import { ConnectionError } from './errors.ts'
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models'
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models'
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models'

// Import catalogs and wire implementations only. Provider factories and their OAuth
// resolvers are deliberately unreachable. No environment credential fallback.
const catalogs: Record<string, readonly Model<Api>[]> = {
  anthropic: Object.values(ANTHROPIC_MODELS), openai: Object.values(OPENAI_MODELS), google: Object.values(GOOGLE_MODELS),
  deepseek: Object.values(DEEPSEEK_MODELS), openrouter: Object.values(OPENROUTER_MODELS),
}
export function piModels(provider: string): readonly Model<Api>[] { return catalogs[provider] ?? [] }
export function assertApiKey(provider: string, key: string) {
  // pi-ai automatically switches to OAuth bearer auth for this token family.
  // Reject it even if a caller mislabels it as an API key.
  if (!key || key.includes('sk-ant-oat') || (provider === 'anthropic' && !key.startsWith('sk-ant-api'))) {
    throw new ConnectionError('validation_failed', 'An API key is required; subscription access uses the official CLI')
  }
}
export interface PiTransport {
  complete(model: Model<Api>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessage>
}
export const piTransport: PiTransport = {
  async complete(model, context, options) {
    // The caller supplies only a catalog model, explicit API key and abort signal.
    const transcript = normalizeContext(context)
    switch (model.api) {
      case 'anthropic-messages': return (await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple(model as Model<'anthropic-messages'>, transcript, options).result()
      case 'openai-responses': return (await import('@earendil-works/pi-ai/api/openai-responses')).streamSimple(model as Model<'openai-responses'>, transcript, options).result()
      case 'openai-completions': return (await import('@earendil-works/pi-ai/api/openai-completions')).streamSimple(model as Model<'openai-completions'>, transcript, options).result()
      case 'google-generative-ai': return (await import('@earendil-works/pi-ai/api/google-generative-ai')).streamSimple(model as Model<'google-generative-ai'>, transcript, options).result()
      default: throw new Error('Unsupported model wire protocol')
    }
  },
}
