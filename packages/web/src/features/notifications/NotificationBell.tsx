import { Icon, IconButton } from '@guanxi/ui'
import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, paths, useRoute } from '../../lib/router.tsx'
import { unreadSummary, type InboxStore } from './inbox-store.ts'
import { useInboxSnapshot, useOptionalInboxStore } from './NotificationsProvider.tsx'
import { pluralText } from './model.ts'

/**
 * The status-strip inbox entry (D-202): a tray icon that links to the notification center, with
 * the unread count as a badge, the full count sentence as its name and tooltip, and a polite live
 * region that announces arrivals. Without a provider, or before the first answer, the count is
 * unknown and says so; it is never shown as 0.
 */
export function NotificationBell() {
  useLocale()
  const store = useOptionalInboxStore()
  if (store === null) return <IconButton label={`${t('notifications.navigation')}: ${t('shell.status.unknown')}`} icon={<Icon name="inbox" />} disabled />
  return <Bell store={store} />
}

function Bell({ store }: { store: InboxStore }) {
  const snapshot = useInboxSnapshot(store)
  const route = useRoute()
  const summary = unreadSummary(snapshot)
  const [announcement, setAnnouncement] = useState('')
  const seenArrivals = useRef<number | null>(null)

  const countText = summary.atLeast
    // Everything loaded is handled but the node holds more: a bound of 0 would read as "none".
    ? summary.count === 0 ? t('notifications.unread.moreOnNode') : t('notifications.unread.atLeast', { count: summary.count })
    : summary.count === 0 ? t('notifications.bell.none') : pluralText('notifications.unread', summary.count)

  useEffect(() => {
    if (!summary.loaded) return
    if (seenArrivals.current === null) { seenArrivals.current = snapshot.arrivals; return }
    if (snapshot.arrivals <= seenArrivals.current) return
    const added = snapshot.arrivals - seenArrivals.current
    seenArrivals.current = snapshot.arrivals
    setAnnouncement(t('notifications.bell.arrival', { added: pluralText('notifications.new', added), summary: countText }))
  }, [snapshot.arrivals, summary.loaded, countText])

  const visible = !summary.loaded
    ? summary.failure ? t('shell.status.unknown') : t('notifications.bell.loading')
    : countText
  const shown = summary.loaded && summary.failure !== null && summary.observedAt !== null
    ? t('notifications.bell.staleSummary', { summary: visible, time: formatDateTime(new Date(summary.observedAt).toISOString()) })
    : visible

  return <>
    <IconButton data-testid="notification-bell" data-unread={summary.loaded ? summary.count : undefined}
      label={`${t('notifications.navigation')}: ${shown}`} icon={<Icon name="inbox" />}
      badge={summary.loaded && summary.count > 0 ? summary.count : summary.loaded && summary.failure !== null ? true : undefined}
      badgeTone={summary.loaded && summary.failure !== null && summary.count === 0 ? 'warning' : 'accent'}
      aria-current={route.name === 'notifications' ? 'page' : undefined}
      nativeButton={false} render={<Link to={paths.notifications()} />} />
    <span data-testid="notification-bell-count" className="sr-only">{shown}</span>
    <span role="status" aria-live="polite" aria-atomic="true" data-testid="notification-live" className="sr-only">{announcement}</span>
  </>
}
