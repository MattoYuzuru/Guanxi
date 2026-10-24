import { useCallback, useSyncExternalStore } from 'react'
import type { IconName } from '@guanxi/ui'
import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'

/**
 * Session side panels (round 4, owner feedback 2026-10-23): the session opens as one full-width
 * timeline; panels open beside it from the header's panels menu. The names match the workspace's
 * built-in blocks, so the same panel is the same block in the free arrangement.
 */
export const sessionPanelNames = ['context', 'plan', 'artifacts', 'browser', 'subagents', 'terminal', 'processes', 'environment', 'changes', 'files'] as const
export type SessionPanel = typeof sessionPanelNames[number]

export const sessionPanelIcon: Record<SessionPanel, IconName> = {
  context: 'context', plan: 'plan', artifacts: 'artifacts', browser: 'globe', subagents: 'agent',
  terminal: 'terminal', processes: 'processes', environment: 'environment', changes: 'changes', files: 'folder',
}

export function isSessionPanel(value: unknown): value is SessionPanel {
  return typeof value === 'string' && (sessionPanelNames as readonly string[]).includes(value)
}

/** The workspace block of a panel, and back (machine identifiers, never shown). */
const CORE_BLOCK_PREFIX = 'guanxi.core/'
export const panelBlockId = (panel: SessionPanel) => CORE_BLOCK_PREFIX + panel
export function blockPanel(id: string): SessionPanel | null {
  const name = id.startsWith(CORE_BLOCK_PREFIX) ? id.slice(CORE_BLOCK_PREFIX.length) : null
  return isSessionPanel(name) ? name : null
}

export interface SessionPanelState { open: SessionPanel[]; active: SessionPanel | null }

/** Which panels are open is a per-browser view preference, never session data. */
export const SESSION_PANELS_KEY = `${PRODUCT_FILE_PREFIX}.session-panels`
const CHANGE_EVENT = `${PRODUCT_FILE_PREFIX}:session-panels`
const closed: SessionPanelState = Object.freeze({ open: [], active: null }) as SessionPanelState
let pageState: SessionPanelState = closed
/** Set when a write failed: reads then follow this page's state instead of a stale stored value. */
let storageFailed = false
let cachedRaw: string | null | undefined
let cached: SessionPanelState = closed

function parse(raw: string | null): SessionPanelState {
  if (!raw) return closed
  try {
    const value = JSON.parse(raw) as { open?: unknown; active?: unknown }
    const open = Array.isArray(value.open) ? [...new Set(value.open.filter(isSessionPanel))] : []
    const active = isSessionPanel(value.active) && open.includes(value.active) ? value.active : open[0] ?? null
    return { open, active }
  } catch { return closed }
}

export function readSessionPanels(): SessionPanelState {
  if (storageFailed) return pageState
  let raw: string | null
  try { raw = localStorage.getItem(SESSION_PANELS_KEY) } catch { return pageState }
  if (raw !== cachedRaw) { cachedRaw = raw; cached = parse(raw) }
  return cached
}

function write(next: SessionPanelState) {
  pageState = next
  try {
    if (next.open.length) localStorage.setItem(SESSION_PANELS_KEY, JSON.stringify(next))
    else localStorage.removeItem(SESSION_PANELS_KEY)
  } catch {
    // Storage is unavailable or full: the panels last for this page only.
    storageFailed = true
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === SESSION_PANELS_KEY) listener() }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGE_EVENT, listener) }
}

export interface SessionPanels extends SessionPanelState {
  /** Opens (and shows) or closes one panel. */
  toggle: (panel: SessionPanel, open: boolean) => void
  /** Shows an open panel. */
  show: (panel: SessionPanel) => void
}

export function useSessionPanels(): SessionPanels {
  const state = useSyncExternalStore(subscribe, readSessionPanels, () => closed)
  const toggle = useCallback((panel: SessionPanel, open: boolean) => {
    const current = readSessionPanels()
    const without = current.open.filter(name => name !== panel)
    if (open) write({ open: sessionPanelNames.filter(name => name === panel || without.includes(name)), active: panel })
    else write({ open: without, active: current.active === panel ? without[0] ?? null : current.active })
  }, [])
  const show = useCallback((panel: SessionPanel) => {
    const current = readSessionPanels()
    if (current.open.includes(panel)) write({ ...current, active: panel })
  }, [])
  return { ...state, toggle, show }
}
