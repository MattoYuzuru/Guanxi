/**
 * The Guanxi kernel core (ADR-0037): plugin fibers, services, effects, events
 * and a tree of plugin contexts, with Cordis's semantics and none of its
 * upstream lifecycle races.
 *
 * Three rules carry the design:
 *
 * 1. **One transition at a time.** Every load, unload, restart and profile
 *    change runs through one queue per kernel, so lifecycle steps never
 *    interleave (no update races, no rebind races).
 * 2. **Registrations belong to one activation.** A `PluginContext` is created
 *    per activation and accepts effects, listeners, services and child plugins
 *    only while that activation is LOADING or ACTIVE. Anything later (an async
 *    continuation after unload or failure, a stale context after a restart) is
 *    refused, so nothing can escape a teardown.
 * 3. **Dependents leave first.** A provider unloads only after every fiber
 *    bound to its services has unloaded; dependents come back when a provider
 *    of the service returns.
 */
import { KERNEL_API_VERSION, parseManifest, satisfiesEngine, type GuanxiManifest } from './manifest.ts'

export type PluginState = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'disposed'

/** A cleanup may finish asynchronously; the kernel waits for it. */
export type Cleanup = () => unknown

export interface KernelLogRecord {
  readonly level: 'error' | 'warn'
  readonly source: string
  readonly message: string
}

export interface KernelOptions {
  /** Receives plugin errors and warnings. Default: the console. */
  readonly onLog?: (record: KernelLogRecord) => void
  /**
   * Upper bound for one plugin step: one `apply` or one cleanup (default 10 s).
   * A step past it is abandoned: an apply fails its plugin, a cleanup is
   * skipped. The transition then finishes in a consistent state and its caller
   * gets a KernelTimeoutError naming every abandoned step.
   */
  readonly stepTimeoutMs?: number
}

export class KernelLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KernelLifecycleError'
  }
}

export class KernelTimeoutError extends Error {
  /** `<plugin> (<step>)` for every abandoned step. */
  readonly pending: readonly string[]

  constructor(action: string, timeoutMs: number, pending: readonly string[]) {
    super(`${action}: steps abandoned after ${timeoutMs} ms: ${pending.join('; ') || 'unknown'}`)
    this.name = 'KernelTimeoutError'
    this.pending = pending
  }
}

export class PluginContractError extends Error {
  readonly pluginId: string

  constructor(pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = 'PluginContractError'
    this.pluginId = pluginId
  }
}

/** What a plugin sees. One context per activation; it goes stale when the activation ends. */
export interface PluginContext {
  readonly pluginId: string
  readonly manifest: GuanxiManifest
  /** Aborted as soon as this activation starts to unload or fails. */
  readonly signal: AbortSignal
  /** Run `setup` now; its returned cleanup runs on unload. The disposer reverts it early. */
  effect(setup: () => Cleanup | void, label?: string): () => Promise<void>
  /** Listen to a kernel event for the lifetime of this activation. */
  on(event: string, listener: (...args: any[]) => unknown): () => Promise<void>
  /** Call every listener of `event` synchronously; a throwing listener is logged, not fatal. */
  emit(event: string, ...args: unknown[]): void
  /** Provide a service declared in `manifest.provides` (only while loading). */
  provide<T>(name: string, value: T): void
  /** A required service (`manifest.requires`) or a kernel service. */
  service<T>(name: string): T
  /** An optional service (`manifest.uses`); the plugin restarts when it appears or leaves. */
  optionalService<T>(name: string): T | undefined
  /** Load a child plugin owned by this activation; it starts after this plugin is active. */
  plugin<C>(plugin: GuanxiPlugin<C>, config?: C): ChildPlugin
}

export interface GuanxiPlugin<C = unknown> {
  readonly name: string
  readonly manifest: GuanxiManifest
  apply(ctx: PluginContext, config: C): void | Cleanup | Promise<void | Cleanup>
}

export interface PluginHandle {
  readonly pluginId: string
  readonly state: PluginState
  /** Unload and wait until every effect is reverted. */
  dispose(): Promise<void>
}

export interface ChildPlugin extends PluginHandle {
  /** Resolves once the child is active or waiting. Refused inside the parent's apply. */
  ready(): Promise<void>
}

export interface KernelCounters {
  /** Event listeners of all plugins. */
  readonly listeners: number
  /** Plugin fibers that are not disposed. */
  readonly fibers: number
  readonly pending: number
  readonly failed: number
  /** Registered services, kernel services included. */
  readonly services: number
  /** Effects (cleanups) held by all activations. */
  readonly effects: number
  readonly slots: number
  readonly slotEntries: number
  readonly slotSubscribers: number
  readonly slotHolds: number
  /** Slot entries dropped because their slot vanished first (should stay 0). */
  readonly slotOrphans: number
}

/* ─────────────────────────────── Internals ──────────────────────────────── */

const KERNEL_PROVIDER = 'kernel'
export const SLOT_SERVICE_PREFIX = 'slot:'
/** Brand shared across copies of the kernel package (ADR-0022 §8 versioned plugin API). */
export const PLUGIN_BRAND = Symbol.for('guanxi.kernel.plugin')
/** Services only the kernel uses; plugins never read them. */
export const RESERVED_SERVICES: ReadonlySet<string> = new Set(['slots'])

/**
 * True for plugins built by `definePlugin` of any kernel copy. Not a trust
 * decision: every load path also runs `validatePlugin`.
 */
export function isGuanxiPlugin(value: unknown): value is GuanxiPlugin<any> {
  return typeof value === 'object' && value !== null && typeof (value as Record<symbol, unknown>)[PLUGIN_BRAND] === 'string'
}

/** The one check every load path runs: root, child and replacement loads. */
export function validatePlugin(plugin: unknown, action: string): asserts plugin is GuanxiPlugin<any> {
  if (!isGuanxiPlugin(plugin)) throw new TypeError(`${action} accepts only plugins built by definePlugin()`)
  const manifest = parseManifest(plugin.manifest, 'manifest')
  if (manifest.trust === 'T2') throw new PluginContractError(manifest.id, 'T2 plugins run out of process')
  if (!satisfiesEngine(manifest.engines.guanxi)) {
    throw new PluginContractError(
      manifest.id,
      `engines.guanxi "${manifest.engines.guanxi}" does not accept kernel ${KERNEL_API_VERSION}`,
    )
  }
  if (typeof plugin.apply !== 'function') throw new PluginContractError(manifest.id, 'apply is not a function')
}

interface CleanupRecord {
  readonly label: string
  readonly run: Cleanup
  done?: Promise<void>
}

interface ServiceRecord {
  readonly value: unknown
  readonly provider: Fiber | typeof KERNEL_PROVIDER
}

interface Activation {
  readonly epoch: number
  readonly controller: AbortController
  readonly cleanups: CleanupRecord[]
  readonly provisions: Map<string, unknown>
  /** Services this activation read through `requires` or `uses`. */
  readonly bound: Set<string>
  readonly context: PluginContext
}

let fiberSequence = 0

export class Fiber {
  readonly id = ++fiberSequence
  state: PluginState = 'pending'
  error: unknown = undefined
  activation: Activation | null = null
  readonly children = new Set<Fiber>()
  /** Set when an unload is requested; the fiber never starts again. */
  disposing = false
  /** The step the fiber is running, for timeout reports. */
  step = ''
  private attemptedResolve!: () => void
  /** Resolves after the first start attempt (active, waiting, failed) or disposal. */
  readonly attempted = new Promise<void>((resolve) => {
    this.attemptedResolve = resolve
  })
  private disposedResolve!: () => void
  /** Resolves when the fiber is disposed. */
  readonly disposed = new Promise<void>((resolve) => {
    this.disposedResolve = resolve
  })

  readonly plugin: GuanxiPlugin<any>
  config: unknown
  readonly parent: Fiber | null

  constructor(plugin: GuanxiPlugin<any>, config: unknown, parent: Fiber | null) {
    this.plugin = plugin
    this.config = config
    this.parent = parent
  }

  markAttempted(): void {
    this.attemptedResolve()
  }

  markDisposed(): void {
    this.attemptedResolve()
    this.disposedResolve()
  }

  get manifest(): GuanxiManifest {
    return this.plugin.manifest
  }

  /** Services this fiber needs before it can start: requires plus contributed slots. */
  get needs(): string[] {
    return [
      ...this.manifest.requires,
      ...this.manifest.contributes.slots.map((slot) => SLOT_SERVICE_PREFIX + slot),
    ]
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function defaultLog(record: KernelLogRecord): void {
  const line = `[guanxi:kernel] ${record.source}: ${record.message}`
  if (record.level === 'error') console.error(line)
  else console.warn(line)
}

const contextKernels = new WeakMap<object, KernelCore>()

/** The kernel behind a context the kernel created; `undefined` for anything else. */
export function kernelOfContext(ctx: PluginContext): KernelCore | undefined {
  return contextKernels.get(ctx)
}

export class KernelCore {
  readonly services = new Map<string, ServiceRecord>()
  readonly fibers = new Set<Fiber>()
  private readonly events = new Map<string, Set<{ fiber: Fiber; activation: Activation; listener: (...args: any[]) => unknown }>>()
  private queue: Promise<unknown> = Promise.resolve()
  /** Steps abandoned during the running transition. */
  private abandoned: string[] = []
  readonly timeoutMs: number
  readonly log: (record: KernelLogRecord) => void

  constructor(options: KernelOptions = {}) {
    this.timeoutMs = options.stepTimeoutMs ?? 10_000
    this.log = options.onLog ?? defaultLog
  }

  /* ── transitions ─────────────────────────────────────────────────────── */

  /**
   * Run one lifecycle transition after every earlier one. Each plugin step in
   * it is bounded, so the transition always finishes; abandoned steps reject
   * the caller once the kernel is consistent again.
   */
  transition<T>(action: string, task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.abandoned = []
      const result = await task()
      const abandoned = this.abandoned
      this.abandoned = []
      if (abandoned.length) throw new KernelTimeoutError(action, this.timeoutMs, abandoned)
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Steps abandoned so far in the running transition. */
  abandonedSteps(): readonly string[] {
    return [...this.abandoned]
  }

  /**
   * Await one plugin step within the step bound; past it, abandon the step and
   * throw. `onLate` receives the value if an abandoned step completes later.
   */
  private async bounded<T>(
    fiber: Fiber,
    label: string,
    work: () => T | Promise<T>,
    onLate?: (value: T) => void,
  ): Promise<T> {
    fiber.step = label
    let timer: ReturnType<typeof setTimeout> | undefined
    const running = Promise.resolve().then(work)
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (onLate) running.then(onLate, () => undefined)
        const step = `${fiber.manifest.id} (${label})`
        this.abandoned.push(step)
        this.log({ level: 'error', source: fiber.manifest.id, message: `${label} abandoned after ${this.timeoutMs} ms` })
        reject(new KernelTimeoutError(label, this.timeoutMs, [step]))
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([running, bound])
    } finally {
      clearTimeout(timer)
      fiber.step = ''
    }
  }

  /* ── fibers ──────────────────────────────────────────────────────────── */

  createFiber(plugin: GuanxiPlugin<any>, config: unknown, parent: Fiber | null): Fiber {
    const fiber = new Fiber(plugin, config, parent)
    this.fibers.add(fiber)
    parent?.children.add(fiber)
    return fiber
  }

  private satisfied(fiber: Fiber): boolean {
    return fiber.needs.every((name) => this.services.has(name))
  }

  /** Start a fiber if its needs are met; otherwise leave it pending. Inside a transition. */
  async start(fiber: Fiber): Promise<void> {
    try {
      await this.startOnce(fiber)
    } finally {
      fiber.markAttempted()
    }
  }

  private async startOnce(fiber: Fiber): Promise<void> {
    if (fiber.disposing || fiber.state === 'disposed' || fiber.state === 'failed') return
    if (fiber.state === 'active' || fiber.state === 'loading') return
    if (!this.satisfied(fiber)) {
      fiber.state = 'pending'
      return
    }
    const controller = new AbortController()
    const activation: Activation = {
      epoch: (fiber.activation?.epoch ?? 0) + 1,
      controller,
      cleanups: [],
      provisions: new Map(),
      bound: new Set(),
      context: undefined as unknown as PluginContext,
    }
    ;(activation as { context: PluginContext }).context = this.contextFor(fiber, activation)
    contextKernels.set(activation.context, this)
    for (const name of fiber.manifest.requires) activation.bound.add(name)
    for (const name of fiber.manifest.uses) if (this.services.has(name)) activation.bound.add(name)
    fiber.activation = activation
    fiber.state = 'loading'
    fiber.error = undefined
    try {
      const result = await this.bounded(
        fiber,
        'apply',
        () => fiber.plugin.apply(activation.context, fiber.config),
        // An abandoned apply that finishes later may still hand back a cleanup.
        (late) => {
          if (typeof late === 'function') void this.runCleanup(fiber, { label: 'late apply() cleanup', run: late as Cleanup })
        },
      )
      if (typeof result === 'function') activation.cleanups.push({ label: 'apply() cleanup', run: result as Cleanup })
      if (fiber.state !== 'loading' || fiber.activation !== activation) return
      if (controller.signal.aborted) {
        // Unload was requested while apply ran: revert what it registered.
        await this.stop(fiber, fiber.disposing ? 'disposed' : 'pending')
        return
      }
      this.assertProvisions(fiber, activation)
      fiber.state = 'active'
    } catch (error) {
      fiber.error = error
      this.log({ level: 'error', source: fiber.manifest.id, message: describe(error) })
      await this.stop(fiber, 'failed')
      return
    }
    // Children registered during apply start once their parent is active.
    for (const child of fiber.children) await this.start(child)
  }

  /**
   * Unload a fiber to `target`: `pending` (it may start again when its needs
   * return), `failed` or `disposed`. Inside a transition.
   */
  async stop(fiber: Fiber, target: 'pending' | 'failed' | 'disposed'): Promise<void> {
    if (target === 'disposed') fiber.disposing = true
    const activation = fiber.activation
    if (fiber.state === 'disposed' || fiber.state === 'unloading') return
    if (!activation || fiber.state === 'pending' || fiber.state === 'failed') {
      // Nothing is running; only the children of a never-started fiber can exist.
      for (const child of [...fiber.children]) await this.stop(child, 'disposed')
      if (target === 'disposed' || fiber.disposing) this.forget(fiber)
      else if (fiber.state !== 'failed') fiber.state = target
      return
    }
    fiber.state = 'unloading'
    activation.controller.abort(new KernelLifecycleError(`${fiber.manifest.id} is unloading`))

    // Children belong to this activation; dependents of its services leave first.
    for (const child of [...fiber.children]) await this.stop(child, 'disposed')
    for (const dependent of this.dependentsOf(fiber)) await this.stop(dependent, 'pending')

    for (const record of [...activation.cleanups].reverse()) {
      try {
        await this.bounded(fiber, `cleanup ${record.label}`, () => this.runCleanup(fiber, record))
      } catch {
        // Abandoned: logged and reported by bounded(); teardown goes on.
      }
    }
    activation.cleanups.length = 0
    for (const name of activation.provisions.keys()) {
      if (this.services.get(name)?.provider === fiber) this.services.delete(name)
    }
    activation.provisions.clear()
    activation.bound.clear()
    fiber.activation = null
    // A dispose requested meanwhile wins over a temporary unload.
    if (target === 'disposed' || fiber.disposing) this.forget(fiber)
    else fiber.state = target
  }

  /**
   * Dispose a fiber: abort it now, unload it as a transition. A fiber already
   * disposed or being torn down by a running transition (a parent unloading
   * its children) is not queued again; the caller waits for that teardown.
   */
  disposeFiber(fiber: Fiber): Promise<void> {
    if (fiber.state === 'disposed') return Promise.resolve()
    if (fiber.disposing || fiber.state === 'unloading') {
      this.requestDispose(fiber)
      if (fiber.state === 'unloading') return fiber.disposed
    }
    this.requestDispose(fiber)
    return this.transition(`unloading ${fiber.manifest.id}`, async () => {
      await this.stop(fiber, 'disposed')
      await this.settle()
    })
  }

  /**
   * Ask a fiber to unload: abort its activation now, so a running async apply
   * can stop and nothing it registers later is accepted; the unload itself
   * runs as the next transition.
   */
  requestDispose(fiber: Fiber): void {
    fiber.disposing = true
    fiber.activation?.controller.abort(new KernelLifecycleError(`${fiber.manifest.id} is unloading`))
  }

  private forget(fiber: Fiber): void {
    fiber.markDisposed()
    fiber.state = 'disposed'
    fiber.disposing = true
    this.fibers.delete(fiber)
    fiber.parent?.children.delete(fiber)
  }

  private async runCleanup(fiber: Fiber, record: CleanupRecord): Promise<void> {
    record.done ??= (async () => {
      try {
        await record.run()
      } catch (error) {
        this.log({ level: 'error', source: fiber.manifest.id, message: `cleanup "${record.label}" failed: ${describe(error)}` })
      }
    })()
    await record.done
  }

  /** Active or loading fibers bound to a service this fiber provides. */
  private dependentsOf(fiber: Fiber): Fiber[] {
    const provided = new Set(fiber.activation?.provisions.keys() ?? [])
    if (provided.size === 0) return []
    return [...this.fibers].filter((other) => {
      if (other === fiber || !other.activation) return false
      if (other.state !== 'active' && other.state !== 'loading') return false
      return [...other.activation.bound].some((name) => provided.has(name)) ||
        other.needs.some((name) => provided.has(name))
    })
  }

  /**
   * After a transition: start every pending fiber whose needs are met, and
   * restart active fibers whose optional services appeared. Each fiber starts
   * or restarts at most twice per settle, so optional-service cycles cannot
   * loop; a skipped restart is logged.
   */
  async settle(): Promise<void> {
    const attempts = new Map<Fiber, number>()
    const allowed = (fiber: Fiber) => (attempts.get(fiber) ?? 0) < 2
    const count = (fiber: Fiber) => attempts.set(fiber, (attempts.get(fiber) ?? 0) + 1)
    for (;;) {
      let changed = false
      for (const fiber of [...this.fibers]) {
        if (fiber.state === 'pending' && !fiber.disposing && this.satisfied(fiber) && (!fiber.parent || fiber.parent.state === 'active')) {
          if (!allowed(fiber)) continue
          count(fiber)
          await this.start(fiber)
          changed = true
        } else if (fiber.state === 'active' && fiber.activation) {
          const appeared = fiber.manifest.uses.find((name) => this.services.has(name) && !fiber.activation!.bound.has(name))
          if (appeared === undefined) continue
          if (!allowed(fiber)) {
            this.log({ level: 'warn', source: fiber.manifest.id, message: `not restarted for optional "${appeared}": restart cycle` })
            continue
          }
          count(fiber)
          await this.stop(fiber, 'pending')
          await this.start(fiber)
          changed = true
        }
      }
      if (!changed) return
    }
  }

  /* ── contexts ────────────────────────────────────────────────────────── */

  /** The context's own activation is still the fiber's (it may be unloading). */
  private live(fiber: Fiber, activation: Activation, action: string): void {
    if (fiber.activation !== activation) {
      throw new KernelLifecycleError(`${fiber.manifest.id}: cannot ${action}: this plugin activation is over`)
    }
  }

  private current(fiber: Fiber, activation: Activation, action: string): void {
    if (
      fiber.activation !== activation ||
      activation.controller.signal.aborted ||
      (fiber.state !== 'loading' && fiber.state !== 'active')
    ) {
      throw new KernelLifecycleError(
        `${fiber.manifest.id}: cannot ${action}: this plugin activation is ${fiber.activation === activation ? fiber.state : 'over'}`,
      )
    }
  }

  private contextFor(fiber: Fiber, activation: Activation): PluginContext {
    const kernel = this
    const manifest = fiber.manifest
    const context: PluginContext = {
      pluginId: manifest.id,
      manifest,
      signal: activation.controller.signal,
      effect(setup, label = 'effect') {
        kernel.current(fiber, activation, `register effect "${label}"`)
        const cleanup = setup()
        const record: CleanupRecord = { label, run: typeof cleanup === 'function' ? cleanup : () => undefined }
        activation.cleanups.push(record)
        return () => {
          // The record stays in the activation until its cleanup settles, so a
          // teardown that starts meanwhile waits for it (within the step bound).
          const done = kernel.runCleanup(fiber, record)
          void done.then(() => {
            const index = activation.cleanups.indexOf(record)
            if (index !== -1) activation.cleanups.splice(index, 1)
          })
          return done
        }
      },
      on(event, listener) {
        if (event.startsWith('kernel/')) {
          throw new PluginContractError(manifest.id, `"${event}" is reserved for the kernel`)
        }
        kernel.current(fiber, activation, `listen to "${event}"`)
        const entry = { fiber, activation, listener }
        return context.effect(() => {
          const listeners = kernel.events.get(event) ?? new Set()
          listeners.add(entry)
          kernel.events.set(event, listeners)
          return () => {
            const current = kernel.events.get(event)
            current?.delete(entry)
            if (current?.size === 0) kernel.events.delete(event)
          }
        }, `on(${JSON.stringify(event)})`)
      },
      emit(event, ...args) {
        kernel.live(fiber, activation, `emit "${event}"`)
        if (activation.controller.signal.aborted) {
          throw new KernelLifecycleError(`${manifest.id}: cannot emit "${event}": this plugin activation is unloading`)
        }
        kernel.emit(event, args)
      },
      provide(name, value) {
        kernel.current(fiber, activation, `provide "${name}"`)
        if (fiber.state !== 'loading') {
          throw new PluginContractError(manifest.id, `services are provided while loading; "${name}" came too late`)
        }
        const slot = name.startsWith(SLOT_SERVICE_PREFIX) ? name.slice(SLOT_SERVICE_PREFIX.length) : null
        const declared = slot === null ? manifest.provides.includes(name) : manifest.contributes.slotDeclarations.includes(slot)
        if (!declared) throw new PluginContractError(manifest.id, `"${name}" is not in manifest.provides`)
        const existing = kernel.services.get(name)
        if (existing) {
          const owner = existing.provider === KERNEL_PROVIDER ? 'the kernel' : existing.provider.manifest.id
          throw new PluginContractError(manifest.id, `"${name}" is already provided by ${owner}`)
        }
        kernel.services.set(name, { value, provider: fiber })
        activation.provisions.set(name, value)
      },
      service<T>(name: string): T {
        kernel.live(fiber, activation, `read service "${name}"`)
        kernel.assertNotReserved(manifest.id, name)
        if (!manifest.requires.includes(name)) throw new PluginContractError(manifest.id, `"${name}" is not in manifest.requires`)
        const record = kernel.services.get(name)
        if (!record) throw new KernelLifecycleError(`${manifest.id}: service "${name}" is not available`)
        return record.value as T
      },
      optionalService<T>(name: string): T | undefined {
        kernel.live(fiber, activation, `read service "${name}"`)
        kernel.assertNotReserved(manifest.id, name)
        if (!manifest.uses.includes(name)) throw new PluginContractError(manifest.id, `"${name}" is not in manifest.uses`)
        return activation.bound.has(name) ? (kernel.services.get(name)?.value as T | undefined) : undefined
      },
      plugin(child, config) {
        kernel.current(fiber, activation, `load child plugin "${String((child as GuanxiPlugin | undefined)?.manifest?.id)}"`)
        validatePlugin(child, 'ctx.plugin()')
        return kernel.childPlugin(fiber, activation, child, config)
      },
    }
    return Object.freeze(context)
  }

  private childPlugin(parent: Fiber, activation: Activation, plugin: GuanxiPlugin<any>, config: unknown): ChildPlugin {
    const child = this.createFiber(plugin, config, parent)
    const kernel = this
    let started: Promise<void>
    if (parent.state === 'active') {
      started = this.transition(`loading ${plugin.manifest.id}`, async () => {
        await kernel.start(child)
        await kernel.settle()
      })
      started.catch(() => undefined)
    } else {
      // The parent's start() starts its children once its apply returned.
      started = child.attempted
    }
    return {
      pluginId: plugin.manifest.id,
      get state() {
        return child.state
      },
      ready() {
        if (parent.activation === activation && parent.state === 'loading') {
          return Promise.reject(
            new KernelLifecycleError(`${plugin.manifest.id} starts after ${parent.manifest.id}'s apply returns; do not await it inside apply`),
          )
        }
        return started.then(() => {
          if (child.state === 'failed') throw child.error
        })
      },
      dispose: () => kernel.disposeFiber(child),
    }
  }

  emit(event: string, args: readonly unknown[]): void {
    for (const { fiber, activation, listener } of [...(this.events.get(event) ?? [])]) {
      // An activation that is over, or asked to unload, hears nothing more.
      if (fiber.activation !== activation || activation.controller.signal.aborted) continue
      if (fiber.state !== 'active' && fiber.state !== 'loading') continue
      const fail = (error: unknown) =>
        this.log({ level: 'error', source: fiber.manifest.id, message: `listener of "${event}" failed: ${describe(error)}` })
      try {
        const result = listener(...args) as unknown
        // Dispatch stays synchronous; an async listener's rejection is logged, never unhandled.
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          Promise.resolve(result).catch(fail)
        }
      } catch (error) {
        fail(error)
      }
    }
  }

  assertNotReserved(pluginId: string, name: string): void {
    if (RESERVED_SERVICES.has(name) || this.services.get(name)?.provider === KERNEL_PROVIDER) {
      throw new PluginContractError(pluginId, `"${name}" is reserved for the kernel`)
    }
  }

  provideKernelService(name: string, value: unknown): void {
    this.services.set(name, { value, provider: KERNEL_PROVIDER })
  }

  /** The value of a service, as the host sees it (no manifest check). */
  serviceValue<T>(name: string): T | undefined {
    return this.services.get(name)?.value as T | undefined
  }

  listenerCount(): number {
    let count = 0
    for (const listeners of this.events.values()) count += listeners.size
    return count
  }

  assertProvisions(fiber: Fiber, activation: Activation): void {
    const services = new Set<string>()
    const slots = new Set<string>()
    for (const name of activation.provisions.keys()) {
      if (name.startsWith(SLOT_SERVICE_PREFIX)) slots.add(name.slice(SLOT_SERVICE_PREFIX.length))
      else services.add(name)
    }
    const manifest = fiber.manifest
    const missing = manifest.provides.filter((name) => !services.has(name))
    const missingSlots = manifest.contributes.slotDeclarations.filter((name) => !slots.has(name))
    if (missing.length || missingSlots.length) {
      throw new PluginContractError(
        manifest.id,
        [
          missing.length ? `did not provide ${missing.join(', ')}` : '',
          missingSlots.length ? `did not declare slot ${missingSlots.join(', ')}` : '',
        ].filter(Boolean).join('; '),
      )
    }
  }

  effectCount(): number {
    let count = 0
    for (const fiber of this.fibers) count += fiber.activation?.cleanups.length ?? 0
    return count
  }
}
