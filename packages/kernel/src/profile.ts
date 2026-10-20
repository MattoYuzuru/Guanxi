/**
 * Profiles: a node's plugin tree assembled from ordered patch layers
 * (TARGET_ARCHITECTURE §3), e.g. `headless` base + user patch.
 *
 * The layer model follows DeepSeek Harness profiles and `cordis.patch.yml`
 * (insert rows, then patch rows by id). No DSH code is copied. Two deliberate
 * differences from DSH: a patch that names an unknown id fails instead of
 * warning, and any `__jsExpr` value is rejected, because the Cordis loader
 * evaluates it as JavaScript (`new Function` + `eval`) and profile layers are data.
 */

export interface ProfileEntry {
  /** Stable row id, unique in the resolved profile. */
  readonly id: string
  /** Plugin id (a manifest `id`) the row loads. */
  readonly plugin: string
  readonly config?: unknown
  readonly disabled?: boolean
}

export interface ProfilePatch {
  readonly id: string
  /** Replaces the row's config (no deep merge: the patch states the full config). */
  readonly config?: unknown
  readonly disabled?: boolean
  /** Removes the row. */
  readonly remove?: true
}

export interface ProfileLayer {
  /** Name used in error messages, e.g. `profile:headless` or `user:~/.guanxi/profile.json`. */
  readonly name: string
  readonly insert?: readonly ProfileEntry[]
  readonly patch?: readonly ProfilePatch[]
}

export interface ResolvedEntry {
  readonly id: string
  readonly plugin: string
  readonly config: unknown
  readonly disabled: boolean
  /** Layer names that inserted or patched this row, in order. */
  readonly layers: readonly string[]
}

export class ProfileError extends Error {
  readonly layer: string

  constructor(layer: string, message: string) {
    super(`${layer}: ${message}`)
    this.name = 'ProfileError'
    this.layer = layer
  }
}

const ROW_ID = /^[a-z0-9][a-z0-9-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Profile data must be plain JSON; executable loader expressions are refused. */
export function assertPlainData(value: unknown, layer: string, path: string): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ProfileError(layer, `${path} is not a finite number`)
    }
    return
  }
  if (value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainData(item, layer, `${path}[${index}]`))
    return
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProfileError(layer, `${path} is not plain JSON data`)
  }
  if ('__jsExpr' in value) {
    throw new ProfileError(layer, `${path} contains an executable "__jsExpr" expression`)
  }
  for (const [key, item] of Object.entries(value)) assertPlainData(item, layer, `${path}.${key}`)
}

function checkEntry(entry: ProfileEntry, layer: string): void {
  if (!isRecord(entry)) throw new ProfileError(layer, 'insert rows must be objects')
  for (const key of Object.keys(entry)) {
    if (!['id', 'plugin', 'config', 'disabled'].includes(key)) {
      throw new ProfileError(layer, `row "${String(entry.id)}" has unknown field "${key}"`)
    }
  }
  if (typeof entry.id !== 'string' || !ROW_ID.test(entry.id)) {
    throw new ProfileError(layer, `row id "${String(entry.id)}" is invalid`)
  }
  if (typeof entry.plugin !== 'string' || entry.plugin.length === 0) {
    throw new ProfileError(layer, `row "${entry.id}" has no plugin id`)
  }
  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
    throw new ProfileError(layer, `row "${entry.id}" has a non-boolean "disabled"`)
  }
  assertPlainData(entry.config, layer, `${entry.id}.config`)
}

function checkPatch(patch: ProfilePatch, layer: string): void {
  if (!isRecord(patch)) throw new ProfileError(layer, 'patch rows must be objects')
  for (const key of Object.keys(patch)) {
    if (!['id', 'config', 'disabled', 'remove'].includes(key)) {
      throw new ProfileError(layer, `patch "${String(patch.id)}" has unknown field "${key}"`)
    }
  }
  if (typeof patch.id !== 'string') throw new ProfileError(layer, 'a patch needs an id')
  if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') {
    throw new ProfileError(layer, `patch "${patch.id}" has a non-boolean "disabled"`)
  }
  if (patch.remove !== undefined && patch.remove !== true) {
    throw new ProfileError(layer, `patch "${patch.id}" has a non-true "remove"`)
  }
  assertPlainData(patch.config, layer, `${patch.id}.config`)
}

/** Apply layers in order: each layer's inserts, then its patches. */
export function resolveProfile(layers: readonly ProfileLayer[]): ResolvedEntry[] {
  const rows = new Map<string, { entry: ResolvedEntry }>()
  for (const layer of layers) {
    const name = layer.name
    for (const entry of layer.insert ?? []) {
      checkEntry(entry, name)
      if (rows.has(entry.id)) throw new ProfileError(name, `row "${entry.id}" already exists`)
      rows.set(entry.id, {
        entry: {
          id: entry.id,
          plugin: entry.plugin,
          config: structuredClone(entry.config),
          disabled: entry.disabled ?? false,
          layers: [name],
        },
      })
    }
    for (const patch of layer.patch ?? []) {
      checkPatch(patch, name)
      const row = rows.get(patch.id)
      if (!row) throw new ProfileError(name, `patch targets unknown row "${patch.id}"`)
      if (patch.remove) {
        rows.delete(patch.id)
        continue
      }
      row.entry = {
        ...row.entry,
        config: 'config' in patch ? structuredClone(patch.config) : row.entry.config,
        disabled: patch.disabled ?? row.entry.disabled,
        layers: [...row.entry.layers, name],
      }
    }
  }
  return [...rows.values()].map(({ entry }) => Object.freeze({ ...entry, layers: Object.freeze(entry.layers) }))
}
