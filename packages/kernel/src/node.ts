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
import { createKernel, type Kernel, type KernelOptions } from './kernel.ts'
import { type GuanxiPlugin } from './plugin.ts'
import { ProfileError, resolveProfile, type ProfileLayer, type ResolvedEntry } from './profile.ts'

export { Loader }

export interface BootOptions extends KernelOptions {
  /** Plugins this node can load, by manifest id. */
  readonly plugins: readonly GuanxiPlugin<any>[]
  readonly profile: readonly ProfileLayer[]
  /** Safe mode: every T1 (and T2) row is disabled; T0 core still loads (ADR-0015). */
  readonly safeMode?: boolean
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


const BUILTIN_PREFIX = 'cordis:'

export async function bootNode(options: BootOptions): Promise<NodeKernel> {
  const kernel = createKernel(options)
  const known = new Map<string, GuanxiPlugin<any>>()
  for (const plugin of options.plugins) {
    if (known.has(plugin.manifest.id)) {
      throw new ProfileError('plugins', `plugin "${plugin.manifest.id}" is registered twice`)
    }
    known.set(plugin.manifest.id, plugin)
  }

  await kernel.root.plugin(Loader)
  const loader = kernel.root.get('loader') as Loader
  const internals = loader
  for (const [id, plugin] of known) internals.builtins[id] = plugin

  let applied: ResolvedEntry[] = []

  const toOptions = (entry: ResolvedEntry): LoaderEntryOptions => ({
    id: entry.id,
    name: BUILTIN_PREFIX + entry.plugin,
    config: entry.config,
    disabled: entry.disabled,
  })

  const resolve = (profile: readonly ProfileLayer[]): ResolvedEntry[] => {
    const entries = resolveProfile(profile).map((entry) => {
      const plugin = known.get(entry.plugin)
      if (!plugin) throw new ProfileError(entry.layers.at(-1) ?? 'profile', `row "${entry.id}" names unknown plugin "${entry.plugin}"`)
      if (options.safeMode && plugin.manifest.trust !== 'T0' && !entry.disabled) {
        return Object.freeze({ ...entry, disabled: true })
      }
      return entry
    })
    assertSlotGraph(entries, known)
    return entries
  }

  const apply = async (profile: readonly ProfileLayer[]) => {
    const next = resolve(profile)
    const previous = new Map(applied.map((entry) => [entry.id, entry]))
    // The pinned loader keeps a live entry bound to its first plugin name
    // (upstream cordiverse/cordis#218 is open), so a row that switches plugin
    // is removed before the reconcile re-creates it.
    for (const entry of next) {
      const before = previous.get(entry.id)
      if (before && before.plugin !== entry.plugin && internals.store[entry.id]) internals.remove(entry.id)
    }
    applied = next
    await internals.root.update(next.map(toOptions))
    await internals.await()
  }

  await apply(options.profile)

  return {
    ...kernel,
    loader,
    entries: () => applied,
    fiberOf: (rowId) => {
      const fiber = internals.store[rowId]?.fiber
      return fiber?.uid ? fiber : undefined
    },
    apply,
    async replacePlugin(plugin) {
      const id = plugin.manifest.id
      if (!known.has(id)) throw new ProfileError('replacePlugin', `plugin "${id}" is not known to this node`)
      known.set(id, plugin)
      internals.builtins[id] = plugin
      for (const entry of applied) {
        if (entry.plugin !== id || !internals.store[entry.id]) continue
        internals.remove(entry.id)
        await internals.create(toOptions(entry))
      }
      await internals.await()
    },
  }
}

/** Every slot a loaded plugin contributes to must be declared by a loaded plugin. */
function assertSlotGraph(entries: readonly ResolvedEntry[], known: ReadonlyMap<string, GuanxiPlugin<any>>): void {
  const enabled = entries.filter((entry) => !entry.disabled).map((entry) => known.get(entry.plugin)!.manifest)
  const declared = new Set(enabled.flatMap((manifest) => manifest.contributes.slotDeclarations))
  for (const manifest of enabled) {
    for (const slot of manifest.contributes.slots) {
      if (!declared.has(slot)) {
        throw new ProfileError('profile', `plugin "${manifest.id}" contributes to undeclared slot "${slot}"`)
      }
    }
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
