import { definePlugin } from '@guanxi/kernel'
import { GlossaryService } from './service.ts'
import { GlossaryStore } from './store.ts'

export const VOICE_SERVICE = 'voice.glossary'
export const VOICE_PLUGIN_ID = 'guanxi.voice'

export interface VoiceConfig {
  /** Normally `<dataDir>/voice.sqlite`. */
  databasePath: string
  /** Caller clock in milliseconds; tests inject one. */
  now?: () => number
}

/** What the plugin provides: the store for mutations and the cached compiled-glossary service. */
export interface VoiceGlossary {
  readonly store: GlossaryStore
  readonly service: GlossaryService
}

/**
 * Opens the V1 sidecar. No STT adapter, audio path or background work is part of this plugin;
 * unload closes the cache subscription and the database.
 */
export const voicePlugin = definePlugin<VoiceConfig>({
  manifest: {
    id: VOICE_PLUGIN_ID,
    engines: { guanxi: '^0.1.0' },
    provides: [VOICE_SERVICE],
    trust: 'T0',
  },
  apply(ctx, config) {
    const store = new GlossaryStore(config.databasePath, config.now ?? Date.now)
    ctx.effect(() => () => store.close(), 'voice.close')
    const service = new GlossaryService(store)
    ctx.effect(() => () => service.close(), 'voice.service.close')
    ctx.provide<VoiceGlossary>(VOICE_SERVICE, Object.freeze({ store, service }))
  },
})
