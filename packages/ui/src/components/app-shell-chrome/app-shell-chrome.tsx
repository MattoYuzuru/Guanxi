/*
 * Guanxi shell pattern. The host owns the navigation, status items and workspace content;
 * this component owns their fixed positions, the controlled side/visibility geometry and the
 * focus hand-off. No viewport JavaScript: the narrow flow follows the existing 639 px
 * workspace breakpoint, measured on the shell itself, so a phone viewport and a narrow host frame
 * use the same rule and controlled state survives resizing. On a narrow shell the navigation is a
 * drawer over an inert page and the status actions sit behind one overflow control.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icon/icon.tsx'
import { IconButton } from '../icon-button/icon-button.tsx'
import { Kbd } from '../kbd/kbd.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../menu/menu.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../popover/popover.tsx'
import { VisibleLabels } from '../../lib/visible-labels.tsx'
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
  /** Narrow shell: opens the navigation drawer. Defaults to `sidebarLabel`. */
  navigation?: string
  /** Narrow shell: the one overflow control that holds the status items and chrome controls. */
  more?: string
}

/** The shell's narrow breakpoint: the existing workspace phone breakpoint (639 px). */
export const APP_SHELL_NARROW_MAX = 639

export interface AppShellChromeProps {
  /** Controlled side. It changes both the visual column order and the DOM/focus order. */
  side: AppShellSide
  /** Controlled visibility. The sidebar stays mounted when it is hidden. */
  visibility: AppShellVisibility
  /**
   * Host navigation. It should adapt itself to the rail; the chrome does not invent rail content.
   * A function receives the effective layout: a narrow shell's drawer is never a rail.
   */
  sidebar: ReactNode | ((layout: { rail: boolean }) => ReactNode)
  /** Persistent status items, shown at the left of the strip after the Show button. */
  status: ReactNode
  /** Icon status items and chrome controls at the right of the strip, before the palette button. */
  actions?: ReactNode
  /** Keys of the palette shortcut as the platform writes them (for example `['⌘', 'K']`). */
  paletteShortcut?: string[]
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
  actions,
  paletteShortcut,
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
  const rootRef = useRef<HTMLDivElement>(null)
  const drawerToggleRef = useRef<HTMLButtonElement>(null)
  // Measured on the shell, not the viewport; an unmeasured (zero-width) shell stays wide.
  const [narrow, setNarrow] = useState(false)
  const [drawer, setDrawer] = useState(false)
  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const measure = (width: number) => { if (width > 0) setNarrow(width <= APP_SHELL_NARROW_MAX) }
    measure(node.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => measure(entries[0]?.contentRect.width ?? 0))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { if (!narrow) setDrawer(false) }, [narrow])
  const openDrawer = () => setDrawer(true)
  const closeDrawer = () => setDrawer(false)
  const drawerWasOpen = useRef(false)
  // Opening moves focus into the drawer; closing returns it to the toggle once the page is no
  // longer inert (the same commit, before paint).
  useLayoutEffect(() => {
    if (drawer) sidebarRef.current?.focus()
    else if (drawerWasOpen.current) drawerToggleRef.current?.focus()
    drawerWasOpen.current = drawer
  }, [drawer])
  const sidebarHidden = narrow ? !drawer : visibility === 'hidden'
  const rail = !narrow && visibility === 'rail'

  useLayoutEffect(() => {
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
      // The menu now lives in the strip; showing the sidebar moves focus into the sidebar itself.
      sidebarRef.current?.focus()
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
      className="gx-app-shell-sidebar"
      data-slot="app-shell-sidebar"
      data-side={side}
      data-visibility={narrow ? 'expanded' : visibility}
      data-drawer={narrow ? (drawer ? 'open' : 'closed') : undefined}
      aria-label={sidebarLabel}
      hidden={sidebarHidden}
      inert={sidebarHidden}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (drawer && event.key === 'Escape') { event.stopPropagation(); closeDrawer() }
      }}
      onClickCapture={(event) => {
        // Following a link in the drawer closes it, so the destination is what the user sees.
        if (drawer && event.target instanceof Element && event.target.closest('a[href]')) closeDrawer()
      }}
      onFocusCapture={() => {
        sidebarHadFocus.current = true
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && !event.currentTarget.contains(next)) sidebarHadFocus.current = false
      }}
    >
      <div className="gx-app-shell-sidebar-body">{typeof sidebar === 'function' ? sidebar({ rail }) : sidebar}</div>
    </aside>
  )

  // The sidebar menu sits in the status strip on the sidebar's side, so the strip is one row of
  // chrome and the sidebar starts with navigation.
  const sidebarMenu = narrow ? (
    <div className="gx-app-shell-sidebar-menu" data-slot="app-shell-sidebar-header">
      <IconButton ref={drawerToggleRef} label={labels.navigation ?? sidebarLabel} aria-controls={sidebarId}
        aria-expanded={drawer} onClick={() => (drawer ? closeDrawer() : openDrawer())} icon={<Icon name="sidebar" />} />
    </div>
  ) : visibility === 'hidden' ? null : (
    <div className="gx-app-shell-sidebar-menu" data-slot="app-shell-sidebar-header">
      <Menu>
        <MenuTrigger
          ref={menuTriggerRef}
          render={<IconButton label={sidebarLabel} icon={<Icon name={side === 'left' ? 'sidebar' : 'sidebar-right'} />} />}
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
  )

  const mainPanel = (
    <main key="main" className="gx-app-shell-main" data-slot="app-shell-main" inert={drawer || undefined}>
      {children}
    </main>
  )

  return (
    <div
      ref={rootRef}
      className="gx-app-shell-chrome"
      data-slot="app-shell-chrome"
      data-side={side}
      data-visibility={visibility}
      data-narrow={narrow || undefined}
    >
      <div className="gx-app-shell-frame">
        <div className="gx-app-shell-status" data-slot="app-shell-status" inert={drawer || undefined}>
          {side === 'left' || narrow ? sidebarMenu : null}
          {visibility === 'hidden' && !narrow ? (
            <IconButton
              ref={showRef}
              label={labels.show}
              aria-controls={sidebarId}
              onClick={show}
              icon={<Icon name={side === 'left' ? 'sidebar' : 'sidebar-right'} />}
            />
          ) : null}
          <div className="gx-app-shell-status-content">{status}</div>
          <div className="gx-app-shell-status-actions">
            {narrow && actions ? (
              <Popover>
                <PopoverTrigger render={<IconButton label={labels.more ?? labels.palette} icon={<Icon name="more" />} />} />
                <PopoverContent keepMounted align="end" className="gx-app-shell-overflow" data-slot="app-shell-overflow" aria-label={labels.more ?? labels.palette}>
                  {/* No hover on a touch screen: each item shows its label as text (P3). */}
                  <VisibleLabels>{actions}</VisibleLabels>
                </PopoverContent>
              </Popover>
            ) : actions}
            <button
              type="button"
              className="gx-app-shell-palette gx-focusable"
              data-slot="app-shell-palette"
              aria-label={labels.palette}
              aria-keyshortcuts={paletteShortcut ? 'Meta+K Control+K' : undefined}
              title={labels.palette}
              onClick={onOpenPalette}
            >
              <Icon name="search" size={14} />
              {paletteShortcut && paletteShortcut.length > 0 && !narrow ? <Kbd keys={paletteShortcut} aria-hidden="true" /> : null}
            </button>
            {side === 'right' && !narrow ? sidebarMenu : null}
          </div>
        </div>
        <div className="gx-app-shell-body" data-slot="app-shell-body">
          {side === 'left' ? [sidebarPanel, mainPanel] : [mainPanel, sidebarPanel]}
        </div>
        {drawer ? <div className="gx-app-shell-scrim" data-slot="app-shell-scrim" aria-hidden="true" onClick={closeDrawer} /> : null}
      </div>
    </div>
  )
}
