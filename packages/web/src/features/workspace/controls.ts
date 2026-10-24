import { createContext, useContext } from 'react'
import type { LayoutDocument } from '@guanxi/contract'

/**
 * The workspace's layout actions, offered to the session header's one panels menu (round 4,
 * owner feedback 2026-10-23) instead of a row of toolbar buttons. Kept apart from Workspace.tsx so
 * the session view can read it without loading the docking engine.
 */
export interface WorkspaceLayoutControls {
  /** A save or switch is in flight: actions are disabled, toggles still read. */
  busy: boolean
  phone: boolean
  /** Every block except the session itself, with its visibility. */
  blocks: readonly { id: string; label: string; hidden: boolean }[]
  /** Contributions that can add another block (plugins, multi-instance blocks). */
  addable: readonly { id: string; label: string }[]
  setVisible: (id: string, visible: boolean) => void
  add: (contributionId: string) => void
  density: LayoutDocument['density']
  setDensity: (density: LayoutDocument['density']) => void
  scope: string
  scopes: readonly { id: string; label: string }[]
  setScope: (scope: string) => void
  layout: string
  layouts: readonly { id: string; label: string }[]
  activate: (id: string) => void
  name: string
  save: () => void
  saveAs: (name: string) => void
  /** Saves the active layout in place under a new name (its id and scope stay). */
  rename: (name: string) => void
  reset: () => void
  /** Opens the keyboard-operable move dialog; unavailable on a phone. */
  move: () => void
  /**
   * A session header that shows this menu registers itself; while none does (a hidden session
   * block, a loading or failed chat), the workspace shows the menu in its own bar instead.
   */
  registerMenu?: () => () => void
}

export const WorkspaceControlsContext = createContext<WorkspaceLayoutControls | null>(null)

export function useWorkspaceControls(): WorkspaceLayoutControls | null {
  return useContext(WorkspaceControlsContext)
}
