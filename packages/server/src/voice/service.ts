/**
 * Compiled-glossary service over {@link GlossaryStore}.
 *
 * Effective sets are project entries first, then account entries that the project does not
 * override by canonical term. Compiled glossaries are cached per (account, project) and the
 * cache follows committed store mutations.
 */

import {
  applyGlossary,
  compileGlossary,
  type CompiledGlossary,
  type GlossaryEntry,
  type ReplaceResult,
} from './glossary.ts'
import {
  canonicalEntryKey,
  type GlossaryMutation,
  type GlossaryStore,
  type StoredGlossaryEntry,
} from './store.ts'

export interface EffectiveGlossaryEntry extends GlossaryEntry {
  /** Revision of the stored row this entry came from. */
  revision: number
}

interface CachedGlossary {
  entries: EffectiveGlossaryEntry[]
  compiled: CompiledGlossary
}

function compareRows(first: StoredGlossaryEntry, second: StoredGlossaryEntry): number {
  if (first.createdAt !== second.createdAt) return first.createdAt - second.createdAt
  if (first.id < second.id) return -1
  if (first.id > second.id) return 1
  return 0
}

function toEffective(row: StoredGlossaryEntry): EffectiveGlossaryEntry {
  return { ...row.entry, revision: row.revision }
}

export class GlossaryService {
  private readonly store: GlossaryStore
  private readonly cache = new Map<string, Map<string, CachedGlossary>>()
  private readonly unsubscribe: () => void

  constructor(store: GlossaryStore) {
    this.store = store
    this.unsubscribe = store.onChange((event) => { this.invalidate(event) })
  }

  /** Stop following store mutations and drop the cache. */
  close(): void {
    this.unsubscribe()
    this.cache.clear()
  }

  /**
   * Active project entries for `projectId` first, then active account entries, each ordered by
   * `created_at` and then `id`. An active project entry hides an account entry with the same
   * canonical term (case-insensitive) from this project's effective set.
   */
  effective(accountId: string, projectId: string | null): EffectiveGlossaryEntry[] {
    const cached = this.cached(accountId, projectId)
    if (cached !== undefined) return cached.entries
    const entries = this.buildEffective(accountId, projectId)
    const compiled = compileGlossary(entries)
    this.storeCache(accountId, projectId, { entries, compiled })
    return entries
  }

  /** Apply the effective glossary to `text`; offsets and replacements follow V1-a. */
  apply(accountId: string, projectId: string | null, text: string): ReplaceResult {
    const cached = this.cached(accountId, projectId) ?? this.load(accountId, projectId)
    return applyGlossary(cached.compiled, text)
  }

  private load(accountId: string, projectId: string | null): CachedGlossary {
    const entries = this.buildEffective(accountId, projectId)
    const compiled = compileGlossary(entries)
    const cached = { entries, compiled }
    this.storeCache(accountId, projectId, cached)
    return cached
  }

  private buildEffective(accountId: string, projectId: string | null): EffectiveGlossaryEntry[] {
    const rows = projectId === null
      ? this.store.list(accountId, { includeInactive: false })
        .filter((row) => row.scope === 'account')
      : this.store.list(accountId, { projectId, includeInactive: false })
    const projectRows = projectId === null
      ? []
      : rows.filter((row) => row.scope === 'project' && row.projectId === projectId)
    const accountRows = rows.filter((row) => row.scope === 'account')
    const overridden = new Set(projectRows.map((row) => canonicalEntryKey(row.entry)))
    const entries = [
      ...projectRows.sort(compareRows).map(toEffective),
      ...accountRows.filter((row) => !overridden.has(canonicalEntryKey(row.entry)))
        .sort(compareRows)
        .map(toEffective),
    ]
    for (const entry of entries) Object.freeze(entry)
    return Object.freeze(entries) as EffectiveGlossaryEntry[]
  }

  private cached(accountId: string, projectId: string | null): CachedGlossary | undefined {
    return this.cache.get(accountId)?.get(projectId ?? '')
  }

  private storeCache(accountId: string, projectId: string | null, value: CachedGlossary): void {
    let byProject = this.cache.get(accountId)
    if (byProject === undefined) {
      byProject = new Map()
      this.cache.set(accountId, byProject)
    }
    byProject.set(projectId ?? '', value)
  }

  private invalidate(event: GlossaryMutation): void {
    if (event.scope === 'account') {
      this.cache.delete(event.accountId)
      return
    }
    if (event.projectId === null) return
    const byProject = this.cache.get(event.accountId)
    if (byProject === undefined) return
    byProject.delete(event.projectId)
    if (byProject.size === 0) this.cache.delete(event.accountId)
  }
}
