/**
 * The legacy Ollama adapter as a kernel plugin (K1 strangler step).
 *
 * `OllamaClient` is unchanged. The plugin provides the `ollama` service, which
 * hands out the client for the configured host (one current client, replaced
 * when the host changes, as `createAppContext` always did) and owns the
 * lifetime of its transport: unloading aborts every request still in flight, so
 * no connect/load/idle deadline timer outlives the plugin. A client kept past
 * unload fails its requests at once instead of reaching Ollama.
 */
import { definePlugin, effect, provide } from '@guanxi/kernel'
import { OllamaClient, type OllamaClientOptions } from './client.ts'

export const OLLAMA_ADAPTER_SERVICE = 'ollama'

export type OllamaAdapterConfig = Omit<OllamaClientOptions, 'host'>

export interface OllamaAdapter {
  /** The client for `host`; the same instance until the host changes. */
  client(host: string): OllamaClient
}

export const ollamaAdapterPlugin = definePlugin<OllamaAdapterConfig | undefined>({
  manifest: {
    id: 'guanxi.ollama-adapter',
    engines: { guanxi: '^0.1.0' },
    provides: [OLLAMA_ADAPTER_SERVICE],
    trust: 'T0',
  },
  apply(ctx, config) {
    const { fetch: transport, ...timeouts } = config ?? {}
    const lifetime = new AbortController()
    // Resolved per call, like the client's own `globalThis.fetch` default.
    const fetchWithinLifetime: typeof fetch = (input, init) => {
      if (lifetime.signal.aborted) {
        return Promise.reject(new DOMException('The Ollama adapter plugin was unloaded', 'AbortError'))
      }
      const signal = init?.signal
        ? AbortSignal.any([init.signal, lifetime.signal])
        : lifetime.signal
      return (transport ?? globalThis.fetch)(input, { ...init, signal })
    }
    let current: OllamaClient | null = null

    effect(ctx, () => () => {
      lifetime.abort('guanxi:ollama-adapter-unloaded')
      current = null
    }, 'ollama.abortInFlight()')

    const adapter: OllamaAdapter = {
      client(host) {
        if (!current || current.host !== host.replace(/\/+$/, '')) {
          current = new OllamaClient({ ...timeouts, host, fetch: fetchWithinLifetime })
        }
        return current
      },
    }
    provide(ctx, OLLAMA_ADAPTER_SERVICE, Object.freeze(adapter))
  },
})
