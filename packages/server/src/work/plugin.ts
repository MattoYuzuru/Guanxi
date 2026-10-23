import { definePlugin } from '@guanxi/kernel'
import { WorkLedger } from './ledger.ts'
import { WorkStore } from './store.ts'

export const WORK_SERVICE = 'work.ledger'
export const WORK_PLUGIN_ID = 'guanxi.work'

export interface WorkConfig {
  /** Normally `<dataDir>/work.sqlite`. */
  databasePath: string
  /** Caller clock in milliseconds; tests inject one. */
  now?: () => number
}

/**
 * Opens the WG1-a sidecar. Project mode stays off until a person sets it (D-173); loading
 * claims no work, starts no timer and reads no workspace. Unload closes the database.
 */
export const workPlugin = definePlugin<WorkConfig>({
  manifest: {
    id: WORK_PLUGIN_ID,
    engines: { guanxi: '^0.1.0' },
    provides: [WORK_SERVICE],
    trust: 'T0',
  },
  apply(ctx, config) {
    const now = config.now ?? Date.now
    const store = new WorkStore(config.databasePath, now)
    ctx.effect(() => () => store.close(), 'work.close')
    ctx.provide(WORK_SERVICE, new WorkLedger(store, now))
  },
})
