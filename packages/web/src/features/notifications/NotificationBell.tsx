import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, paths, useRoute } from '../../lib/router.tsx'
import { unreadSummary, type InboxStore } from './inbox-store.ts'
import { useInboxSnapshot, useOptionalInboxStore } from './NotificationsProvider.tsx'
import { pluralText } from './model.ts'

/**
 * The status-strip inbox entry: a link to the notification center with the unread count and a
 * polite live region that announces arrivals. Without a provider, or before the first answer,
 * the count is unknown and says so; it is never shown as 0.
 */
export function NotificationBell() {
  useLocale()
  const store = useOptionalInboxStore()
  if (store === null) return <span className="text-secondary">{t('shell.status.unknown')}</span>
  return <Bell store={store} />
}

function Bell({ store }: { store: InboxStore }) {
  const snapshot = useInboxSnapshot(store)
  const route = useRoute()
  const summary = unreadSummary(snapshot)
  const [announcement, setAnnouncement] = useState('')
  const seenArrivals = useRef<number | null>(null)

  const countText = summary.atLeast
    ? t('notifications.unread.atLeast', { count: summary.count })
    : summary.count === 0 ? t('notifications.bell.none') : pluralText('notifications.unread', summary.count)

  useEffect(() => {
    if (!summary.loaded) return
    if (seenArrivals.current === null) { seenArrivals.current = snapshot.arrivals; return }
    if (snapshot.arrivals <= seenArrivals.current) return
    const added = snapshot.arrivals - seenArrivals.current
    seenArrivals.current = snapshot.arrivals
    setAnnouncement(`${pluralText('notifications.new', added)}. ${countText}`)
  }, [snapshot.arrivals, summary.loaded, countText])

  const visible = !summary.loaded
    ? summary.failure ? t('shell.status.unknown') : t('notifications.bell.loading')
    : countText
  const stale = summary.loaded && summary.failure !== null && summary.observedAt !== null
    ? t('notifications.bell.stale', { time: formatDateTime(new Date(summary.observedAt).toISOString()) })
    : null

  return <>
    <Link to={paths.notifications()} data-testid="notification-bell" data-unread={summary.loaded ? summary.count : undefined}
      aria-current={route.name === 'notifications' ? 'page' : undefined}
      className="inline-flex min-h-8 min-w-0 flex-wrap items-center gap-1 rounded-control px-2 py-1 text-12 hover:bg-inset focus-visible:outline-focus">
      <span className="sr-only">{t('notifications.navigation')}: </span>
      {summary.loaded && summary.count > 0 && <span aria-hidden="true">●</span>}
      <span data-testid="notification-bell-count" className={summary.count > 0 ? 'font-heading' : undefined}>{visible}</span>
      {stale !== null && <span className="text-secondary">· {stale}</span>}
    </Link>
    <span role="status" aria-live="polite" aria-atomic="true" data-testid="notification-live" className="sr-only">{announcement}</span>
  </>
}
