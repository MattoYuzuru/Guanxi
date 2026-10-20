/**
 * `@guanxi/kernel/node` — Node-only kernel parts: profile boot and
 * reconciliation, and process resource counters.
 *
 * A profile row names a plugin the node registered by manifest id, so a
 * profile can only load known plugins; it never imports a module path and
 * never evaluates code. Code replacement goes through `replacePlugin` with a
 * freshly imported module (see README).
 */
import { readFile } from 'node:fs/promises'
import type { Fiber, GuanxiPlugin, PluginState } from './core.ts'
import { KernelImpl, type Kernel } from './kernel.ts'
import type { KernelOptions } from './core.ts'
import { ProfileError, resolveProfile, type ProfileLayer, type ResolvedEntry } from './profile.ts'

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
  /** The resolved rows currently applied. */
  entries(): readonly ResolvedEntry[]
  /** The lifecycle state of a row's plugin; `undefined` for a disabled or unknown row. */
  stateOf(rowId: string): PluginState | undefined
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

/** Services the kernel itself provides; rows may require them without a provider row. */
const KERNEL_SERVICES = new Set(['slots'])

class NodeKernelImpl extends KernelImpl implements NodeKernel {
  private readonly known = new Map<string, GuanxiPlugin<any>>()
  private readonly pinned: ReadonlySet<string>
  private readonly safeMode: boolean
  private readonly rows = new Map<string, Fiber>()
  private applied: ResolvedEntry[] = []

  constructor(options: BootOptions) {
    super(options)
    for (const plugin of options.plugins) {
      this.assertLoadable(plugin, 'bootNode()')
      if (this.known.has(plugin.manifest.id)) {
        throw new ProfileError('plugins', `plugin "${plugin.manifest.id}" is registered twice`)
      }
      this.known.set(plugin.manifest.id, plugin)
    }
    this.pinned = new Set(options.pinned ?? [])
    this.safeMode = Boolean(options.safeMode)
  }

  entries(): readonly ResolvedEntry[] {
    return this.applied
  }

  stateOf(rowId: string): PluginState | undefined {
    return this.rows.get(rowId)?.state
  }

  private resolve(profile: readonly ProfileLayer[]): ResolvedEntry[] {
    // Safe mode boots the base layer only: user layers may name unknown
    // plugins or carry the config that broke the node.
    const layers = this.safeMode ? profile.slice(0, 1) : profile
    return closeGraph(
      resolveProfile(layers).map((entry) => {
        const plugin = this.known.get(entry.plugin)
        if (!plugin) {
          throw new ProfileError(entry.layers.at(-1) ?? 'profile', `row "${entry.id}" names unknown plugin "${entry.plugin}"`)
        }
        if (this.safeMode && plugin.manifest.trust !== 'T0' && !entry.disabled) {
          return Object.freeze({ ...entry, disabled: true })
        }
        return entry
      }),
      this.known,
      this.safeMode,
    )
  }

  /**
   * Rows that would restart: the unloaded rows, every loaded row that needs
   * or uses a service of an affected row (transitively), and loaded rows that
   * use a service a newly loaded row provides.
   */
  private impacted(unloaded: ReadonlySet<string>, loaded: readonly ResolvedEntry[]): Set<string> {
    const manifestOf = (id: string) => {
      const entry = this.applied.find((row) => row.id === id)
      return entry ? this.known.get(entry.plugin)!.manifest : undefined
    }
    const provides = (id: string) => {
      const manifest = manifestOf(id)
      return manifest ? [...manifest.provides, ...manifest.contributes.slotDeclarations.map((slot) => `slot:${slot}`)] : []
    }
    const consumes = (id: string) => {
      const manifest = manifestOf(id)
      return manifest
        ? [...manifest.requires, ...manifest.uses, ...manifest.contributes.slots.map((slot) => `slot:${slot}`)]
        : []
    }
    const affected = new Set(unloaded)
    const fresh = new Set(loaded.flatMap((entry) => this.known.get(entry.plugin)!.manifest.provides))
    // A loaded row restarts when an optional (`uses`) service of it appears.
    for (const [id] of this.rows) if (manifestOf(id)?.uses.some((name) => fresh.has(name))) affected.add(id)
    for (let grew = true; grew;) {
      grew = false
      const gone = new Set([...affected].flatMap(provides))
      for (const [id] of this.rows) {
        if (affected.has(id) || !consumes(id).some((name) => gone.has(name))) continue
        affected.add(id)
        grew = true
      }
    }
    return affected
  }

  private assertPinned(unloaded: ReadonlySet<string>, loaded: readonly ResolvedEntry[]): void {
    for (const id of this.impacted(unloaded, loaded)) {
      if (this.pinned.has(id)) {
        throw new ProfileError('profile', `row "${id}" is pinned: its services are held outside the kernel`)
      }
    }
  }

  /**
   * A failed row fails the change, and so does a row still waiting for a
   * service that an enabled row provides. The profile stays applied; failed
   * rows load again on the next `apply`.
   */
  private assertServing(): void {
    const failed: string[] = []
    const enabled = this.applied.filter((entry) => !entry.disabled)
    const provided = new Set(enabled.flatMap((entry) => {
      const manifest = this.known.get(entry.plugin)!.manifest
      return [...manifest.provides, ...manifest.contributes.slotDeclarations.map((slot) => `slot:${slot}`)]
    }))
    for (const entry of enabled) {
      const fiber = this.rows.get(entry.id)
      const state = fiber?.state
      if (state === 'failed' || state === undefined || state === 'disposed') failed.push(`${entry.id}: ${state ?? 'not loaded'}`)
      else if (state === 'pending' && fiber!.needs.every((name) => provided.has(name))) failed.push(`${entry.id}: waiting`)
    }
    if (failed.length) throw new NodeLoadError(failed)
  }

  private async unloadRow(id: string): Promise<void> {
    const fiber = this.rows.get(id)
    if (!fiber) return
    this.rows.delete(id)
    await this.core.stop(fiber, 'disposed')
  }

  private loadRow(entry: ResolvedEntry): Fiber {
    const fiber = this.core.createFiber(this.known.get(entry.plugin)!, structuredClone(entry.config), null)
    this.rows.set(entry.id, fiber)
    return fiber
  }

  apply(profile: readonly ProfileLayer[]): Promise<void> {
    return this.core.transition('applying the profile', async () => {
      const next = this.resolve(profile)
      const before = new Map(this.applied.map((entry) => [entry.id, entry]))
      const after = new Map(next.map((entry) => [entry.id, entry]))
      const changed = (id: string, left: ResolvedEntry, right: ResolvedEntry) =>
        left.plugin !== right.plugin ||
        JSON.stringify(left.config) !== JSON.stringify(right.config) ||
        this.rows.get(id)?.state === 'failed'
      const unload = new Set(
        [...before].filter(([id, left]) => {
          const right = after.get(id)
          return this.rows.has(id) && (!right || right.disabled || changed(id, left, right))
        }).map(([id]) => id),
      )
      const load = next.filter((entry) => !entry.disabled && (!this.rows.has(entry.id) || unload.has(entry.id)))
      this.assertPinned(unload, load)

      // Unload first (removed, disabled, changed, failed rows), then load, in profile order.
      for (const id of unload) await this.unloadRow(id)
      const started: Fiber[] = []
      for (const entry of next) {
        if (entry.disabled || this.rows.has(entry.id)) continue
        started.push(this.loadRow(entry))
      }
      this.applied = next
      for (const fiber of started) await this.core.start(fiber)
      await this.core.settle()
      this.assertServing()
    })
  }

  replacePlugin(plugin: GuanxiPlugin<any>): Promise<void> {
    return this.core.transition(`replacing ${plugin?.manifest?.id}`, async () => {
      this.assertLoadable(plugin, 'replacePlugin()')
      const id = plugin.manifest.id
      const current = this.known.get(id)
      if (!current) throw new ProfileError('replacePlugin', `plugin "${id}" is not known to this node`)
      if (JSON.stringify(current.manifest) !== JSON.stringify(plugin.manifest)) {
        throw new ProfileError('replacePlugin', `plugin "${id}" changed its manifest; apply a profile instead`)
      }
      const rows = this.applied.filter((entry) => entry.plugin === id && this.rows.has(entry.id))
      this.assertPinned(new Set(rows.map((entry) => entry.id)), [])
      this.known.set(id, plugin)
      for (const entry of rows) await this.unloadRow(entry.id)
      for (const entry of rows) await this.core.start(this.loadRow(entry))
      await this.core.settle()
      this.assertServing()
    })
  }
}

export async function bootNode(options: BootOptions): Promise<NodeKernel> {
  const node = new NodeKernelImpl(options)
  try {
    await node.apply(options.profile)
  } catch (error) {
    await node.dispose().catch(() => undefined)
    throw error
  }
  return node
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
    if (!changed) {
      assertAcyclic(rows, manifest)
      return rows
    }
  }
}

/** Required services and slots between enabled rows must not form a cycle. */
function assertAcyclic(rows: readonly ResolvedEntry[], manifest: (entry: ResolvedEntry) => import('./manifest.ts').GuanxiManifest): void {
  const enabled = rows.filter((entry) => !entry.disabled)
  const providers = new Map<string, string>()
  for (const entry of enabled) {
    const m = manifest(entry)
    for (const name of m.provides) providers.set(name, entry.id)
    for (const slot of m.contributes.slotDeclarations) providers.set(`slot:${slot}`, entry.id)
  }
  const edges = new Map(enabled.map((entry) => {
    const m = manifest(entry)
    const needs = [...m.requires, ...m.contributes.slots.map((slot) => `slot:${slot}`)]
    return [entry.id, needs.map((name) => providers.get(name)).filter((id): id is string => id !== undefined)]
  }))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      throw new ProfileError('profile', `rows require each other in a cycle: ${[...path.slice(path.indexOf(id)), id].join(' → ')}`)
    }
    state.set(id, 'visiting')
    for (const next of edges.get(id) ?? []) visit(next, [...path, id])
    state.set(id, 'done')
  }
  for (const entry of enabled) visit(entry.id, [])
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
