/** Maps glossary rows and failures to the `@guanxi/contract` wire shapes. */
import {
  glossaryPreviewResponseSchema,
  glossaryRevisionSchema,
  storedGlossaryEntrySchema,
  type GlossaryErrorCode,
  type GlossaryPreviewResponse,
  type StoredGlossaryEntryWire,
} from '@guanxi/contract'
import { commonFailure, wire, type RouteFailure } from '../http/local-guard.ts'
import type { GlossaryEntry, ReplaceResult } from './glossary.ts'
import { glossaryRevisionHash } from './marker.ts'
import { GlossaryStoreError, type GlossaryRevision, type StoredGlossaryEntry } from './store.ts'

function entryWire(entry: GlossaryEntry) {
  return {
    id: entry.id,
    canonical: entry.canonical,
    variants: [...entry.variants],
    language: entry.language,
    ...(entry.caseSensitive === undefined ? {} : { caseSensitive: entry.caseSensitive }),
    ...(entry.inflect === undefined ? {} : { inflect: entry.inflect }),
  }
}

/** The account id stays on the node. */
export function toStoredEntryWire(row: StoredGlossaryEntry): StoredGlossaryEntryWire {
  return wire(storedGlossaryEntrySchema, {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    entry: entryWire(row.entry),
    active: row.active,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export function toRevisionWire(revision: GlossaryRevision) {
  return wire(glossaryRevisionSchema, {
    entryId: revision.entryId,
    revision: revision.revision,
    op: revision.op,
    entry: revision.entry === null ? null : entryWire(revision.entry),
    source: revision.source,
    createdAt: revision.createdAt,
  })
}

export function toPreviewWire(
  result: ReplaceResult,
  effective: ReadonlyArray<{ id: string; revision: number }>,
): GlossaryPreviewResponse {
  return wire(glossaryPreviewResponseSchema, {
    text: result.text,
    replacements: result.replacements.map((item) => ({
      start: item.start, end: item.end, original: item.original, replacement: item.replacement, entryId: item.entryId,
    })),
    glossaryRevision: glossaryRevisionHash(effective.map((entry) => ({ id: entry.id, revision: entry.revision }))),
    entryCount: effective.length,
  })
}

/** A mutation the glossary compiler refused (bad term, collision). Its message is never kept. */
export class GlossaryInvalidError extends Error {
  constructor() {
    super('glossary entry is invalid')
    this.name = 'GlossaryInvalidError'
  }
}

/**
 * The compiler reports bad input as `TypeError`s whose messages quote the user's terms. Only a
 * `TypeError` raised inside a store mutation is the caller's input; anywhere else it is a bug.
 */
export function mutating<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof TypeError) throw new GlossaryInvalidError()
    throw error
  }
}

const FAILURES: Record<string, RouteFailure> = {
  entry_not_found: { code: 'entry_not_found', status: 404 },
  entry_exists: { code: 'entry_exists', status: 409 },
  entry_inactive: { code: 'entry_inactive', status: 409 },
  already_active: { code: 'already_active', status: 409 },
  already_inactive: { code: 'already_inactive', status: 409 },
  id_mismatch: { code: 'validation_failed', status: 400 },
  invalid_scope: { code: 'validation_failed', status: 400 },
  project_required: { code: 'validation_failed', status: 400 },
  invalid_source: { code: 'validation_failed', status: 400 },
  store_closed: { code: 'glossary_unavailable', status: 503 },
}

/**
 * Codes only. Compilation and collision failures arrive as `GlossaryInvalidError` (see
 * `mutating`); a stray `TypeError` is an internal error.
 */
export function glossaryFailure(error: unknown): RouteFailure {
  const common = commonFailure(error)
  if (common !== null) return common
  if (error instanceof GlossaryStoreError) {
    return FAILURES[error.code] ?? { code: 'internal_error' satisfies GlossaryErrorCode, status: 500 }
  }
  if (error instanceof GlossaryInvalidError) return { code: 'glossary_invalid', status: 422 }
  return { code: 'internal_error', status: 500 }
}
