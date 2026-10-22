import { Button } from '@guanxi/ui'
import type { SessionPageItem } from '@guanxi/contract'
import { SidebarSlot } from '../../kernel/SidebarSlot.tsx'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { sessionNavigationPath } from './sessionNavigation.ts'
import { sessionDateGroup, sessionStatus } from './sessionPresentation.ts'

export interface ShellSidebarProps {
  rail: boolean
  location: string
  sessions: readonly SessionPageItem[]
  pinned: readonly string[]
  loading: boolean
  loadingMore: boolean
  error: boolean
  omitted: boolean
  observedAt: string | null
  hasMore: boolean
  onLoadMore(): void
  onRefresh(): void
  onPin(sessionId: string): void
}

/** Feature composition of public primitives. The host owns geometry and visibility. */
export function ShellSidebar(props: ShellSidebarProps) {
  const core = [
    { key: 'new', to: paths.agent() }, { key: 'projects', to: paths.projects() },
    { key: 'models', to: paths.launcher() }, { key: 'settings', to: paths.settings() },
  ] as const
  const loaded = new Set(props.sessions.map(session => session.sessionId))
  const pinned = new Set(props.pinned)
  const groups = [
    { key: 'pinned' as const, sessions: props.sessions.filter(session => pinned.has(session.sessionId)) },
    ...(['today', 'yesterday', 'earlier'] as const).map(key => ({ key,
      sessions: props.sessions.filter(session => !pinned.has(session.sessionId) && sessionDateGroup(session.createdAt) === key) })),
  ]
  return <div className="flex min-w-0 flex-col gap-3">
    <nav aria-label={t('shell.navigation')}>
      <ul className="flex flex-col gap-1">
        {core.map(item => <li key={item.key}><Link to={item.to} aria-label={t(`shell.${item.key}`)}
          aria-current={props.location === item.to ? 'page' : undefined}
          title={props.rail ? t(`shell.${item.key}`) : undefined}
          className="flex min-h-8 items-center justify-start rounded-control px-2 py-1 text-14 hover:bg-inset focus-visible:outline-focus">
          {props.rail ? <span aria-hidden="true">{t(`shell.${item.key}`).slice(0, 1)}</span> : t(`shell.${item.key}`)}
        </Link></li>)}
      </ul>
    </nav>
    <div hidden={props.rail}>
      <SidebarSlot />
      <section aria-label={t('shell.sessions')} className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <h2 className="text-14 font-heading">{t('shell.sessions')}</h2>
          <Button variant="ghost" size="sm" disabled={props.loading || props.loadingMore} onClick={props.onRefresh}>
            {t('shell.sessions.refresh')}
          </Button>
        </div>
        {props.loading && <p role="status">{t('shell.sessions.loading')}</p>}
        {props.error && <p role="alert">{t('shell.sessions.error')}</p>}
        {props.omitted && <p className="text-12 text-secondary">{t('shell.sessions.omitted')}</p>}
        {props.observedAt && <p className="text-12 text-secondary">{t('shell.sessions.fetched', { time: formatDateTime(props.observedAt) })}</p>}
        {!props.loading && !props.error && !props.omitted && !props.sessions.length && <p>{t('shell.sessions.empty')}</p>}
        {props.pinned.some(id => !loaded.has(id)) && <p className="text-12 text-secondary">{t('shell.sessions.outsidePage')}</p>}
        {groups.filter(group => group.sessions.length > 0).map(group => <section key={group.key} aria-label={t(`shell.sessions.${group.key}`)}>
          <h3 className="text-12 font-heading">{t(`shell.sessions.${group.key}`)}</h3>
          <ul className="flex flex-col gap-2">
            {group.sessions.map(session => {
              const title = session.title || t('shell.sessions.untitled')
              return <li key={session.sessionId} className="flex min-w-0 items-start gap-1">
                <div className="min-w-0 flex-1">
                  <Link to={sessionNavigationPath(session.navigation)} aria-current={props.location === sessionNavigationPath(session.navigation) ? 'page' : undefined}
                    className="block min-h-8 break-words rounded-control px-2 py-1 text-14 hover:bg-inset focus-visible:outline-focus">{title}</Link>
                  <p className="px-2 text-12 text-secondary">{t(`shell.status.${sessionStatus(session)}`)}</p>
                  {session.execution && <p className="px-2 text-12 text-secondary">{t('shell.status.source', { time: formatDateTime(session.execution.observedAt) })}</p>}
                </div>
                <Button size="sm" variant="ghost" aria-pressed={pinned.has(session.sessionId)}
                  aria-label={t(pinned.has(session.sessionId) ? 'shell.sessions.unpin' : 'shell.sessions.pin', { title })}
                  onClick={() => props.onPin(session.sessionId)}>{pinned.has(session.sessionId) ? '−' : '+'}</Button>
              </li>
            })}
          </ul>
        </section>)}
        {props.hasMore && <Button variant="secondary" size="sm" disabled={props.loading || props.loadingMore} onClick={props.onLoadMore}>
          {props.loadingMore ? t('shell.sessions.loading') : t('shell.sessions.more')}
        </Button>}
      </section>
    </div>
  </div>
}
