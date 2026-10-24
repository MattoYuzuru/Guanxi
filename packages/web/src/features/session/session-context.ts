import { useSyncExternalStore } from 'react'
import type { ContextState, Usage } from '@guanxi/contract'

/**
 * The open session's context readout, published by the session view so the workspace's Context
 * block shows the same panel (round 4). Presentation only; the session view stays its owner.
 */
export interface SessionContextReadout {
  context: ContextState | null
  usage: Usage | null
  compacting: boolean
  onCompact: () => Promise<unknown>
  disabled: boolean
}
let current: SessionContextReadout | null = null
let owner: symbol | undefined
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

export function publishSessionContext(writer: symbol, readout: SessionContextReadout): void {
  owner = writer
  current = readout
  notify()
}
export function clearSessionContext(writer: symbol): void {
  if (owner !== writer) return
  owner = undefined
  current = null
  notify()
}
export function useSessionContext(): SessionContextReadout | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current, () => null)
}
