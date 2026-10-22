import { effect, type PluginContext } from '@guanxi/kernel'
import type { ComponentType } from 'react'
import type { LayoutDocument } from '@guanxi/contract'

export interface BlockPaneProps { instanceId: string; params: LayoutDocument['blocks'][string]['params'] }
const renderers = new Map<string, ComponentType<BlockPaneProps>>()
const listeners = new Set<() => void>()
let revision = 0
function publish() { revision++; listeners.forEach(listener => listener()) }
export const paneRegistry = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  snapshot: () => revision,
  get: (key: string) => renderers.get(key),
}
/** T0/T1 renderer registration is reverted by the plugin's kernel activation. */
export function registerBlockPane(ctx: PluginContext, component: string, renderer: ComponentType<BlockPaneProps>): void {
  if (!component.startsWith(`${ctx.manifest.id}/`)) throw new Error('Block renderer must use its plugin namespace')
  effect(ctx, () => {
    if (renderers.has(component)) throw new Error('Block renderer already registered')
    renderers.set(component, renderer); publish()
    return () => { if (renderers.get(component) === renderer) { renderers.delete(component); publish() } }
  }, `workspace-pane:${component}`)
}
