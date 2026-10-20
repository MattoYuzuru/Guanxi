/**
 * `@guanxi/kernel` — the Guanxi plugin kernel, a thin facade over Cordis 4
 * (ADR-0015). Isomorphic: this entry runs in Node and in the browser. Node-only
 * parts (loader, profile boot, process resource counters) live in
 * `@guanxi/kernel/node`.
 *
 * Exports are listed one by one on purpose: this list is the whole surface a
 * replacement kernel would have to provide.
 */
export { Context, FIBER_STATE, Service, fiberStateName } from './cordis.ts'
export type { Fiber as PluginFiber, FiberStateName } from './cordis.ts'

export {
  KERNEL_API_VERSION,
  ManifestError,
  parseManifest,
  readPackageManifest,
  satisfiesEngine,
} from './manifest.ts'
export type { GuanxiManifest, ManifestContributions, TrustTier } from './manifest.ts'

export {
  PluginContractError,
  definePlugin,
  effect,
  emit,
  inject,
  interval,
  manifestOf,
  on,
  optionalService,
  provide,
  service,
  timeout,
} from './plugin.ts'
export type { GuanxiPlugin, PluginDefinition } from './plugin.ts'

export { SLOTS_SERVICE, SlotRegistry, contribute, declareSlot } from './slots.ts'
export type { ListSlotEntry, SlotCounts, SlotKind } from './slots.ts'

export { ProfileError, assertPlainData, resolveProfile } from './profile.ts'
export type { ProfileEntry, ProfileLayer, ProfilePatch, ResolvedEntry } from './profile.ts'

export { countKernel, createKernel, isActive } from './kernel.ts'
export type { Kernel, KernelCounters, KernelLogRecord, KernelOptions, PluginHandle } from './kernel.ts'
