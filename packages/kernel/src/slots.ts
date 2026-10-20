/**
 * Typed UI slots (ADR-0022 §3), K1 subset: `list` slots only.
 *
 * Semantics follow DeepSeek Harness's ui-slots model (declaring a slot claims it;
 * contributing to an undeclared slot fails at load; unloading removes every
 * contribution). No DSH code is copied. Declarations are also Cordis services
 * named `slot:<name>`, and contributors inject them (see `definePlugin`), so
 * Cordis orders teardown: contributors unload before the slot's owner, and come
 * back when the owner reloads.
 */
import type { Context } from './cordis.ts'
import { PluginContractError, SLOT_SERVICE_PREFIX, requireManifest } from './plugin.ts'

export type SlotKind = 'list'

export interface ListSlotEntry<T = unknown> {
  /** `<plugin id>/<entry id>`; unique within a slot. */
  readonly key: string
  readonly pluginId: string
  readonly id: string
  readonly order: number
  readonly value: T
}

export interface SlotCounts {
  readonly slots: number
  readonly entries: number
  readonly subscribers: number
}

interface Declaration {
  readonly name: string
  readonly kind: SlotKind
  readonly owner: string
}

interface StoredEntry extends ListSlotEntry {
  readonly sequence: number
}

const EMPTY: readonly ListSlotEntry[] = Object.freeze([])
const ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/

export class SlotRegistry {
  private readonly declarations = new Map<string, Declaration>()
  private readonly entries = new Map<string, Map<string, StoredEntry>>()
  private readonly snapshots = new Map<string, readonly ListSlotEntry[]>()
  private readonly subscribers = new Set<() => void>()
  private sequence = 0
  /** Entries dropped because their slot vanished first; non-zero means a teardown-order bug. */
  orphansDropped = 0

  /** Declare a slot owned by the calling plugin; reverted when it unloads. */
  declare(ctx: Context, name: string, kind: SlotKind = 'list'): void {
    const manifest = requireManifest(ctx, `declareSlot("${name}")`)
    if (!manifest.contributes.slotDeclarations.includes(name)) {
      throw new PluginContractError(manifest.id, `slot "${name}" is not in contributes.slotDeclarations`)
    }
    if (kind !== 'list') {
      throw new PluginContractError(manifest.id, `slot kind "${String(kind)}" is not implemented in K1`)
    }
    const existing = this.declarations.get(name)
    if (existing) {
      throw new PluginContractError(manifest.id, `slot "${name}" is already declared by ${existing.owner}`)
    }
    ctx.effect(() => {
      this.declarations.set(name, { name, kind, owner: manifest.id })
      this.notify(name)
      return () => {
        this.declarations.delete(name)
        const orphans = this.entries.get(name)
        if (orphans?.size) {
          this.orphansDropped += orphans.size
          this.entries.delete(name)
        }
        this.notify(name)
      }
    }, `declareSlot(${JSON.stringify(name)})`)
    ctx.provide(SLOT_SERVICE_PREFIX + name, Object.freeze({ name, kind, owner: manifest.id }))
  }

  /** Contribute one entry to a declared slot; removed when the contributor unloads. */
  contribute<T>(ctx: Context, slot: string, entry: { id: string; order?: number; value: T }): void {
    const manifest = requireManifest(ctx, `contribute("${slot}")`)
    if (!manifest.contributes.slots.includes(slot)) {
      throw new PluginContractError(manifest.id, `slot "${slot}" is not in contributes.slots`)
    }
    if (!this.declarations.has(slot)) {
      throw new PluginContractError(manifest.id, `slot "${slot}" is not declared`)
    }
    if (!ENTRY_ID.test(entry.id)) {
      throw new PluginContractError(manifest.id, `slot entry id "${entry.id}" is invalid`)
    }
    const key = `${manifest.id}/${entry.id}`
    ctx.effect(() => {
      const bucket = this.entries.get(slot) ?? new Map<string, StoredEntry>()
      if (bucket.has(key)) {
        throw new PluginContractError(manifest.id, `slot "${slot}" already has entry "${key}"`)
      }
      const stored: StoredEntry = Object.freeze({
        key,
        pluginId: manifest.id,
        id: entry.id,
        order: entry.order ?? 0,
        value: entry.value,
        sequence: ++this.sequence,
      })
      bucket.set(key, stored)
      this.entries.set(slot, bucket)
      this.notify(slot)
      return () => {
        const current = this.entries.get(slot)
        if (current?.get(key) !== stored) return
        current.delete(key)
        if (current.size === 0) this.entries.delete(slot)
        this.notify(slot)
      }
    }, `contribute(${JSON.stringify(slot)}, ${JSON.stringify(entry.id)})`)
  }

  isDeclared(slot: string): boolean {
    return this.declarations.has(slot)
  }

  /** Entries of a declared slot, ordered; the same array until the slot changes. */
  list<T = unknown>(slot: string): readonly ListSlotEntry<T>[] {
    if (!this.declarations.has(slot)) return EMPTY as readonly ListSlotEntry<T>[]
    let snapshot = this.snapshots.get(slot)
    if (!snapshot) {
      snapshot = Object.freeze(
        [...(this.entries.get(slot)?.values() ?? [])]
          .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
          .map(({ key, pluginId, id, order, value }) => Object.freeze({ key, pluginId, id, order, value })),
      )
      this.snapshots.set(slot, snapshot)
    }
    return snapshot as readonly ListSlotEntry<T>[]
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  counts(): SlotCounts {
    let entries = 0
    for (const bucket of this.entries.values()) entries += bucket.size
    return { slots: this.declarations.size, entries, subscribers: this.subscribers.size }
  }

  private notify(slot: string): void {
    this.snapshots.delete(slot)
    for (const listener of [...this.subscribers]) listener()
  }
}

export const SLOTS_SERVICE = 'slots'

function registry(ctx: Context): SlotRegistry {
  const value = ctx.get(SLOTS_SERVICE) as SlotRegistry | undefined
  if (!value) throw new Error('the kernel slot registry is not available')
  return value
}

export function declareSlot(ctx: Context, name: string, kind: SlotKind = 'list'): void {
  registry(ctx).declare(ctx, name, kind)
}

export function contribute<T>(ctx: Context, slot: string, entry: { id: string; order?: number; value: T }): void {
  registry(ctx).contribute(ctx, slot, entry)
}
