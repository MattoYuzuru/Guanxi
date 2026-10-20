/**
 * Built-in web plugin (K1 spike): a sidebar shortcut to the Projects list.
 * Edit this file under `npm run dev` and the entry updates in place: the
 * kernel runtime accepts this module's hot update and reloads the plugin.
 */
import { contribute, definePlugin } from '@guanxi/kernel'
import { paths } from '../../lib/router.tsx'
import { SIDEBAR_SLOT, type SidebarEntry } from '../slots.ts'

const revision = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const plugin = definePlugin({
  manifest: {
    id: 'guanxi.web-projects-shortcut',
    engines: { guanxi: '^0.1.0' },
    contributes: { slots: [SIDEBAR_SLOT] },
    trust: 'T0',
  },
  apply(ctx) {
    contribute<SidebarEntry>(ctx, SIDEBAR_SLOT, {
      id: 'projects',
      value: { labelKey: 'kernel.sidebar.projects', href: paths.projects(), revision },
    })
  },
})
