/**
 * Kernel root: one Cordis context with the lifecycle guard, an error sink for
 * the Cordis logger, the slot registry, and leak counters.
 */
import { Context, FIBER_STATE, installLifecycleGuard, type Fiber, type Message } from './cordis.ts'
import { isGuanxiPlugin, type GuanxiPlugin } from './plugin.ts'
import { SLOTS_SERVICE, SlotRegistry } from './slots.ts'

export interface KernelLogRecord {
  readonly level: 'error' | 'warn'
  readonly source: string
  readonly message: string
}

export interface KernelOptions {
  /**
   * Receives plugin errors and warnings. Upstream Cordis keeps them in an
   * in-memory buffer only, which would hide a failed plugin. Default: console.
   */
  readonly onLog?: (record: KernelLogRecord) => void
  /**
   * Upper bound for one unload (default 10 s). Cordis waits without limit for
   * dependents and async cleanups; past the bound the kernel reports which
   * plugins and effects are still pending instead of hanging its caller.
   */
  readonly disposeTimeoutMs?: number
}

export class KernelTimeoutError extends Error {
  /** `<plugin>: <effect labels>` for every plugin still unloading. */
  readonly pending: readonly string[]

  constructor(action: string, timeoutMs: number, pending: readonly string[]) {
    super(`${action} did not finish within ${timeoutMs} ms; still unloading: ${pending.join('; ') || 'unknown'}`)
    this.name = 'KernelTimeoutError'
    this.pending = pending
  }
}

export interface KernelCounters {
  /** Event listeners registered on the kernel (all event names). */
  readonly listeners: number
  /** Plugin runtimes in the registry. */
  readonly runtimes: number
  /** Live plugin fibers (instances). */
  readonly fibers: number
  /** Live service implementations. */
  readonly services: number
  /** Effects owned directly by the root (one per top-level plugin, plus kernel services). */
  readonly rootEffects: number
  readonly slots: number
  readonly slotEntries: number
  readonly slotSubscribers: number
  readonly slotHolds: number
  /** Slot entries dropped because their slot vanished first (should stay 0). */
  readonly slotOrphans: number
}

export interface PluginHandle {
  readonly fiber: Fiber
  /** Unload the plugin and wait until every effect is reverted. */
  dispose(): Promise<void>
}

export interface Kernel {
  readonly root: Context
  readonly slots: SlotRegistry
  /**
   * Load a plugin under the root. Resolves when it is active, or right away
   * while it waits (PENDING) for a required service; rejects if it fails.
   */
  plugin<C>(plugin: GuanxiPlugin<C>, config?: C): Promise<PluginHandle>
  counters(): KernelCounters
  /** Unload every plugin (bounded by `disposeTimeoutMs`). */
  dispose(): Promise<void>
  /** Run `task` under the unload bound; rejects with KernelTimeoutError past it. */
  withinDisposeBound<T>(action: string, task: Promise<T>): Promise<T>
}

function format(message: Message): string {
  return message.args
    .map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === 'string' ? arg : safeJson(arg)))
    .join(' ')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function defaultLog(record: KernelLogRecord): void {
  const line = `[guanxi:kernel] ${record.source}: ${record.message}`
  if (record.level === 'error') console.error(line)
  else console.warn(line)
}

export function createKernel(options: KernelOptions = {}): Kernel {
  installLifecycleGuard()
  const root = new Context()
  const onLog = options.onLog ?? defaultLog

  // Drop the retained message buffer: it keeps up to 1000 messages with their
  // arguments alive, which hides errors and pins disposed objects in memory.
  const logger = root.logger as unknown as {
    bufferSize: number
    buffer: unknown[]
    exporter(exporter: { export(message: Message): void; levels?: Record<string, number> }): unknown
  }
  logger.bufferSize = 0
  logger.buffer.length = 0
  logger.exporter({
    levels: { default: 1 },
    export(message) {
      if (message.type !== 'error' && message.type !== 'warn') return
      onLog({ level: message.type, source: message.name, message: format(message) })
    },
  })

  const slots = new SlotRegistry()
  root.provide(SLOTS_SERVICE, slots)

  const timeoutMs = options.disposeTimeoutMs ?? 10_000
  const withinDisposeBound = <T>(action: string, task: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new KernelTimeoutError(action, timeoutMs, pendingUnloads(root))), timeoutMs)
    })
    return Promise.race([task, bound]).finally(() => clearTimeout(timer))
  }

  return {
    root,
    slots,
    async plugin(plugin, config) {
      if (!isGuanxiPlugin(plugin)) {
        throw new TypeError('kernel.plugin() accepts only plugins built by definePlugin()')
      }
      const fiber = root.plugin(plugin as never, config as never) as unknown as Fiber
      const dispose = () => withinDisposeBound(`unloading ${plugin.manifest.id}`, unloadFiber(fiber))
      try {
        await fiber.await()
      } catch (error) {
        await dispose()
        throw error
      }
      return { fiber, dispose }
    },
    counters() {
      return countKernel(root, slots)
    },
    withinDisposeBound,
    async dispose() {
      const fibers = [...root.registry.values()].flatMap((runtime) => [...runtime.fibers])
      await withinDisposeBound(
        'kernel dispose',
        Promise.all(fibers.map((fiber) => unloadFiber(fiber))).then(() => undefined),
      )
    },
  }
}

/** Dispose a fiber and wait until it settled, also when another caller started the unload. */
export async function unloadFiber(fiber: Fiber): Promise<void> {
  await fiber.dispose()
  while (fiber.inertia) await fiber.inertia.catch(() => undefined)
}

function pendingUnloads(root: Context): string[] {
  const pending: string[] = []
  for (const runtime of root.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.state !== FIBER_STATE.unloading) continue
      const labels = fiber.getEffects().map((effect) => effect.label)
      pending.push(`${fiber.name}${labels.length ? ` (${labels.join(', ')})` : ''}`)
    }
  }
  return pending
}

export function countKernel(root: Context, slots: SlotRegistry): KernelCounters {
  const hooks = (root.events as unknown as { _hooks: Record<PropertyKey, unknown[]> })._hooks
  let listeners = 0
  for (const key of Reflect.ownKeys(hooks)) listeners += hooks[key]?.length ?? 0
  let fibers = 0
  for (const runtime of root.registry.values()) fibers += runtime.fibers.length
  const slotCounts = slots.counts()
  return {
    listeners,
    runtimes: root.registry.size,
    fibers,
    services: Reflect.ownKeys(root.reflect.store).length,
    rootEffects: root.fiber._disposables.length,
    slots: slotCounts.slots,
    slotEntries: slotCounts.entries,
    slotSubscribers: slotCounts.subscribers,
    slotHolds: slotCounts.holds,
    slotOrphans: slots.orphansDropped,
  }
}

/** True when the fiber has finished loading and is serving. */
export function isActive(fiber: Fiber): boolean {
  return fiber.state === FIBER_STATE.active
}
