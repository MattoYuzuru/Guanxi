/**
 * `@guanxi/kernel` — Guanxi's own plugin kernel (ADR-0037). Isomorphic: this
 * entry runs in Node and in the browser. Node-only parts (profile boot,
 * process resource counters) live in `@guanxi/kernel/node`.
 *
 * Exports are listed one by one on purpose: this list is the kernel's public
 * surface.
 */
export {
  KernelLifecycleError,
  KernelTimeoutError,
  PluginContractError,
} from './core.ts'
export type {
  ChildPlugin,
  Cleanup,
  GuanxiPlugin,
  KernelCounters,
  KernelLogRecord,
  KernelOptions,
  PluginContext,
  PluginHandle,
  PluginState,
} from './core.ts'

export {
  KERNEL_API_VERSION,
  ManifestError,
  parseManifest,
  readPackageManifest,
  satisfiesEngine,
} from './manifest.ts'
export type { DeclaredContributionKind, GuanxiManifest, ManifestContributions, TrustTier } from './manifest.ts'

export {
  definePlugin,
  effect,
  emit,
  interval,
  isGuanxiPlugin,
  on,
  optionalService,
  provide,
  service,
  timeout,
} from './plugin.ts'
export type { PluginDefinition } from './plugin.ts'

export { SLOTS_SERVICE, SlotRegistry, contribute, declareSlot } from './slots.ts'
export type { ListSlotEntry, SlotCounts, SlotKind } from './slots.ts'

export { ProfileError, assertPlainData, resolveProfile } from './profile.ts'
export type { ProfileEntry, ProfileLayer, ProfilePatch, ResolvedEntry } from './profile.ts'

export { createKernel } from './kernel.ts'
export type { Kernel } from './kernel.ts'
