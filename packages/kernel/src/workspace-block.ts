/** Opaque renderer identity, resolved by the host; never evaluated from layout JSON. */
export type ComponentRef = { component: string }
export const WORKSPACE_BLOCK_SLOT = 'workspace.block'
export interface BlockContribution {
  readonly id: string
  readonly title: string
  readonly icon: string
  readonly modes: readonly ('developer' | 'visual')[]
  readonly defaultZone: 'left' | 'right' | 'top' | 'bottom' | 'center'
  readonly multiInstance: boolean
  readonly keepAlive: boolean
  readonly minSize?: { w: number; h: number }
  readonly card?: ComponentRef
  readonly pane: ComponentRef | { mcpApp: string }
}
