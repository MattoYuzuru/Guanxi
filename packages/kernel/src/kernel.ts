/**
 * The kernel as the host sees it: load and unload plugins, read services,
 * emit events, count what is live.
 */
import {
  KernelCore,
  type Fiber,
  type GuanxiPlugin,
  type KernelCounters,
  type KernelOptions,
  type PluginHandle,
} from './core.ts'
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
  /** Unload every plugin, children and dependents first. */
  dispose(): Promise<void>
}

export function handleFor(core: KernelCore, fiber: Fiber): PluginHandle {
  return {
    pluginId: fiber.manifest.id,
    get state() {
      return fiber.state
    },
    dispose() {
      core.requestDispose(fiber)
      return core.transition(`unloading ${fiber.manifest.id}`, async () => {
        await core.stop(fiber, 'disposed')
        await core.settle()
      })
    },
  }
}

export class KernelImpl implements Kernel {
  readonly core: KernelCore
  readonly slots = new SlotRegistry()

  constructor(options: KernelOptions = {}) {
    this.core = new KernelCore(options)
    this.core.provideKernelService(SLOTS_SERVICE, this.slots)
  }

  plugin<C>(plugin: GuanxiPlugin<C>, config?: C): Promise<PluginHandle> {
    if (!isGuanxiPlugin(plugin)) {
      return Promise.reject(new TypeError('kernel.plugin() accepts only plugins built by definePlugin()'))
    }
    return this.core.transition(`loading ${plugin.manifest.id}`, async () => {
      const fiber = this.core.createFiber(plugin, config, null)
      await this.core.start(fiber)
      if (fiber.state === 'failed') {
        await this.core.stop(fiber, 'disposed')
        throw fiber.error
      }
      await this.core.settle()
      return handleFor(this.core, fiber)
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
      slotOrphans: this.slots.orphansDropped,
    }
  }

  dispose(): Promise<void> {
    // Abort running activations now, so an async apply can stop early.
    for (const fiber of this.core.fibers) if (fiber.parent === null) this.core.requestDispose(fiber)
    return this.core.transition('kernel dispose', async () => {
      const roots = [...this.core.fibers].filter((fiber) => fiber.parent === null)
      for (const fiber of roots) this.core.requestDispose(fiber)
      // Consumers first: a provider waits for its dependents anyway, so the
      // reverse creation order keeps the cascade short.
      for (const fiber of roots.reverse()) await this.core.stop(fiber, 'disposed')
    })
  }
}

export function createKernel(options: KernelOptions = {}): Kernel {
  return new KernelImpl(options)
}
