/**
 * The browser's kernel (K1 spike): one kernel per page, a shell plugin that
 * owns the sidebar slot, and the built-in web plugins.
 *
 * Hot updates: this module accepts updates of each built-in plugin module and
 * swaps the plugin (unload the old version, load the new one), so its slot
 * entries change in place without a page reload.
 */
import {
  createKernel,
  declareSlot,
  definePlugin,
  type GuanxiPlugin,
  type PluginHandle,
} from '@guanxi/kernel'
import { plugin as projectsShortcut } from './plugins/projects-shortcut.ts'
import { SIDEBAR_SLOT } from './slots.ts'

const shell = definePlugin({
  manifest: {
    id: 'guanxi.web-shell',
    engines: { guanxi: '^0.1.0' },
    contributes: { slotDeclarations: [SIDEBAR_SLOT] },
    trust: 'T0',
  },
  apply(ctx) {
    declareSlot(ctx, SIDEBAR_SLOT)
  },
})

export const webKernel = createKernel()

const loaded = new Map<string, Promise<PluginHandle | null>>()
let queue: Promise<unknown> = Promise.resolve()

/** Serialise kernel changes so a hot update never races the initial load. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

function load(plugin: GuanxiPlugin<any>): Promise<PluginHandle | null> {
  const handle = webKernel.plugin(plugin).catch((error: unknown) => {
    console.error(`[guanxi:kernel] ${plugin.manifest.id} failed to load`, error)
    return null
  })
  loaded.set(plugin.manifest.id, handle)
  return handle
}

/** Unload a plugin by id; its slot entries disappear. The shell owns the slot and stays. */
export function unloadWebPlugin(id: string): Promise<void> {
  if (id === shell.manifest.id) return Promise.reject(new Error('the web shell owns the sidebar slot and cannot be unloaded'))
  return serial(async () => {
    const handle = await loaded.get(id)
    loaded.delete(id)
    await handle?.dispose()
  })
}

/** Load a plugin, replacing a loaded plugin with the same id. */
export function replaceWebPlugin(plugin: GuanxiPlugin<any>): Promise<void> {
  return serial(async () => {
    // Hold the slots so the swap never renders an empty frame: the entry keeps
    // its DOM node, and keyboard focus stays on it.
    const release = webKernel.slots.hold()
    try {
      const previous = await loaded.get(plugin.manifest.id)
      await previous?.dispose()
      await load(plugin)
    } finally {
      release()
    }
  })
}

const builtIns: Record<string, GuanxiPlugin<any>> = { [projectsShortcut.manifest.id]: projectsShortcut }

export const webKernelReady: Promise<void> = serial(async () => {
  await load(shell)
  for (const plugin of Object.values(builtIns)) await load(plugin)
})

if (import.meta.hot) {
  import.meta.hot.accept('./plugins/projects-shortcut.ts', (next) => {
    const plugin = next?.['plugin'] as GuanxiPlugin<any> | undefined
    if (!plugin) return
    builtIns[plugin.manifest.id] = plugin
    void replaceWebPlugin(plugin)
  })
  // Editing this module itself creates a new kernel; unload the old one. The
  // list then disappears and reappears once (dev only): hold() cannot span
  // two kernels.
  import.meta.hot.dispose(() => {
    void webKernel.dispose()
  })
}

if (import.meta.env.DEV) {
  // Development-only handle for the inspector-to-be and the browser gate.
  Object.assign(globalThis, {
    __GUANXI_KERNEL__: {
      ready: webKernelReady,
      counters: () => webKernel.counters(),
      unload: unloadWebPlugin,
      reload: (id: string) => {
        const plugin = builtIns[id]
        if (!plugin) return Promise.reject(new Error(`unknown built-in plugin ${id}`))
        return replaceWebPlugin(plugin)
      },
    },
  })
}
