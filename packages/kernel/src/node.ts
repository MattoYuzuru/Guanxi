/**
 * `@guanxi/kernel/node` — Node-only kernel parts: the Cordis loader, profile
 * boot and reconciliation, and process resource counters.
 *
 * Plugins are registered as loader builtins (`cordis:<plugin id>`), so a profile
 * can only load plugins the node already knows; it never imports a module path.
 * Source hot reload through `@cordisjs/plugin-hmr` is not used: it needs Node
 * internals (`--expose-internals` or a native addon). Code replacement goes
 * through `replacePlugin` with a fresh module import instead (see README).
 */
import { readFile } from 'node:fs/promises'
import { Loader } from './loader-runtime.js'
import type { Fiber } from './cordis.ts'
import type { LoaderEntryOptions } from './loader-runtime.js'
import { FIBER_STATE } from './cordis.ts'
import { createKernel, unloadFiber, type Kernel, type KernelOptions } from './kernel.ts'
import { isGuanxiPlugin, type GuanxiPlugin } from './plugin.ts'
import { ProfileError, resolveProfile, type ProfileLayer, type ResolvedEntry } from './profile.ts'

export { Loader }

export interface BootOptions extends KernelOptions {
  /** Plugins this node can load, by manifest id. */
  readonly plugins: readonly GuanxiPlugin<any>[]
  readonly profile: readonly ProfileLayer[]
  /**
   * Safe mode (ADR-0015): every non-T0 row is disabled, and so is every row
   * that then misses a required service or slot, so a safe boot never fails
   * on what it disabled.
   */
  readonly safeMode?: boolean
  /**
   * Rows whose services were handed to code outside the kernel (the legacy
   * server context keeps the instances it got at boot). `apply` and
   * `replacePlugin` refuse to change them until those consumers are plugins.
   */
  readonly pinned?: readonly string[]
}

export interface NodeKernel extends Kernel {
  readonly loader: Loader
  /** The resolved rows currently applied. */
  entries(): readonly ResolvedEntry[]
  /** The fiber of a row, if it is loaded. */
  fiberOf(rowId: string): Fiber | undefined
  /** Reconcile to a new profile: only added, removed or changed rows reload. */
  apply(profile: readonly ProfileLayer[]): Promise<void>
  /** Swap the code of a known plugin and reload every row that uses it. */
  replacePlugin(plugin: GuanxiPlugin<any>): Promise<void>
}

export class NodeLoadError extends Error {
  /** `<row id>: <state>` for every enabled row that is not serving. */
  readonly rows: readonly string[]

  constructor(rows: readonly string[]) {
    super(`profile rows failed to load: ${rows.join('; ')}`)
    this.name = 'NodeLoadError'
    this.rows = rows
  }
}

const BUILTIN_PREFIX = 'cordis:'
/** Services the kernel itself provides; rows may require them without a provider row. */
const KERNEL_SERVICES = new Set(['slots', 'loader'])

export async function bootNode(options: BootOptions): Promise<NodeKernel> {
  const known = new Map<string, GuanxiPlugin<any>>()
  for (const plugin of options.plugins) {
    if (!isGuanxiPlugin(plugin)) throw new TypeError('bootNode() accepts only plugins built by definePlugin()')
    if (known.has(plugin.manifest.id)) {
      throw new ProfileError('plugins', `plugin "${plugin.manifest.id}" is registered twice`)
    }
    known.set(plugin.manifest.id, plugin)
  }
  const pinned = new Set(options.pinned ?? [])

  const kernel = createKernel(options)
  await kernel.root.plugin(Loader)
  const loader = kernel.root.get('loader') as Loader
  const internals = loader
  for (const [id, plugin] of known) internals.builtins[id] = plugin

  let applied: ResolvedEntry[] = []
  let queue: Promise<unknown> = Promise.resolve()
  /** One profile change at a time: the loader's reconcile is not re-entrant. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  const toOptions = (entry: ResolvedEntry): LoaderEntryOptions => ({
    id: entry.id,
    name: BUILTIN_PREFIX + entry.plugin,
    config: entry.config,
    disabled: entry.disabled,
  })

  const resolve = (profile: readonly ProfileLayer[]): ResolvedEntry[] =>
    closeGraph(
      resolveProfile(profile).map((entry) => {
        const plugin = known.get(entry.plugin)
        if (!plugin) throw new ProfileError(entry.layers.at(-1) ?? 'profile', `row "${entry.id}" names unknown plugin "${entry.plugin}"`)
        if (options.safeMode && plugin.manifest.trust !== 'T0' && !entry.disabled) {
          return Object.freeze({ ...entry, disabled: true })
        }
        return entry
      }),
      known,
      Boolean(options.safeMode),
    )

  /** Remove a loader row and wait until its plugin has fully unloaded. */
  const removeRow = async (id: string) => {
    const fiber = internals.store[id]?.fiber
    const unloading = fiber ? unloadFiber(fiber) : Promise.resolve()
    internals.remove(id)
    await unloading
  }

  /** The loader logs and swallows load failures; surface them to the caller. */
  const assertServing = () => {
    const failed: string[] = []
    for (const entry of applied) {
      if (entry.disabled) continue
      const fiber = internals.store[entry.id]?.fiber
      if (!fiber?.uid) failed.push(`${entry.id}: not loaded`)
      else if (fiber.state === FIBER_STATE.failed) failed.push(`${entry.id}: failed`)
    }
    if (failed.length) throw new NodeLoadError(failed)
  }

  const settle = (action: string) => kernel.withinDisposeBound(action, internals.await())

  const assertPinned = (next: readonly ResolvedEntry[]) => {
    const before = new Map(applied.map((entry) => [entry.id, entry]))
    const after = new Map(next.map((entry) => [entry.id, entry]))
    for (const id of pinned) {
      const left = before.get(id)
      const right = after.get(id)
      if (!left) continue
      if (
        !right ||
        left.plugin !== right.plugin ||
        left.disabled !== right.disabled ||
        JSON.stringify(left.config) !== JSON.stringify(right.config)
      ) {
        throw new ProfileError('profile', `row "${id}" is pinned: its services are held outside the kernel`)
      }
    }
  }

  const apply = (profile: readonly ProfileLayer[]) =>
    serial(async () => {
      const next = resolve(profile)
      if (applied.length) assertPinned(next)
      const previous = new Map(applied.map((entry) => [entry.id, entry]))
      // The pinned loader keeps a live entry bound to its first plugin name
      // (upstream cordiverse/cordis#218 is open), so a row that switches plugin
      // is removed, and fully unloaded, before the reconcile re-creates it.
      for (const entry of next) {
        const before = previous.get(entry.id)
        if (before && before.plugin !== entry.plugin && internals.store[entry.id]) await removeRow(entry.id)
      }
      applied = next
      await internals.root.update(next.map(toOptions))
      await settle('applying the profile')
      assertServing()
    })

  try {
    await apply(options.profile)
  } catch (error) {
    await kernel.dispose().catch(() => undefined)
    throw error
  }

  return {
    ...kernel,
    loader,
    entries: () => applied,
    fiberOf: (rowId) => {
      const fiber = internals.store[rowId]?.fiber
      return fiber?.uid ? fiber : undefined
    },
    apply,
    replacePlugin: (plugin) =>
      serial(async () => {
        if (!isGuanxiPlugin(plugin)) throw new TypeError('replacePlugin() accepts only plugins built by definePlugin()')
        const id = plugin.manifest.id
        const current = known.get(id)
        if (!current) throw new ProfileError('replacePlugin', `plugin "${id}" is not known to this node`)
        for (const entry of applied) {
          if (entry.plugin === id && pinned.has(entry.id)) {
            throw new ProfileError('replacePlugin', `row "${entry.id}" is pinned: its services are held outside the kernel`)
          }
        }
        if (
          JSON.stringify({ ...current.manifest }) !== JSON.stringify({ ...plugin.manifest })
        ) {
          throw new ProfileError('replacePlugin', `plugin "${id}" changed its manifest; apply a profile instead`)
        }
        known.set(id, plugin)
        internals.builtins[id] = plugin
        for (const entry of applied) {
          if (entry.plugin !== id || !internals.store[entry.id]) continue
          await removeRow(entry.id)
          await internals.create(toOptions(entry))
        }
        await settle(`replacing ${id}`)
        assertServing()
      }),
  }
}

/**
 * Check what every enabled row needs: each required service has a provider
 * row and each contributed slot a declaring row. A requirement served only by
 * a disabled row is allowed (the row waits for it), except in safe mode, where
 * such rows are disabled too, until the graph is closed.
 */
function closeGraph(
  entries: readonly ResolvedEntry[],
  known: ReadonlyMap<string, GuanxiPlugin<any>>,
  safeMode: boolean,
): ResolvedEntry[] {
  let rows = [...entries]
  const manifest = (entry: ResolvedEntry) => known.get(entry.plugin)!.manifest
  for (;;) {
    const all = rows.map(manifest)
    const enabled = rows.filter((entry) => !entry.disabled).map(manifest)
    const providedAnywhere = new Set(all.flatMap((m) => m.provides))
    const declaredAnywhere = new Set(all.flatMap((m) => m.contributes.slotDeclarations))
    const providedEnabled = new Set(enabled.flatMap((m) => m.provides))
    const declaredEnabled = new Set(enabled.flatMap((m) => m.contributes.slotDeclarations))
    let changed = false
    rows = rows.map((entry) => {
      if (entry.disabled) return entry
      const m = manifest(entry)
      const missingService = m.requires.find((name) => !KERNEL_SERVICES.has(name) && !providedEnabled.has(name))
      const missingSlot = m.contributes.slots.find((slot) => !declaredEnabled.has(slot))
      if (missingService === undefined && missingSlot === undefined) return entry
      if (safeMode) {
        changed = true
        return Object.freeze({ ...entry, disabled: true })
      }
      if (missingSlot !== undefined && !declaredAnywhere.has(missingSlot)) {
        throw new ProfileError('profile', `plugin "${m.id}" contributes to undeclared slot "${missingSlot}"`)
      }
      if (missingService !== undefined && !providedAnywhere.has(missingService)) {
        throw new ProfileError('profile', `plugin "${m.id}" requires "${missingService}", which no row provides`)
      }
      return entry
    })
    if (!changed) return rows
  }
}

/** Read a JSON profile layer from disk (`{ name?, insert?, patch? }`). */
export async function readProfileLayer(path: string): Promise<ProfileLayer> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProfileError(path, 'a profile layer must be a JSON object')
  }
  const layer = parsed as Record<string, unknown>
  for (const key of Object.keys(layer)) {
    if (!['name', 'insert', 'patch'].includes(key)) throw new ProfileError(path, `unknown field "${key}"`)
  }
  return {
    name: typeof layer['name'] === 'string' ? layer['name'] : path,
    insert: (layer['insert'] as ProfileLayer['insert']) ?? [],
    patch: (layer['patch'] as ProfileLayer['patch']) ?? [],
  }
}

export interface ProcessResources {
  /** Active `setTimeout`/`setInterval` handles. */
  readonly timers: number
  /** All active libuv resources (timers, sockets, file requests, ...). */
  readonly handles: number
  readonly byType: Readonly<Record<string, number>>
}

/** Process-wide resource census from `process.getActiveResourcesInfo()`. */
export function processResources(): ProcessResources {
  const byType: Record<string, number> = {}
  for (const type of process.getActiveResourcesInfo()) byType[type] = (byType[type] ?? 0) + 1
  return {
    timers: byType['Timeout'] ?? 0,
    handles: Object.values(byType).reduce((sum, count) => sum + count, 0),
    byType,
  }
}
