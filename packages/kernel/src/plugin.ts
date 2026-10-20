/**
 * Guanxi plugins on top of Cordis plugins: a manifest-checked plugin object plus
 * the small set of helpers features use instead of the raw Cordis surface.
 */
import { Context, type Fiber } from './cordis.ts'
import {
  KERNEL_API_VERSION,
  ManifestError,
  parseManifest,
  satisfiesEngine,
  type GuanxiManifest,
} from './manifest.ts'

export const SLOT_SERVICE_PREFIX = 'slot:'

export class PluginContractError extends Error {
  readonly pluginId: string

  constructor(pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = 'PluginContractError'
    this.pluginId = pluginId
  }
}

export interface PluginDefinition<C> {
  readonly manifest: unknown
  /**
   * Runs when every required service and declared slot is available. Register
   * everything through the context (effects, listeners, services, timers,
   * slot entries) so unloading reverts it.
   */
  apply(ctx: Context, config: C): void | (() => void) | Promise<void | (() => void)>
}

export interface GuanxiPlugin<C = unknown> {
  readonly name: string
  readonly manifest: GuanxiManifest
  readonly inject: readonly string[]
  apply(ctx: Context, config: C): unknown
}

const manifests = new WeakMap<Function, GuanxiManifest>()

/** Define a T0/T1 in-process plugin. T2 plugins never load in-process (ADR-0022). */
export function definePlugin<C = undefined>(definition: PluginDefinition<C>): GuanxiPlugin<C> {
  const manifest = parseManifest(definition.manifest, 'manifest')
  if (manifest.trust === 'T2') {
    throw new ManifestError(
      'manifest.trust',
      `T2 plugin "${manifest.id}" must run out of process; the in-process kernel refuses it`,
    )
  }
  const inject = [
    ...manifest.requires,
    ...manifest.contributes.slots.map((slot) => SLOT_SERVICE_PREFIX + slot),
  ]
  function apply(ctx: Context, config: C): unknown {
    if (!satisfiesEngine(manifest.engines.guanxi)) {
      throw new PluginContractError(
        manifest.id,
        `engines.guanxi "${manifest.engines.guanxi}" does not accept kernel ${KERNEL_API_VERSION}`,
      )
    }
    const result = definition.apply(ctx, config)
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then((value) => {
        assertProvisions(ctx.fiber, manifest)
        return value
      })
    }
    assertProvisions(ctx.fiber, manifest)
    return result
  }
  manifests.set(apply, manifest)
  return Object.freeze({ name: manifest.id, manifest, inject: Object.freeze(inject), apply })
}

/** A plugin must provide exactly the services and slots its manifest declares. */
function assertProvisions(fiber: Fiber, manifest: GuanxiManifest): void {
  const services = new Set<string>()
  const slots = new Set<string>()
  for (const impl of fiber.provisions) {
    if (impl.name.startsWith(SLOT_SERVICE_PREFIX)) slots.add(impl.name.slice(SLOT_SERVICE_PREFIX.length))
    else services.add(impl.name)
  }
  const missing = manifest.provides.filter((name) => !services.has(name))
  const extra = [...services].filter((name) => !manifest.provides.includes(name))
  const missingSlots = manifest.contributes.slotDeclarations.filter((name) => !slots.has(name))
  if (missing.length || extra.length || missingSlots.length) {
    throw new PluginContractError(
      manifest.id,
      [
        missing.length ? `did not provide ${missing.join(', ')}` : '',
        extra.length ? `provided undeclared ${extra.join(', ')}` : '',
        missingSlots.length ? `did not declare slot ${missingSlots.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    )
  }
}

/** The manifest of the Guanxi plugin that owns this context, if any. */
export function manifestOf(ctx: Context): GuanxiManifest | undefined {
  let fiber: Fiber = ctx.fiber
  while (fiber.runtime) {
    const manifest = manifests.get(fiber.runtime.callback)
    if (manifest) return manifest
    fiber = fiber.parent.fiber
  }
  return undefined
}

export function requireManifest(ctx: Context, action: string): GuanxiManifest {
  const manifest = manifestOf(ctx)
  if (!manifest) throw new Error(`${action} needs a context owned by a Guanxi plugin`)
  return manifest
}

/* ─────────────────────────────── Helpers ─────────────────────────────────── */

/** Register a revertible effect; the returned disposer reverts it early. */
export function effect(ctx: Context, setup: () => () => unknown, label?: string): () => unknown {
  return ctx.effect(setup, label)
}

/** Listen to a kernel event for the lifetime of the context. */
export function on(
  ctx: Context,
  name: string,
  listener: (...args: any[]) => unknown,
): () => boolean {
  return (ctx.on as (name: string, listener: (...args: any[]) => unknown) => () => boolean)(name, listener)
}

/** Emit a kernel event synchronously. */
export function emit(ctx: Context, name: string, ...args: unknown[]): void {
  ;(ctx.emit as (name: string, ...args: unknown[]) => void)(name, ...args)
}

/** Provide a service declared in the plugin's manifest `provides`. */
export function provide<T>(ctx: Context, name: string, value: T): void {
  const manifest = requireManifest(ctx, `provide("${name}")`)
  if (!manifest.provides.includes(name)) {
    throw new PluginContractError(manifest.id, `"${name}" is not in manifest.provides`)
  }
  ctx.provide(name, value)
}

/** Read a service. Required services are always present while the plugin runs. */
export function service<T>(ctx: Context, name: string): T {
  const value = ctx.get(name) as T | undefined
  if (value === undefined || value === null) {
    throw new Error(`service "${name}" is not available`)
  }
  return value
}

/** Read an optional (`uses`) service; `undefined` when it is not loaded. */
export function optionalService<T>(ctx: Context, name: string): T | undefined {
  return (ctx.get(name) as T | undefined) ?? undefined
}

/** Run `callback` in a child scope whenever all `deps` are available. */
export function inject(ctx: Context, deps: readonly string[], callback: (ctx: Context) => unknown) {
  return ctx.inject([...deps], callback as (ctx: Context) => void)
}

/** `setTimeout` owned by the context: cleared on unload. */
export function timeout(ctx: Context, callback: () => void, ms: number): () => unknown {
  let dispose: () => unknown = () => undefined
  dispose = ctx.effect(() => {
    const handle = setTimeout(() => {
      void dispose()
      callback()
    }, ms)
    return () => clearTimeout(handle)
  }, 'timeout')
  return dispose
}

/** `setInterval` owned by the context: cleared on unload. */
export function interval(ctx: Context, callback: () => void, ms: number): () => unknown {
  return ctx.effect(() => {
    const handle = setInterval(callback, ms)
    return () => clearInterval(handle)
  }, 'interval')
}
