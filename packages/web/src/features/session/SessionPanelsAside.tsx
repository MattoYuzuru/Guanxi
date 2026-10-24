import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Icon, IconButton, SegmentedControl } from '@guanxi/ui'
import { translate as t } from '../../lib/locale.ts'
import { sessionPanelIcon, type SessionPanel, type SessionPanels } from './panels.ts'

/**
 * The open side panels beside the timeline (round 4): one rounded pane with an icon switch between
 * open panels, the shown panel's name and a close icon. A narrow pane shows it over the session,
 * a phone as a full-screen sheet (the native session's side-chat geometry).
 */
export function SessionPanelsAside({ panels, render, onClosed }: {
  panels: SessionPanels
  /** The panel's content; panels without a service say so in one sentence. */
  render: (panel: SessionPanel) => ReactNode
  /** Called after the last open panel closes, so the caller can return focus. */
  onClosed?: () => void
}) {
  const aside = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const active = panels.active
  const sheet = usePhoneSheet()
  const isOpen = active !== null
  // On a phone the panel is a full-screen sheet over an inert page: focus moves into it when the
  // sheet opens, not when the shown panel changes (arrow keys in the switcher keep their focus).
  useEffect(() => { if (sheet && isOpen) closeButton.current?.focus() }, [sheet, isOpen])
  if (!active) return null
  const title = (panel: SessionPanel) => t(`workspaceLayout.block.${panel}`)
  const close = () => {
    const last = panels.open.length === 1
    panels.toggle(active, false)
    if (last) onClosed?.()
  }
  return <aside ref={aside} className="native-session-aside session-panels" aria-label={t('session.panels.region')} data-testid="session-panels"
    onKeyDown={event => {
      // Escape from a popover inside the panel bubbles here through the portal; only the panel's own DOM closes it.
      if (event.key !== 'Escape' || event.defaultPrevented || !aside.current?.contains(event.target as Node)) return
      event.stopPropagation(); close()
    }}>
    <header className="session-panels-header">
      {panels.open.length > 1
        ? <SegmentedControl iconOnly label={t('session.panels.choose')} value={active} onValueChange={panels.show}
          options={panels.open.map(panel => ({ value: panel, label: title(panel), icon: sessionPanelIcon[panel] }))} />
        : <Icon name={sessionPanelIcon[active]} size={16} className="session-panels-icon" />}
      <h2 className="session-panels-title">{title(active)}</h2>
      <IconButton ref={closeButton} size="sm" label={t('session.panels.close', { panel: title(active) })} icon={<Icon name="close" />} onClick={close} />
    </header>
    <div className="session-panels-body" data-panel={active}>{render(active)}</div>
  </aside>
}

const PHONE = '(max-width: 639px)'
function subscribePhone(listener: () => void) {
  const query = window.matchMedia(PHONE)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
/** True on a phone-width screen, where an open panel is a full-screen sheet. */
export function usePhoneSheet(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false)
}

/** The one-sentence state of a panel whose service is not attached yet. */
export function SessionPanelEmpty({ panel }: { panel: Exclude<SessionPanel, 'context'> }) {
  return <p className="session-panels-empty">{t(`workspaceLayout.empty.${panel}`)}</p>
}
