/** Maps glossary rows and failures to the `@guanxi/contract` wire shapes. */
import {
  glossaryPreviewResponseSchema,
  glossaryRevisionSchema,
  storedGlossaryEntrySchema,
  type GlossaryErrorCode,
  type GlossaryPreviewResponse,
  type StoredGlossaryEntryWire,
} from '@guanxi/contract'
import { commonFailure, type RouteFailure } from '../http/local-guard.ts'
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
  return storedGlossaryEntrySchema.parse({
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
  return glossaryRevisionSchema.parse({
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
  return glossaryPreviewResponseSchema.parse({
    text: result.text,
    replacements: result.replacements.map((item) => ({
      start: item.start, end: item.end, original: item.original, replacement: item.replacement, entryId: item.entryId,
    })),
    glossaryRevision: glossaryRevisionHash(effective.map((entry) => ({ id: entry.id, revision: entry.revision }))),
    entryCount: effective.length,
  })
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
 * Codes only. Compilation and collision failures are `TypeError`s whose messages quote the
 * user's terms, so the message is dropped and the stable `glossary_invalid` code returned.
 */
export function glossaryFailure(error: unknown): RouteFailure {
  const common = commonFailure(error)
  if (common !== null) return common
  if (error instanceof GlossaryStoreError) {
    return FAILURES[error.code] ?? { code: 'internal_error' satisfies GlossaryErrorCode, status: 500 }
  }
  if (error instanceof TypeError) return { code: 'glossary_invalid', status: 422 }
  return { code: 'internal_error', status: 500 }
}
