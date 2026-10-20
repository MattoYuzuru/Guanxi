/**
 * Guanxi plugins: a manifest-checked plugin object plus helpers that keep
 * feature code short. Every helper registers through the plugin's context, so
 * unloading reverts it.
 */
import {
  PluginContractError,
  type Cleanup,
  type GuanxiPlugin,
  type PluginContext,
} from './core.ts'
import { KERNEL_API_VERSION, ManifestError, parseManifest, satisfiesEngine } from './manifest.ts'

export interface PluginDefinition<C> {
  readonly manifest: unknown
  /**
   * Runs when every required service and contributed slot exists. Register
   * everything through `ctx` (effects, listeners, services, timers, slot
   * entries). May be async; may return a cleanup.
   */
  apply(ctx: PluginContext, config: C): void | Cleanup | Promise<void | Cleanup>
}

const plugins = new WeakSet<object>()

/** Define a T0/T1 in-process plugin. T2 plugins never load in-process (ADR-0022). */
export function definePlugin<C = undefined>(definition: PluginDefinition<C>): GuanxiPlugin<C> {
  const manifest = parseManifest(definition.manifest, 'manifest')
  if (manifest.trust === 'T2') {
    throw new ManifestError(
      'manifest.trust',
      `T2 plugin "${manifest.id}" must run out of process; the in-process kernel refuses it`,
    )
  }
  const plugin: GuanxiPlugin<C> = Object.freeze({
    name: manifest.id,
    manifest,
    apply(ctx: PluginContext, config: C) {
      if (!satisfiesEngine(manifest.engines.guanxi)) {
        throw new PluginContractError(
          manifest.id,
          `engines.guanxi "${manifest.engines.guanxi}" does not accept kernel ${KERNEL_API_VERSION}`,
        )
      }
      return definition.apply(ctx, config)
    },
  })
  plugins.add(plugin)
  return plugin
}

/** True only for plugins built by `definePlugin` (manifest checked, T2 refused). */
export function isGuanxiPlugin(value: unknown): value is GuanxiPlugin<any> {
  return typeof value === 'object' && value !== null && plugins.has(value)
}

/* ─────────────────────────────── Helpers ─────────────────────────────────── */

export function effect(ctx: PluginContext, setup: () => Cleanup | void, label?: string): () => Promise<void> {
  return ctx.effect(setup, label)
}

export function on(ctx: PluginContext, event: string, listener: (...args: any[]) => unknown): () => Promise<void> {
  return ctx.on(event, listener)
}

export function emit(ctx: PluginContext, event: string, ...args: unknown[]): void {
  ctx.emit(event, ...args)
}

export function provide<T>(ctx: PluginContext, name: string, value: T): void {
  ctx.provide(name, value)
}

export function service<T>(ctx: PluginContext, name: string): T {
  return ctx.service<T>(name)
}

export function optionalService<T>(ctx: PluginContext, name: string): T | undefined {
  return ctx.optionalService<T>(name)
}

/** `setTimeout` owned by the activation: cleared on unload. */
export function timeout(ctx: PluginContext, callback: () => void, ms: number): () => Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const dispose = ctx.effect(() => {
    handle = setTimeout(() => {
      handle = undefined
      void dispose()
      callback()
    }, ms)
    return () => {
      if (handle !== undefined) clearTimeout(handle)
    }
  }, 'timeout')
  return dispose
}

/** `setInterval` owned by the activation: cleared on unload. */
export function interval(ctx: PluginContext, callback: () => void, ms: number): () => Promise<void> {
  return ctx.effect(() => {
    const handle = setInterval(callback, ms)
    return () => clearInterval(handle)
  }, 'interval')
}
