/*
 * Guanxi shell pattern. The host owns the navigation, status items and workspace content;
 * this component owns their fixed positions, the controlled side/visibility geometry and the
 * focus hand-off. No viewport JavaScript: the narrow flow follows the existing 639 px
 * workspace breakpoint as a container query, so a phone viewport and a narrow host frame use
 * the same rule and controlled state survives resizing.
 */
import { PanelLeft } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from '../button/button.tsx'
import { IconButton } from '../icon-button/icon-button.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../menu/menu.tsx'
import './app-shell-chrome.css'

export type AppShellSide = 'left' | 'right'
export type AppShellVisibility = 'expanded' | 'rail' | 'hidden'

export interface AppShellLabels {
  /** Restores a hidden sidebar. */
  show: string
  /** Expanded → rail. */
  collapse: string
  /** Rail → expanded. */
  expand: string
  /** Expanded or rail → hidden. */
  hide: string
  /** Moves a left sidebar to the right. */
  moveLeft: string
  /** Moves a right sidebar to the left. */
  moveRight: string
  /** Opens the command palette from the persistent status strip. */
  palette: string
}

export interface AppShellChromeProps {
  /** Controlled side. It changes both the visual column order and the DOM/focus order. */
  side: AppShellSide
  /** Controlled visibility. The sidebar stays mounted when it is hidden. */
  visibility: AppShellVisibility
  /** Host navigation. It should adapt itself to `visibility === 'rail'`; the chrome does not invent rail content. */
  sidebar: ReactNode
  /** Persistent status items. The chrome adds Show (while hidden) and Palette actions. */
  status: ReactNode
  /** Main, opaque reading surface. It stays mounted while the sidebar changes. */
  children: ReactNode
  /** Accessible name for the navigation region and its menu trigger. */
  sidebarLabel: string
  /** Translated product strings supplied by the localized host. */
  labels: AppShellLabels
  onSide: (side: AppShellSide) => void
  onVisibility: (visibility: AppShellVisibility) => void
  onOpenPalette: () => void
}

export function AppShellChrome({
  side,
  visibility,
  sidebar,
  status,
  children,
  sidebarLabel,
  labels,
  onSide,
  onVisibility,
  onOpenPalette,
}: AppShellChromeProps) {
  const sidebarId = useId()
  const sidebarRef = useRef<HTMLElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const showRef = useRef<HTMLButtonElement>(null)
  const previousVisibility = useRef<AppShellVisibility>(visibility)
  const sidebarHadFocus = useRef(false)
  const returnFocusToShow = useRef(false)
  const returnFocusToSidebar = useRef(false)

  useEffect(() => {
    const previous = previousVisibility.current
    previousVisibility.current = visibility
    if (visibility === 'hidden' && previous !== 'hidden' && (returnFocusToShow.current || sidebarHadFocus.current)) {
      returnFocusToShow.current = false
      sidebarHadFocus.current = false
      showRef.current?.focus()
      return
    }
    if (visibility !== 'hidden' && previous === 'hidden' && returnFocusToSidebar.current) {
      returnFocusToSidebar.current = false
      const target = menuTriggerRef.current ?? sidebarRef.current
      target?.focus()
    }
  }, [visibility])

  const hide = () => {
    returnFocusToShow.current = true
    onVisibility('hidden')
  }

  const show = () => {
    returnFocusToSidebar.current = true
    onVisibility('expanded')
  }

  const sidebarPanel = (
    <aside
      key="sidebar"
      id={sidebarId}
      ref={sidebarRef}
      className="gx-app-shell-sidebar gx-glass"
      data-slot="app-shell-sidebar"
      data-side={side}
      data-visibility={visibility}
      aria-label={sidebarLabel}
      hidden={visibility === 'hidden'}
      inert={visibility === 'hidden'}
      tabIndex={-1}
      onFocusCapture={() => {
        sidebarHadFocus.current = true
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && !event.currentTarget.contains(next)) sidebarHadFocus.current = false
      }}
    >
      <div className="gx-app-shell-sidebar-header">
        <Menu>
          <MenuTrigger
            ref={menuTriggerRef}
            render={<IconButton label={sidebarLabel} icon={<PanelLeft aria-hidden="true" />} size="sm" />}
          />
          <MenuContent>
            {side === 'left' ? (
              <MenuItem onClick={() => onSide('right')}>{labels.moveRight}</MenuItem>
            ) : (
              <MenuItem onClick={() => onSide('left')}>{labels.moveLeft}</MenuItem>
            )}
            {visibility === 'expanded' ? (
              <MenuItem onClick={() => onVisibility('rail')}>{labels.collapse}</MenuItem>
            ) : (
              <MenuItem onClick={() => onVisibility('expanded')}>{labels.expand}</MenuItem>
            )}
            <MenuItem onClick={hide}>{labels.hide}</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="gx-app-shell-sidebar-body">{sidebar}</div>
    </aside>
  )

  const mainPanel = (
    <main key="main" className="gx-app-shell-main" data-slot="app-shell-main">
      {children}
    </main>
  )

  return (
    <div
      className="gx-app-shell-chrome"
      data-slot="app-shell-chrome"
      data-side={side}
      data-visibility={visibility}
    >
      <div className="gx-app-shell-frame">
        <div className="gx-app-shell-status gx-glass" data-slot="app-shell-status">
          <div className="gx-app-shell-status-content">{status}</div>
          <div className="gx-app-shell-status-actions">
            {visibility === 'hidden' ? (
              <Button ref={showRef} variant="secondary" size="sm" aria-controls={sidebarId} onClick={show}>
                {labels.show}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onOpenPalette}>
              {labels.palette}
            </Button>
          </div>
        </div>
        <div className="gx-app-shell-body" data-slot="app-shell-body">
          {side === 'left' ? [sidebarPanel, mainPanel] : [mainPanel, sidebarPanel]}
        </div>
      </div>
    </div>
  )
}
