import type { ExperienceMode } from '@guanxi/contract'

export interface WorkspaceShellState {
  ready: boolean
  busy: boolean
  phone: boolean
  mode: ExperienceMode | null
  blocks: readonly { id: string; label: string; hidden: boolean }[]
}
const empty: WorkspaceShellState = Object.freeze({ ready: false, busy: false, phone: false, mode: null, blocks: Object.freeze([]) })
let state = empty, owner: symbol | undefined
const listeners = new Set<() => void>()
/** Presentation state only. Consumers use the validated command entry points, never the engine. */
export const workspaceShellState = {
  snapshot: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
}
export function publishWorkspaceShellState(writer: symbol, next: WorkspaceShellState): void {
  owner = writer
  if (JSON.stringify(state) === JSON.stringify(next)) return
  state = Object.freeze({ ...next, blocks: Object.freeze(next.blocks.map(block => Object.freeze({ ...block }))) })
  for (const listener of listeners) listener()
}
export function clearWorkspaceShellState(writer: symbol): void {
  if (owner !== writer) return
  owner = undefined; state = empty
  for (const listener of listeners) listener()
}
