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
import type { GuanxiManifest } from './manifest.ts'

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
   * Upper bound for one lifecycle transition (default 10 s). Past it the caller
   * gets a KernelTimeoutError naming what is still running, and the kernel
   * refuses further transitions until the stuck one settles.
   */
  readonly transitionTimeoutMs?: number
}

export class KernelLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KernelLifecycleError'
  }
}

export class KernelTimeoutError extends Error {
  /** `<plugin> (<step>)` for everything still running. */
  readonly pending: readonly string[]

  constructor(action: string, timeoutMs: number, pending: readonly string[]) {
    super(`${action} did not finish within ${timeoutMs} ms; still running: ${pending.join('; ') || 'unknown'}`)
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
  readonly listeners: Array<{ event: string; listener: (...args: any[]) => unknown }>
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

export class KernelCore {
  readonly services = new Map<string, ServiceRecord>()
  readonly fibers = new Set<Fiber>()
  private readonly events = new Map<string, Set<{ fiber: Fiber; listener: (...args: any[]) => unknown }>>()
  private queue: Promise<unknown> = Promise.resolve()
  private wedged: KernelTimeoutError | null = null
  private inTransition = false
  readonly timeoutMs: number
  readonly log: (record: KernelLogRecord) => void

  constructor(options: KernelOptions = {}) {
    this.timeoutMs = options.transitionTimeoutMs ?? 10_000
    this.log = options.onLog ?? defaultLog
  }

  /* ── transitions ─────────────────────────────────────────────────────── */

  /** Run one lifecycle transition after every earlier one, within the time bound. */
  transition<T>(action: string, task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.wedged) throw this.wedged
      this.inTransition = true
      const work = task()
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new KernelTimeoutError(action, this.timeoutMs, this.busy())
          this.wedged = error
          this.log({ level: 'error', source: 'kernel', message: error.message })
          // Release the kernel once the stuck step settles after all.
          void work.then(
            () => this.unwedge(error),
            () => this.unwedge(error),
          )
          reject(error)
        }, this.timeoutMs)
      })
      try {
        return await Promise.race([work, bound])
      } finally {
        clearTimeout(timer)
        this.inTransition = false
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private unwedge(error: KernelTimeoutError): void {
    if (this.wedged === error) this.wedged = null
  }

  private busy(): string[] {
    return [...this.fibers]
      .filter((fiber) => fiber.state === 'loading' || fiber.state === 'unloading')
      .map((fiber) => `${fiber.manifest.id} (${fiber.step || fiber.state})`)
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
      listeners: [],
      provisions: new Map(),
      bound: new Set(),
      context: undefined as unknown as PluginContext,
    }
    ;(activation as { context: PluginContext }).context = this.contextFor(fiber, activation)
    for (const name of fiber.manifest.requires) activation.bound.add(name)
    for (const name of fiber.manifest.uses) if (this.services.has(name)) activation.bound.add(name)
    fiber.activation = activation
    fiber.state = 'loading'
    fiber.error = undefined
    fiber.step = 'apply'
    try {
      const result = await fiber.plugin.apply(activation.context, fiber.config)
      if (typeof result === 'function') activation.cleanups.push({ label: 'apply() cleanup', run: result as Cleanup })
      if (fiber.state !== 'loading' || fiber.activation !== activation) return
      if (controller.signal.aborted) {
        // Unload was requested while apply ran: revert what it registered.
        await this.stop(fiber, fiber.disposing ? 'disposed' : 'pending')
        return
      }
      this.assertProvisions(fiber, activation)
      fiber.state = 'active'
      fiber.step = ''
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
      if (target === 'disposed') this.forget(fiber)
      else if (fiber.state !== 'failed') fiber.state = target
      return
    }
    fiber.state = 'unloading'
    activation.controller.abort(new KernelLifecycleError(`${fiber.manifest.id} is unloading`))

    // Children belong to this activation; dependents of its services leave first.
    for (const child of [...fiber.children]) await this.stop(child, 'disposed')
    for (const dependent of this.dependentsOf(fiber)) await this.stop(dependent, 'pending')

    fiber.step = 'cleanup'
    for (const record of [...activation.cleanups].reverse()) {
      fiber.step = `cleanup ${record.label}`
      await this.runCleanup(fiber, record)
    }
    activation.cleanups.length = 0
    for (const { event, listener } of activation.listeners) this.events.get(event)?.forEach((entry) => {
      if (entry.listener === listener && entry.fiber === fiber) this.events.get(event)!.delete(entry)
    })
    activation.listeners.length = 0
    for (const event of [...this.events.keys()]) if (this.events.get(event)!.size === 0) this.events.delete(event)
    for (const name of activation.provisions.keys()) {
      if (this.services.get(name)?.provider === fiber) this.services.delete(name)
    }
    activation.provisions.clear()
    activation.bound.clear()
    fiber.activation = null
    fiber.step = ''
    if (target === 'disposed') this.forget(fiber)
    else fiber.state = target
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
    fiber.markAttempted()
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
   * restart active fibers whose optional services appeared. Repeats until stable.
   */
  async settle(): Promise<void> {
    for (let round = 0; round < 1_000; round += 1) {
      let changed = false
      for (const fiber of [...this.fibers]) {
        if (fiber.state === 'pending' && !fiber.disposing && this.satisfied(fiber) && (!fiber.parent || fiber.parent.state === 'active')) {
          await this.start(fiber)
          changed = true
        } else if (fiber.state === 'active' && fiber.activation) {
          const appeared = fiber.manifest.uses.some((name) => this.services.has(name) && !fiber.activation!.bound.has(name))
          if (appeared) {
            await this.stop(fiber, 'pending')
            await this.start(fiber)
            changed = true
          }
        }
      }
      if (!changed) return
    }
    throw new KernelLifecycleError('plugin activation did not settle (dependency cycle?)')
  }

  /* ── contexts ────────────────────────────────────────────────────────── */

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
        return async () => {
          const index = activation.cleanups.indexOf(record)
          if (index !== -1) activation.cleanups.splice(index, 1)
          await kernel.runCleanup(fiber, record)
        }
      },
      on(event, listener) {
        if (event.startsWith('kernel/')) {
          throw new PluginContractError(manifest.id, `"${event}" is reserved for the kernel`)
        }
        kernel.current(fiber, activation, `listen to "${event}"`)
        const entry = { fiber, listener }
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
        const allowed = manifest.requires.includes(name) || kernel.services.get(name)?.provider === KERNEL_PROVIDER
        if (!allowed) throw new PluginContractError(manifest.id, `"${name}" is not in manifest.requires`)
        const record = kernel.services.get(name)
        if (!record) throw new KernelLifecycleError(`${manifest.id}: service "${name}" is not available`)
        return record.value as T
      },
      optionalService<T>(name: string): T | undefined {
        if (!manifest.uses.includes(name)) throw new PluginContractError(manifest.id, `"${name}" is not in manifest.uses`)
        return activation.bound.has(name) ? (kernel.services.get(name)?.value as T | undefined) : undefined
      },
      plugin(child, config) {
        kernel.current(fiber, activation, `load child plugin "${child.manifest.id}"`)
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
        return started
      },
      dispose: () => {
        kernel.requestDispose(child)
        return kernel.transition(`unloading ${plugin.manifest.id}`, async () => {
          await kernel.stop(child, 'disposed')
          await kernel.settle()
        })
      },
    }
  }

  emit(event: string, args: readonly unknown[]): void {
    for (const { fiber, listener } of [...(this.events.get(event) ?? [])]) {
      try {
        listener(...args)
      } catch (error) {
        this.log({ level: 'error', source: fiber.manifest.id, message: `listener of "${event}" failed: ${describe(error)}` })
      }
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

  get transitioning(): boolean {
    return this.inTransition
  }
}
