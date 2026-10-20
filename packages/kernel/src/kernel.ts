/**
 * The kernel as the host sees it: load and unload plugins, read services,
 * emit events, count what is live.
 */
import {
  KernelCore,
  KernelLifecycleError,
  KernelTimeoutError,
  validatePlugin,
  type Fiber,
  type GuanxiPlugin,
  type KernelCounters,
  type KernelOptions,
  type PluginHandle,
} from './core.ts'
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
  readonly slots: SlotRegistry
  private closed = false

  /** Every queued host operation re-checks this when it runs, not only when it is requested. */
  protected assertOpen(): void {
    if (this.closed) throw new KernelLifecycleError('the kernel was disposed')
  }

  constructor(options: KernelOptions = {}) {
    this.core = new KernelCore(options)
    this.slots = new SlotRegistry({
      onSubscriberError: (error) =>
        this.core.log({ level: 'error', source: 'slots', message: `slot subscriber failed: ${error instanceof Error ? error.message : String(error)}` }),
    })
    this.core.provideKernelService(SLOTS_SERVICE, this.slots)
  }

  /** Refuse anything not built by definePlugin, and re-check its manifest. */
  protected assertLoadable(plugin: unknown, action: string): asserts plugin is GuanxiPlugin<any> {
    this.assertOpen()
    validatePlugin(plugin, action)
  }

  plugin<C>(plugin: GuanxiPlugin<C>, config?: C): Promise<PluginHandle> {
    try {
      this.assertLoadable(plugin, 'kernel.plugin()')
    } catch (error) {
      return Promise.reject(error)
    }
    return this.core.transition(`loading ${plugin.manifest.id}`, async () => {
      this.assertOpen()
      const fiber = this.core.createFiber(plugin, config, null)
      try {
        await this.core.start(fiber)
        if (fiber.state === 'failed') throw fiber.error
        await this.core.settle()
        // A step abandoned anywhere in this load (also in a dependent it woke)
        // rejects the load, so roll this plugin back while the queue is ours.
        const abandoned = this.core.abandonedSteps()
        if (abandoned.length) throw new KernelTimeoutError(`loading ${plugin.manifest.id}`, this.core.timeoutMs, abandoned)
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

/**
 * The object handed to the host: methods only, backed by the private
 * implementation, so host code cannot reach the core maps or lifecycle state.
 */
export function kernelFacade(impl: KernelImpl): Kernel {
  return Object.freeze({
    slots: impl.slots,
    plugin: <C>(plugin: GuanxiPlugin<C>, config?: C) => impl.plugin(plugin, config),
    service: <T>(name: string) => impl.service<T>(name),
    emit: (event: string, ...args: unknown[]) => impl.emit(event, ...args),
    counters: () => impl.counters(),
    dispose: () => impl.dispose(),
  })
}

export function createKernel(options: KernelOptions = {}): Kernel {
  return kernelFacade(new KernelImpl(options))
}
