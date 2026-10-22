import { definePlugin } from '@guanxi/kernel'
import type { ActionPorts } from './actions.ts'
import { NotificationInbox } from './inbox.ts'
import { NotificationService } from './service.ts'
import { NotificationStore } from './store.ts'

export const NOTIFICATIONS_SERVICE = 'notifications.inbox'
export const NOTIFICATIONS_PLUGIN_ID = 'guanxi.notifications'

export interface NotificationsConfig {
  /** Normally `<dataDir>/notifications.sqlite`. */
  databasePath: string
  /** Caller clock in milliseconds; tests inject one. */
  now?: () => number
  /** Host effect ports; omitted actions are refused as `not_configured`. */
  ports?: Partial<ActionPorts>
}

/**
 * Opens the NC1 sidecar and provides the inbox. Loading performs no ingestion and starts no
 * timer or interval; unload closes the database.
 */
export const notificationsPlugin = definePlugin<NotificationsConfig>({
  manifest: {
    id: NOTIFICATIONS_PLUGIN_ID,
    engines: { guanxi: '^0.1.0' },
    provides: [NOTIFICATIONS_SERVICE],
    trust: 'T0',
  },
  apply(ctx, config) {
    const now = config.now ?? Date.now
    const store = new NotificationStore(config.databasePath, now)
    ctx.effect(() => () => store.close(), 'notifications.close')
    ctx.provide(NOTIFICATIONS_SERVICE, new NotificationInbox(store, new NotificationService(store, { now }), { now, ports: config.ports }))
  },
})
