/**
 * Hand-written declarations for the part of Cordis 4.0.0-rc.11 that the kernel
 * uses. Keep them in sync with the pinned version; nothing outside the kernel
 * sees them except through the facade.
 */

export interface PluginRuntime {
  readonly name?: string
  readonly callback: Function
  readonly fibers: { readonly length: number; [Symbol.iterator](): IterableIterator<Fiber> }
}

export interface ServiceImpl {
  readonly uid: number
  readonly name: string
  readonly ctx: Context
  readonly dependents: Set<Fiber>
  value?: unknown
}

export interface Message {
  readonly sn: number
  readonly ts: number
  readonly name: string
  readonly type: 'error' | 'info' | 'warn' | 'debug'
  readonly level: number
  readonly args: readonly unknown[]
}

export type Disposer = () => unknown

export declare class Fiber {
  private constructor()
  readonly parent: Context
  readonly ctx: Context
  readonly runtime: PluginRuntime | null
  readonly config: unknown
  readonly inject: Readonly<Record<string, unknown>>
  readonly uid: number | null
  readonly state: number
  readonly name: string
  readonly provisions: Set<ServiceImpl>
  readonly inertia: Promise<void> | undefined
  readonly _disposables: { readonly length: number }
  dispose(): Promise<void>
  await(): Promise<this>
  effect(execute: () => unknown, label?: string): Disposer
  getEffects(): Array<{ readonly label: string }>
  restart(): Promise<void>
  update(config: unknown, noSave?: boolean): unknown
}

export declare class Context {
  constructor()
  readonly root: Context
  readonly fiber: Fiber
  baseUrl?: string
  readonly events: { readonly _hooks: Record<PropertyKey, readonly unknown[]> }
  readonly registry: {
    readonly size: number
    values(): IterableIterator<PluginRuntime>
  }
  readonly reflect: { readonly store: Record<PropertyKey, ServiceImpl> }
  readonly logger: unknown
  plugin(plugin: object, config?: unknown): Fiber & PromiseLike<Fiber>
  inject(deps: string[], callback: (ctx: Context) => unknown): Fiber & PromiseLike<Fiber>
  effect(execute: () => unknown, label?: string): Disposer
  on(name: string, listener: (...args: any[]) => unknown): () => boolean
  emit(name: string, ...args: unknown[]): void
  get(name: string, strict?: boolean): unknown
  provide(name: string, value?: unknown): Disposer
  set(name: string, value: unknown): void
  extend(meta?: object): this
}

export declare class RegistryService {
  private constructor()
  readonly ctx: Context
  plugin(plugin: object, config?: unknown, getOuterStack?: () => string[]): Fiber & PromiseLike<Fiber>
}

export declare abstract class Service {
  protected constructor(ctx: Context, name: string)
  protected ctx: Context
  name: string
}

export declare class CordisError extends Error {
  constructor(code: 'INACTIVE_EFFECT', message?: string)
  readonly code: string
}
