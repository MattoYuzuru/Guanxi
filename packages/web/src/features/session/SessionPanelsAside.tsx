import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, IconButton, SegmentedControl } from '@guanxi/ui'
import { translate as t } from '../../lib/locale.ts'
import { sessionPanelIcon, type SessionPanel, type SessionPanels } from './panels.ts'

/**
 * The open side panels beside the timeline (round 4): one rounded pane with an icon switch between
 * open panels, the shown panel's name and a close icon. In a narrow session (a phone, or a pane
 * under 720 px) it is a modal sheet instead: a full-screen dialog on the document body with the
 * app behind it inert, so focus stays in the sheet (review 3).
 */
export function SessionPanelsAside({ panels, render, onClosed, modal = false }: {
  panels: SessionPanels
  /** Show the panels as a modal full-screen sheet (the session is too narrow for a side pane). */
  modal?: boolean
  /** The panel's content; panels without a service say so in one sentence. */
  render: (panel: SessionPanel) => ReactNode
  /** Called after the last open panel closed (after the commit), so the caller can return focus. */
  onClosed?: () => void
}) {
  const aside = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const active = panels.active
  const sheet = modal
  const isOpen = active !== null
  // The rest of the app is inert while the sheet is open; the sheet itself lives outside it.
  useEffect(() => {
    if (!sheet || !isOpen) return
    const root = document.getElementById('root')
    if (!root || root.hasAttribute('inert')) return
    root.setAttribute('inert', '')
    return () => root.removeAttribute('inert')
  }, [sheet, isOpen])
  // On a phone the panel is a full-screen sheet over an inert page: focus moves into it when the
  // sheet opens, not when the shown panel changes (arrow keys in the switcher keep their focus).
  useEffect(() => { if (sheet && isOpen) closeButton.current?.focus() }, [sheet, isOpen])
  // Closing the last panel returns focus after the commit, once the page behind a sheet is no
  // longer inert; a synchronous focus landed on <body> (review 1).
  const returnFocus = useRef(false)
  useEffect(() => {
    if (isOpen || !returnFocus.current) return
    returnFocus.current = false
    onClosed?.()
  }, [isOpen, onClosed])
  if (!active) return null
  const title = (panel: SessionPanel) => t(`workspaceLayout.block.${panel}`)
  const close = () => {
    returnFocus.current = panels.open.length === 1
    panels.toggle(active, false)
  }
  const pane = <aside ref={aside} className={sheet ? 'native-session-aside session-panels session-panels-sheet' : 'native-session-aside session-panels'}
    role={sheet ? 'dialog' : undefined} aria-modal={sheet || undefined} aria-label={t('session.panels.region')} data-testid="session-panels"
    onKeyDown={event => {
      if (sheet && event.key === 'Tab') containTab(event, aside.current)
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
  return sheet ? createPortal(pane, document.body) : pane
}

/**
 * True when the session pane is narrower than a side pane needs (720 px): measured on the pane,
 * since the shell's sidebar takes part of the window. Without ResizeObserver, a phone-width window.
 */
export function useNarrowSession(): [boolean, (node: HTMLElement | null) => void] {
  const phone = usePhoneSheet()
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState<boolean | null>(null)
  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const measure = () => setNarrow(node.getBoundingClientRect().width < 720)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [narrow ?? phone, setNode]
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

/** Keeps Tab and Shift+Tab inside a modal sheet: past either end, focus wraps around. */
function containTab(event: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return
  const focusable = [...container.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter(node => node.tabIndex >= 0 && !node.hasAttribute('disabled') && node.getClientRects().length > 0)
  const first = focusable[0], last = focusable.at(-1)
  if (!first || !last) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || !container.contains(active))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || !container.contains(active))) { event.preventDefault(); first.focus() }
}

/** The one-sentence state of a panel whose service is not attached yet. */
export function SessionPanelEmpty({ panel }: { panel: Exclude<SessionPanel, 'context'> }) {
  return <p className="session-panels-empty">{t(`workspaceLayout.empty.${panel}`)}</p>
}
