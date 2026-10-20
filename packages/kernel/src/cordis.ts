/**
 * Cordis core as the kernel sees it.
 *
 * Only `cordis-runtime.js` and `loader-runtime.js` import Cordis. Every other
 * package reaches it through `@guanxi/kernel` (ADR-0015), so the kernel can be
 * swapped without touching features; `test/boundary.test.ts` enforces this.
 * This module also installs the lifecycle guard, the one runtime patch Guanxi
 * applies to upstream Cordis (see `installLifecycleGuard`).
 */
import { Context, CordisError, Fiber, RegistryService, Service } from './cordis-runtime.js'

export { Context, Fiber, Service }
export type { Disposer, Message, PluginRuntime, ServiceImpl } from './cordis-runtime.js'

/** Fiber states of Cordis 4 (its `FiberState` is an ambient const enum). */
export const FIBER_STATE = Object.freeze({
  pending: 0,
  loading: 1,
  active: 2,
  failed: 3,
  disposed: 4,
  unloading: 5,
} as const)

export type FiberStateName = keyof typeof FIBER_STATE

export function fiberStateName(fiber: Fiber): FiberStateName {
  const entry = Object.entries(FIBER_STATE).find(([, value]) => value === fiber.state)
  if (!entry) throw new Error(`Unknown fiber state ${String(fiber.state)}`)
  return entry[0] as FiberStateName
}

const GUARDED = Symbol.for('guanxi.kernel.lifecycle-guard')

function isInactivePlugin(fiber: Fiber): boolean {
  return Boolean(
    fiber.runtime &&
      (fiber.state === FIBER_STATE.unloading || fiber.state === FIBER_STATE.pending),
  )
}

function inactiveError(fiber: Fiber): Error {
  return new CordisError(
    'INACTIVE_EFFECT',
    `cannot create effect on ${fiberStateName(fiber)} plugin "${fiber.name}"`,
  )
}

/**
 * Kernel patch 1 of the ADR-0015 budget (10): refuse new registrations on a
 * plugin fiber that is UNLOADING or still PENDING.
 *
 * Upstream Cordis 4.0.0-rc.11 accepts both. A registration made while a fiber
 * unloads lands after `_unload()` has drained its list and is never disposed; a
 * registration on a never-activated fiber is never drained by `dispose()`.
 * Listeners (`ctx.on`) are effects, so guarding `Fiber#effect` covers effects
 * and listeners; `RegistryService#plugin` is guarded too, before it records a
 * runtime, so a refused child plugin leaves no registry entry behind. Upstream
 * fixes are open, not merged: cordiverse/cordis#96, #185 (item 2) and #91.
 * LOADING stays legal: effects of a starting plugin are drained by the
 * activation that follows. The root fiber (no runtime) is always ACTIVE.
 */
export function installLifecycleGuard(): void {
  const fiberPrototype = Fiber.prototype as Fiber & { [GUARDED]?: true }
  if (fiberPrototype[GUARDED]) return
  const originalEffect = fiberPrototype.effect
  Object.defineProperty(fiberPrototype, 'effect', {
    value: function effect(this: Fiber, ...args: Parameters<Fiber['effect']>) {
      if (isInactivePlugin(this)) throw inactiveError(this)
      return originalEffect.apply(this, args)
    },
    writable: true,
    configurable: true,
  })
  const registryPrototype = RegistryService.prototype
  const originalPlugin = registryPrototype.plugin
  Object.defineProperty(registryPrototype, 'plugin', {
    value: function plugin(this: RegistryService, ...args: Parameters<RegistryService['plugin']>) {
      if (isInactivePlugin(this.ctx.fiber)) throw inactiveError(this.ctx.fiber)
      return originalPlugin.apply(this, args)
    },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(fiberPrototype, GUARDED, { value: true })
}
