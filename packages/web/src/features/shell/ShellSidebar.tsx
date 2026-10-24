import { Button, Icon, IconButton, type IconName } from '@guanxi/ui'
import type { SessionPageItem } from '@guanxi/contract'
import { SidebarSlot } from '../../kernel/SidebarSlot.tsx'
import { formatTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { sessionNavigationPath } from './sessionNavigation.ts'
import { sessionDateGroup, sessionStatus } from './sessionPresentation.ts'
import './shell.css'

export interface ShellSidebarProps {
  rail: boolean
  location: string
  /** Where "New session" goes: the new-session screen in the current project (D-207). */
  newSessionPath?: string
  sessions: readonly SessionPageItem[]
  pinned: readonly string[]
  /** Ids of sessions that finished and have not been opened since (derived by the host). */
  unseen: ReadonlySet<string>
  loading: boolean
  loadingMore: boolean
  error: boolean
  omitted: boolean
  hasMore: boolean
  onLoadMore(): void
  onPin(sessionId: string): void
}

const CORE: { key: 'new' | 'projects' | 'models' | 'connections' | 'settings'; icon: IconName; to: string }[] = [
  { key: 'new', icon: 'new', to: paths.agent() },
  { key: 'projects', icon: 'projects', to: paths.projects() },
  { key: 'models', icon: 'models', to: paths.launcher() },
  { key: 'connections', icon: 'relay', to: paths.connections() },
  { key: 'settings', icon: 'settings', to: paths.settings() },
]

/**
 * Feature composition of public primitives (D-202, D-203). Navigation rows carry an icon and a
 * label (icon only in the rail); the session list stays current by itself, so there is no
 * Refresh button and no "fetched at" caption. Loading shows only before the first page.
 */
export function ShellSidebar(props: ShellSidebarProps) {
  const loaded = new Set(props.sessions.map(session => session.sessionId))
  const pinned = new Set(props.pinned)
  const groups = [
    { key: 'pinned' as const, sessions: props.sessions.filter(session => pinned.has(session.sessionId)) },
    ...(['today', 'yesterday', 'earlier'] as const).map(key => ({ key,
      sessions: props.sessions.filter(session => !pinned.has(session.sessionId) && sessionDateGroup(session.createdAt) === key) })),
  ]
  const unseenLabel = t(props.hasMore || props.omitted ? 'shell.unseen.countAtLeast' : 'shell.unseen.count', { count: props.unseen.size })
  const firstLoad = props.loading && props.sessions.length === 0
  return <div className="shell-sidebar" data-rail={props.rail || undefined}>
    <nav aria-label={t('shell.navigation')}>
      <ul className="shell-nav">
        {CORE.map(item => <li key={item.key}>
          <Link to={item.key === 'new' ? props.newSessionPath ?? item.to : item.to} aria-label={t(`shell.${item.key}`)}
            aria-current={coreCurrent(item.key, props.location) ? 'page' : undefined}
            title={props.rail ? t(`shell.${item.key}`) : undefined}
            className="shell-nav-item">
            <Icon name={item.icon} size={16} />
            {props.rail ? null : <span>{t(`shell.${item.key}`)}</span>}
          </Link>
        </li>)}
      </ul>
    </nav>
    {props.rail && props.unseen.size > 0 && <p data-testid="shell-unseen-rail" className="shell-unseen-rail">
      <span aria-hidden="true">{props.unseen.size}</span><span className="sr-only">{unseenLabel}</span></p>}
    <div hidden={props.rail} className="shell-sidebar-scroll">
      <SidebarSlot />
      <section aria-label={t('shell.sessions')} className="shell-sessions">
        <div className="shell-sessions-head">
          <h2 className="shell-section-label">{t('shell.sessions')}</h2>
          {props.unseen.size > 0 && <p data-testid="shell-unseen-count" className="shell-unseen-count">
            <span aria-hidden="true">{props.unseen.size}</span><span className="sr-only">{unseenLabel}</span></p>}
        </div>
        {firstLoad && <div role="status" aria-label={t('shell.sessions.loading')} className="shell-skeleton">
          {[0, 1, 2].map(index => <span key={index} />)}
        </div>}
        {props.error && props.sessions.length === 0 && <p role="status" className="shell-note">{t('shell.sessions.recovering')}</p>}
        {props.omitted && <p className="shell-note">{t('shell.sessions.omitted')}</p>}
        {!props.loading && !props.error && !props.omitted && !props.sessions.length && <p className="shell-note">{t('shell.sessions.empty')}</p>}
        {props.pinned.some(id => !loaded.has(id)) && <p className="shell-note">{t('shell.sessions.outsidePage')}</p>}
        {groups.filter(group => group.sessions.length > 0).map(group => <section key={group.key} aria-label={t(`shell.sessions.${group.key}`)} className="shell-session-group">
          <h3 className="shell-section-label">{t(`shell.sessions.${group.key}`)}</h3>
          <ul>
            {group.sessions.map(session => {
              const title = session.title || t('shell.sessions.untitled')
              const status = sessionStatus(session)
              const target = sessionNavigationPath(session.navigation)
              const isPinned = pinned.has(session.sessionId)
              return <li key={session.sessionId} className="shell-session-row" data-pinned={isPinned || undefined}>
                <Link to={target} aria-current={props.location === target ? 'page' : undefined} className="shell-session-link"
                  aria-describedby={`shell-session-${session.sessionId}`}>
                  <span className="shell-status-dot" data-status={status} aria-hidden="true" />
                  <span className="shell-session-title">{title}</span>
                  {props.unseen.has(session.sessionId) && <span data-unseen="true" className="shell-unseen-mark" aria-hidden="true" />}
                </Link>
                {/* Status, provenance and the unseen mark are the row's description, not its name. */}
                <span id={`shell-session-${session.sessionId}`} className="sr-only">
                  <span>{t(`shell.status.${status}`)}</span>
                  {session.execution && <span>{` ${t('shell.status.source', { time: formatTime(session.execution.observedAt) })}`}</span>}
                  {props.unseen.has(session.sessionId) && <span>{` ${t('shell.unseen.row')}`}</span>}
                </span>
                {/* A toggle says its state once (P3): the pressed state, not a changing label as well. */}
                <IconButton size="sm" className="shell-session-pin" pressed={isPinned} icon={<Icon name="pin" />}
                  label={t('shell.sessions.pin', { title })}
                  onClick={() => props.onPin(session.sessionId)} />
              </li>
            })}
          </ul>
        </section>)}
        {props.hasMore && <Button variant="ghost" size="sm" disabled={props.loading || props.loadingMore} loading={props.loadingMore} onClick={props.onLoadMore}>
          {t('shell.sessions.more')}
        </Button>}
      </section>
    </div>
  </div>
}

/** Core destinations stay current on their nested legacy routes (models/:name, settings/developer). */
function coreCurrent(key: 'new' | 'projects' | 'models' | 'connections' | 'settings', location: string): boolean {
  const path = location.split('?')[0] ?? '/'
  if (key === 'new') return path === '/agent' || path.startsWith('/agent/')
  if (key === 'projects') return path === '/projects' || path.startsWith('/projects/')
  if (key === 'models') return path === '/' || path.startsWith('/models/')
  if (key === 'connections') return path === '/connections'
  return path === '/settings' || path.startsWith('/settings/')
}
