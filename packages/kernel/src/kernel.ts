/**
 * The kernel as the host sees it: load and unload plugins, read services,
 * emit events, count what is live.
 */
import {
  KernelCore,
  KernelLifecycleError,
  PluginContractError,
  type Fiber,
  type GuanxiPlugin,
  type KernelCounters,
  type KernelOptions,
  type PluginHandle,
} from './core.ts'
import { parseManifest } from './manifest.ts'
import { isGuanxiPlugin } from './plugin.ts'
import { SLOTS_SERVICE, SlotRegistry } from './slots.ts'

export interface Kernel {
  readonly slots: SlotRegistry
  /**
   * Load a plugin. Resolves when it is active, or right away while it waits
   * (pending) for a required service; rejects, leaving nothing behind, if it fails.
   */
  plugin<C>(plugin: GuanxiPlugin<C>, config?: C): Promise<PluginHandle>
  /** A service value as the host sees it (`undefined` when nobody provides it). */
  service<T>(name: string): T | undefined
  /** Call every listener of a kernel event synchronously. */
  emit(event: string, ...args: unknown[]): void
  counters(): KernelCounters
  /** Unload every plugin, children and dependents first. The kernel is closed afterwards. */
  dispose(): Promise<void>
}

export function handleFor(core: KernelCore, fiber: Fiber): PluginHandle {
  return {
    pluginId: fiber.manifest.id,
    get state() {
      return fiber.state
    },
    dispose: () => core.disposeFiber(fiber),
  }
}

export class KernelImpl implements Kernel {
  readonly core: KernelCore
  readonly slots = new SlotRegistry()
  private closed = false

  constructor(options: KernelOptions = {}) {
    this.core = new KernelCore(options)
    this.core.provideKernelService(SLOTS_SERVICE, this.slots)
  }

  /** Refuse anything not built by definePlugin, and re-check its manifest. */
  protected assertLoadable(plugin: unknown, action: string): asserts plugin is GuanxiPlugin<any> {
    if (this.closed) throw new KernelLifecycleError('the kernel was disposed')
    if (!isGuanxiPlugin(plugin)) throw new TypeError(`${action} accepts only plugins built by definePlugin()`)
    const manifest = parseManifest(plugin.manifest, 'manifest')
    if (manifest.trust === 'T2') throw new PluginContractError(manifest.id, 'T2 plugins run out of process')
  }

  plugin<C>(plugin: GuanxiPlugin<C>, config?: C): Promise<PluginHandle> {
    try {
      this.assertLoadable(plugin, 'kernel.plugin()')
    } catch (error) {
      return Promise.reject(error)
    }
    return this.core.transition(`loading ${plugin.manifest.id}`, async () => {
      const fiber = this.core.createFiber(plugin, config, null)
      try {
        await this.core.start(fiber)
        if (fiber.state === 'failed') throw fiber.error
        await this.core.settle()
        return handleFor(this.core, fiber)
      } catch (error) {
        // Rejecting leaves nothing behind.
        this.core.requestDispose(fiber)
        await this.core.stop(fiber, 'disposed')
        throw error
      }
    })
  }

  service<T>(name: string): T | undefined {
    return this.core.serviceValue<T>(name)
  }

  emit(event: string, ...args: unknown[]): void {
    this.core.emit(event, args)
  }

  counters(): KernelCounters {
    const fibers = [...this.core.fibers]
    const slotCounts = this.slots.counts()
    return {
      listeners: this.core.listenerCount(),
      fibers: fibers.length,
      pending: fibers.filter((fiber) => fiber.state === 'pending').length,
      failed: fibers.filter((fiber) => fiber.state === 'failed').length,
      services: this.core.services.size,
      effects: this.core.effectCount(),
      slots: slotCounts.slots,
      slotEntries: slotCounts.entries,
      slotSubscribers: slotCounts.subscribers,
      slotHolds: slotCounts.holds,
      slotOrphans: slotCounts.orphans,
    }
  }

  dispose(): Promise<void> {
    this.closed = true
    // Abort running activations now, so an async apply can stop early.
    for (const fiber of this.core.fibers) if (fiber.parent === null) this.core.requestDispose(fiber)
    return this.core.transition('kernel dispose', async () => {
      const roots = [...this.core.fibers].filter((fiber) => fiber.parent === null)
      // Consumers first: a provider waits for its dependents anyway, so the
      // reverse creation order keeps the cascade short.
      for (const fiber of roots.reverse()) await this.core.stop(fiber, 'disposed')
    })
  }
}

export function createKernel(options: KernelOptions = {}): Kernel {
  return new KernelImpl(options)
}
