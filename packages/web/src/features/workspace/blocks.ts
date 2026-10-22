import { contribute, definePlugin, WORKSPACE_BLOCK_SLOT, type BlockContribution } from '@guanxi/kernel'

export const blockNames = ['chat', 'context', 'changes', 'plan', 'processes', 'environment', 'files', 'terminal', 'artifacts', 'browser', 'subagents'] as const
export type BuiltInBlock = typeof blockNames[number]
export const builtInBlocks: readonly BlockContribution[] = blockNames.map(name => ({
  id: `guanxi.core/${name}`,
  title: `workspaceLayout.block.${name}`,
  icon: name === 'terminal' ? 'Terminal' : name === 'browser' ? 'Globe' : 'PanelTop',
  modes: ['developer', 'visual'],
  defaultZone: name === 'chat' || name === 'changes' || name === 'artifacts' || name === 'browser' ? 'center' : name === 'terminal' ? 'bottom' : 'right',
  multiInstance: name === 'terminal' || name === 'browser',
  keepAlive: name === 'terminal' || name === 'browser' || name === 'chat',
  pane: { component: `core.${name}` },
}))
export const workspaceBlocksPlugin = definePlugin({
  manifest: { id: 'guanxi.core', engines: { guanxi: '^0.1.0' }, trust: 'T0', contributes: { slots: [WORKSPACE_BLOCK_SLOT] } },
  apply(ctx) {
    builtInBlocks.forEach((block, order) => contribute(ctx, WORKSPACE_BLOCK_SLOT, { id: block.id.split('/')[1]!, order, value: block }))
  },
})
