import { contribute, definePlugin, WORKSPACE_BLOCK_SLOT } from '@guanxi/kernel'
import { replaceWebPlugin } from '../../../src/kernel/runtime.ts'
import { registerBlockPane } from '../../../src/features/workspace/renderers.ts'

export async function load(): Promise<void> {
  await replaceWebPlugin(definePlugin({
    manifest: { id: 'test.workspace', engines: { guanxi: '^0.1.0' }, trust: 'T1', contributes: { slots: [WORKSPACE_BLOCK_SLOT] } },
    apply(ctx) {
      registerBlockPane(ctx, 'test.workspace/pane', () => <p>Plugin pane fixture</p>)
      contribute(ctx, WORKSPACE_BLOCK_SLOT, { id: 'pane', value: {
        id: 'test.workspace/pane', title: 'workspace.block.plan', icon: 'PanelTop', modes: ['developer', 'visual'],
        defaultZone: 'right', multiInstance: false, keepAlive: false, pane: { component: 'test.workspace/pane' },
      } })
    },
  }))
}
