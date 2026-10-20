/** Hand-written declarations for the @cordisjs/plugin-loader 1.0.0-rc.8 surface the kernel uses. */
import type { Context, Fiber } from './cordis-runtime.js'

export interface LoaderEntryOptions {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
}

export declare class Loader {
  constructor(ctx: Context, config?: { baseUrl?: string })
  readonly ctx: Context
  readonly builtins: Record<string, unknown>
  readonly root: { update(config: LoaderEntryOptions[]): Promise<void> }
  readonly store: Record<string, { fiber?: Fiber; options: LoaderEntryOptions } | undefined>
  remove(id: string): void
  create(options: LoaderEntryOptions): Promise<string>
  await(): Promise<void>
}
