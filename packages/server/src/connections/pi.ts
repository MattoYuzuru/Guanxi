import { MIN_SECRET_LENGTH } from '../egress/types.ts'
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
  if (key.length < MIN_SECRET_LENGTH || key.includes('sk-ant-oat') || (provider === 'anthropic' && !key.startsWith('sk-ant-api'))) {
    throw new ConnectionError('validation_failed', 'An API key is required; subscription access uses the official CLI')
  }
}
export interface PiTransport {
  complete(model: Model<Api>, context: Context, options: SimpleStreamOptions, onText?: (delta: string) => void): Promise<AssistantMessage>
}
export const piTransport: PiTransport = {
  async complete(model, context, options, onText) {
    // The caller supplies only a catalog model, explicit API key and abort signal.
    if (model.api === 'google-generative-ai' && Object.entries(process.env).some(([name, value]) =>
      name.startsWith('GOOGLE_GENAI_USE_') && value && value.toLowerCase() !== 'false')) {
      throw new ConnectionError('policy_denied', 'Google SDK mode overrides must be unset for API-key connections')
    }
    const transcript = normalizeContext(context)
    const consume = async (stream: import('@earendil-works/pi-ai').AssistantMessageEventStream) => {
      for await (const event of stream) if (event.type === 'text_delta') onText?.(event.delta)
      return stream.result()
    }
    switch (model.api) {
      case 'anthropic-messages': return consume((await import('@earendil-works/pi-ai/api/anthropic-messages')).streamSimple(model as Model<'anthropic-messages'>, transcript, options))
      case 'openai-responses': return consume((await import('@earendil-works/pi-ai/api/openai-responses')).streamSimple(model as Model<'openai-responses'>, transcript, options))
      case 'openai-completions': {
        const wire = await import('@earendil-works/pi-ai/api/openai-completions')
        // Discovery supplies IDs, not output/context limits. Let the owner endpoint
        // apply its defaults rather than borrowing another model's catalog ceiling.
        return consume(piModels(model.provider).includes(model)
          ? wire.streamSimple(model as Model<'openai-completions'>, transcript, options)
          : wire.stream(model as Model<'openai-completions'>, transcript, {
            ...options, reasoningEffort: options.reasoning === 'off' ? undefined : options.reasoning,
          }))
      }
      case 'google-generative-ai': return consume((await import('@earendil-works/pi-ai/api/google-generative-ai')).streamSimple(model as Model<'google-generative-ai'>, transcript, options))
      default: throw new Error('Unsupported model wire protocol')
    }
  },
}
