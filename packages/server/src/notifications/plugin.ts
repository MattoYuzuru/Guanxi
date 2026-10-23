import { definePlugin } from '@guanxi/kernel'
import type { ActionPorts } from './actions.ts'
import { DeliveryDispatcher, type NotificationDeliveryConfig } from './dispatcher.ts'
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
  /**
   * Opt-in delivery. Absent means ingestion writes no delivery rows and never calls an
   * adapter. The host supplies the account settings and, when available, the OS notifier.
   */
  delivery?: NotificationDeliveryConfig
}

/**
 * Opens the NC1 sidecar and provides the inbox. Loading performs no ingestion and starts no
 * timer or interval; unload closes the database. Deferred deliveries are delivered only when
 * the host calls `inbox.deliverDue(now)` on its own scheduler.
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
    const delivery = config.delivery === undefined
      ? undefined
      : new DeliveryDispatcher(store, {
          now,
          settings: config.delivery.settings,
          ...(config.delivery.os === undefined ? {} : { os: config.delivery.os }),
        })
    ctx.provide(NOTIFICATIONS_SERVICE, new NotificationInbox(
      store,
      new NotificationService(store, { now }),
      { now, ports: config.ports, ...(delivery === undefined ? {} : { delivery }) },
    ))
  },
})
