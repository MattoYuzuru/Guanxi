import type { ExecuteNotificationActionBody, NotificationWire } from '@guanxi/contract'
import { Button, EmptyState, ErrorState } from '@guanxi/ui'
import { useEffect, useId, useRef, useState } from 'react'
import { formatDateTime, formatRelativeTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useAutoRecover } from '../../lib/recover.ts'
import { navigate, paths } from '../../lib/router.tsx'
import { FILTERS, visibleIds, type ListFilter, type OpResult } from './inbox-store.ts'
import { NotificationRow } from './NotificationRow.tsx'
import { useInboxSnapshot, useInboxStore } from './NotificationsProvider.tsx'
import { failureText, isOffline, pluralText } from './model.ts'

const iso = (ms: number) => new Date(ms).toISOString()
const SKELETON_ROWS = 3

/**
 * The notification center (ADR-0033). One inbox; every fact carries its source, observation time
 * and confidence; an action button exists only when the node says it can run it, and an action
 * the node cannot run is shown disabled with the reason, never hidden.
 */
export function NotificationsPage() {
  useLocale()
  const store = useInboxStore()
  const snapshot = useInboxSnapshot(store)
  const [filter, setFilter] = useState<ListFilter>('unread')
  const [status, setStatus] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const id = useId()
  const slice = snapshot.lists[filter]
  const ids = visibleIds(snapshot, filter)
  const rows = ids.map((rowId) => snapshot.rows[rowId]).filter((row): row is NotificationWire => row !== undefined)
  const offline = isOffline(snapshot, filter)
  const { availability } = snapshot

  useEffect(() => { headingRef.current?.focus() }, [])
  useEffect(() => {
    void store.activate(filter)
    return () => { void store.activate(null) }
  }, [store, filter])
  useEffect(() => {
    if (!availability.loaded && !availability.loading && !availability.failure) void store.loadAvailability()
  }, [store, availability.loaded, availability.loading, availability.failure])
  // When the node answers again after being unreachable, check which actions it supports once more.
  const wasOffline = useRef(offline)
  useEffect(() => {
    if (wasOffline.current && !offline && !availability.loaded && availability.failure && !availability.loading) void store.loadAvailability()
    wasOffline.current = offline
  }, [store, offline, availability.loaded, availability.failure, availability.loading])

  /** If the control that had focus went away (row left the filter, button replaced), land on a stable place. */
  const restoreFocus = (rowId: string | null, index: number) => {
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active !== null && active !== document.body && active.isConnected && !(active instanceof HTMLButtonElement && active.disabled)) return
      const list = listRef.current
      const same = rowId === null ? null : list?.querySelector<HTMLElement>(`[data-notification-id="${rowId}"]`) ?? null
      const articles = list ? [...list.querySelectorAll<HTMLElement>('article')] : []
      const target = same ?? articles[Math.min(index, articles.length - 1)] ?? statusRef.current
      target?.focus()
    })
  }

  const settle = async (row: NotificationWire, run: () => Promise<OpResult>, done: (result: Extract<OpResult, { ok: true }>) => string) => {
    const index = ids.indexOf(row.id)
    const result = await run()
    // A failure is announced by the row's own alert; only successes use the shared status.
    setStatus(result.ok ? done(result) : '')
    restoreFocus(row.id, index)
    return result.ok
  }

  const actionName = (action: ExecuteNotificationActionBody['action']) => t(`notifications.action.${action}`).replace(/…$/u, '')
  const handlers = {
    onRead: (row: NotificationWire) => settle(row, () => store.markRead(row.id), () => t('notifications.done.read')),
    onSnooze: (row: NotificationWire, untilMs: number) =>
      settle(row, () => store.snooze(row.id, untilMs), () => t('notifications.done.snooze', { time: formatDateTime(iso(untilMs)) })),
    onAction: async (row: NotificationWire, body: ExecuteNotificationActionBody) => {
      const ok = await settle(row, () => store.execute(row.id, body), (result) => result.stale
        ? t('notifications.done.stale')
        : result.duplicate
          ? t('notifications.done.duplicate', { action: actionName(body.action) })
          : body.action === 'open' ? t('notifications.done.open') : t('notifications.done.action', { action: actionName(body.action) }))
      // Opening a connection alert goes to where connections live.
      if (ok && body.action === 'open' && row.subject.type === 'connection') navigate(paths.settings())
      return ok
    },
    onDismiss: (row: NotificationWire) => store.dismissOp(row.id),
  }

  const loadMore = async () => {
    const before = rows.length
    await store.loadMore(filter)
    restoreFocus(null, before)
  }

  const empty = slice.loaded && rows.length === 0
  const initialFailure = !slice.loaded && slice.failure !== null
  const loading = !slice.loaded && slice.failure === null
  // The inbox stays current by itself (the provider polls with backoff); on this page a failed
  // first read and failed action availability are also asked again at once on focus (D-203).
  useAutoRecover(initialFailure ? slice.failure : null, () => { void store.refresh() })
  useAutoRecover(!availability.loaded && availability.failure ? availability.failure : null, () => { void store.loadAvailability() })
  const now = Date.now()

  return <section aria-labelledby={`${id}-title`} data-testid="notifications-page"
    className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4 p-4 text-foreground">
    <header className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h1 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-18 font-heading focus-visible:outline-focus">{t('notifications.title')}</h1>
      </div>
      <p className="text-12 text-secondary">{t('notifications.description')}</p>
    </header>

    <div role="group" aria-label={t('notifications.filter.label')} className="flex min-w-0 flex-wrap gap-2">
      {FILTERS.map((item) => <Button key={item} size="sm" variant={filter === item ? 'primary' : 'secondary'} aria-pressed={filter === item}
        data-filter={item} onClick={() => setFilter(item)}>{t(`notifications.filter.${item}`)}</Button>)}
    </div>

    {offline && <div role="status" data-testid="notifications-offline" className="flex min-w-0 flex-col gap-1 rounded-panel border border-warning bg-surface p-3 text-12">
      <p className="font-heading">{t('notifications.offline.title')}</p>
      <p className="break-words">{slice.loaded && slice.observedAt !== null
        ? t('notifications.offline.lastKnown', { time: formatDateTime(iso(slice.observedAt)), age: formatRelativeTime(iso(slice.observedAt)) })
        : t('notifications.offline.none')}</p>
    </div>}

    <p ref={statusRef} role="status" tabIndex={-1} data-testid="notifications-status" className="min-h-6 text-14 focus-visible:outline-focus">{status}</p>

    {loading && <div data-testid="notifications-loading">
      <p role="status" className="text-14">{t('notifications.loading')}</p>
      <ol aria-hidden="true" className="flex flex-col gap-3">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => <li key={index} className="h-24 rounded-panel border border-divider bg-inset" />)}
      </ol>
    </div>}

    {initialFailure && !offline && slice.failure && <ErrorState data-testid="notifications-error" title={`${t('notifications.error.title')}. ${failureText(slice.failure)}`}
      source={t('notifications.source.list')} occurredAt={iso(slice.failure.at)} timeMeaning="observed" details={slice.failure.code} />}
    {initialFailure && <p data-testid="notifications-recovering" className="text-12 text-secondary">{t('notifications.recovering')}</p>}

    {slice.loaded && !offline && slice.failure && <div role="alert" data-testid="notifications-stale" className="flex min-w-0 flex-col gap-2 rounded-panel border border-danger bg-surface p-3 text-12">
      <p className="break-words">{t('notifications.error.stale', { code: slice.failure.code, time: slice.observedAt === null ? t('notifications.fact.unknown') : formatDateTime(iso(slice.observedAt)) })}</p>
      <p className="break-words text-secondary">{failureText(slice.failure)}</p>
    </div>}

    {slice.loaded && slice.observedAt !== null && <p data-testid="notifications-observed" className="text-12 text-secondary">
      {availability.observedAt === null
        ? t('notifications.provenance', { time: formatDateTime(iso(slice.observedAt)), source: t('notifications.source.list') })
        : t('notifications.provenance.actions', {
          time: formatDateTime(iso(slice.observedAt)), source: t('notifications.source.list'),
          actionsTime: formatDateTime(iso(availability.observedAt)), actionsSource: t('notifications.source.actions'),
        })}
    </p>}

    {empty && <EmptyState data-testid="notifications-empty" title={t(`notifications.empty.${filter}`)}
      action={filter === 'all' ? undefined : <Button onClick={() => setFilter('all')}>{t('notifications.empty.showAll')}</Button>} />}

    {slice.loaded && rows.length > 0 && <>
      <ol ref={listRef} aria-label={t('notifications.list.label')} data-testid="notifications-list" className="flex min-w-0 flex-col gap-3">
        {rows.map((row) => <li key={row.id} className="min-w-0">
          <NotificationRow row={row} availability={availability} op={snapshot.ops[row.id]} offline={offline} now={now} {...handlers} />
        </li>)}
      </ol>
      <div className="flex min-w-0 flex-col gap-2">
        <p data-testid="notifications-paging" className="text-12 text-secondary">
          {slice.nextCursor !== null
            ? t('notifications.paging.more', { count: rows.length })
            : t('notifications.paging.end', { count: pluralText('notifications.count', rows.length) })}
        </p>
        {slice.moreFailure && <p role="alert" className="text-12 text-danger">{t('notifications.more.failed', { code: slice.moreFailure.code })}</p>}
        {slice.nextCursor !== null && <div><Button variant="secondary" loading={slice.loadingMore} loadingLabel={t('notifications.more.loading')}
          disabled={offline} aria-describedby={offline ? `${id}-offline` : undefined} onClick={() => { void loadMore() }}>{t('notifications.more')}</Button>
          {offline && <p id={`${id}-offline`} className="mt-1 text-12 text-secondary">{t('notifications.reason.offline')}</p>}</div>}
      </div>
    </>}
  </section>
}
