/**
 * Pure model of the voice glossary editor: form drafts, validation against the wire contract,
 * view grouping, the derived "overridden" mark, preview highlighting and error classification.
 * Nothing here reads the DOM or the network, and nothing returns display text: messages are
 * locale keys with values, so the page translates them in one place.
 */
import { ZodError } from 'zod'
import {
  GLOSSARY_PREVIEW_MAX_CHARS,
  glossaryEntryBodySchema,
  type GlossaryEntryBody,
  type GlossaryErrorCode,
  type GlossaryPreviewResponse,
  type StoredGlossaryEntryWire,
} from '@guanxi/contract'
import { LocalApiError, LocalApiShapeError } from '../../lib/local-api.ts'
import type { LocaleKey } from '../../lib/locale.ts'

export type GlossaryLanguage = GlossaryEntryBody['language']
export type GlossaryScope = StoredGlossaryEntryWire['scope']

export interface EntryDraft {
  scope: GlossaryScope
  projectId: string
  canonical: string
  /** One spoken form per line. */
  variants: string
  language: GlossaryLanguage
  caseSensitive: boolean
  inflect: boolean
}

export const emptyDraft = (projectId = ''): EntryDraft => ({
  scope: projectId === '' ? 'account' : 'project',
  projectId,
  canonical: '',
  variants: '',
  language: 'en',
  caseSensitive: false,
  inflect: true,
})

export const draftFromEntry = (stored: StoredGlossaryEntryWire): EntryDraft => ({
  scope: stored.scope,
  projectId: stored.projectId ?? '',
  canonical: stored.entry.canonical,
  variants: stored.entry.variants.join('\n'),
  language: stored.entry.language,
  caseSensitive: stored.entry.caseSensitive === true,
  inflect: stored.entry.inflect !== false,
})

export const splitVariants = (text: string): string[] =>
  text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')

/** The wire body: a flag is sent only when it differs from the default, so entries stay minimal. */
export function bodyFromDraft(draft: EntryDraft): GlossaryEntryBody {
  return {
    canonical: draft.canonical.trim(),
    variants: splitVariants(draft.variants),
    language: draft.language,
    ...(draft.caseSensitive ? { caseSensitive: true } : {}),
    ...(draft.inflect ? {} : { inflect: false }),
  }
}

export interface Message { key: LocaleKey; values?: Record<string, string | number> }
export interface FieldErrors { canonical?: Message; variants?: Message; project?: Message }

/** Validates with the contract schema itself, so the limits cannot drift from the node's. */
export function validateDraft(draft: EntryDraft, projectRequired: boolean): FieldErrors {
  const errors: FieldErrors = {}
  if (projectRequired && draft.projectId === '') errors.project = { key: 'voiceGlossary.validation.project.required' }
  const body = bodyFromDraft(draft)
  const parsed = glossaryEntryBodySchema.safeParse(body)
  if (parsed.success) return errors
  for (const issue of parsed.error.issues) {
    const [field, index] = issue.path
    if (field === 'canonical' && errors.canonical === undefined) {
      errors.canonical = issue.code === 'too_big'
        ? { key: 'voiceGlossary.validation.canonical.long', values: { limit: Number(issue.maximum) } }
        : { key: 'voiceGlossary.validation.canonical.required' }
    } else if (field === 'variants' && errors.variants === undefined) {
      errors.variants = typeof index === 'number'
        ? { key: 'voiceGlossary.validation.variants.long', values: { limit: Number(issue.code === 'too_big' ? issue.maximum : 0), line: index + 1 } }
        : { key: 'voiceGlossary.validation.variants.many', values: { limit: Number(issue.code === 'too_big' ? issue.maximum : 0) } }
    }
  }
  return errors
}

export const hasErrors = (errors: FieldErrors): boolean => Object.keys(errors).length > 0

export const draftsEqual = (a: EntryDraft, b: EntryDraft): boolean =>
  a.scope === b.scope && a.projectId === b.projectId && a.canonical === b.canonical && a.variants === b.variants
  && a.language === b.language && a.caseSensitive === b.caseSensitive && a.inflect === b.inflect

/* ───────────────────────────── view grouping ───────────────────────────── */

export interface EntryGroup {
  key: string
  scope: GlossaryScope
  projectId: string | null
  entries: StoredGlossaryEntryWire[]
}

const byTerm = (a: StoredGlossaryEntryWire, b: StoredGlossaryEntryWire) =>
  a.entry.canonical.localeCompare(b.entry.canonical, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)

/** Account entries first, then one group per project ordered by its name (or id when unnamed). */
export function groupEntries(entries: readonly StoredGlossaryEntryWire[], projectNames: ReadonlyMap<string, string>): EntryGroup[] {
  const account = entries.filter((entry) => entry.scope === 'account').sort(byTerm)
  const projects = new Map<string, StoredGlossaryEntryWire[]>()
  for (const entry of entries) {
    if (entry.scope !== 'project' || entry.projectId === null) continue
    projects.set(entry.projectId, [...(projects.get(entry.projectId) ?? []), entry])
  }
  const name = (id: string) => projectNames.get(id) ?? id
  const groups: EntryGroup[] = []
  if (account.length > 0) groups.push({ key: 'account', scope: 'account', projectId: null, entries: account })
  for (const id of [...projects.keys()].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }) || a.localeCompare(b))) {
    groups.push({ key: `project:${id}`, scope: 'project', projectId: id, entries: (projects.get(id) ?? []).sort(byTerm) })
  }
  return groups
}

/**
 * ADR-0028 / store rule: inside one project an active project entry with the same canonical
 * term (case-insensitive) hides the account entry. Derived on the client from the listed entries,
 * and only meaningful for a single-project view.
 */
export function overriddenAccountEntryIds(entries: readonly StoredGlossaryEntryWire[], projectId: string): Set<string> {
  const canonical = (entry: StoredGlossaryEntryWire) => entry.entry.canonical.toLowerCase()
  const hiding = new Set(entries.filter((entry) => entry.scope === 'project' && entry.projectId === projectId && entry.active).map(canonical))
  return new Set(entries.filter((entry) => entry.scope === 'account' && entry.active && hiding.has(canonical(entry))).map((entry) => entry.id))
}

/** Whether `entry` belongs in the view for `projectId` ('' is the full view). */
export const inView = (entry: StoredGlossaryEntryWire, projectId: string, showInactive: boolean): boolean =>
  (showInactive || entry.active) && (projectId === '' || entry.scope === 'account' || entry.projectId === projectId)

/* ───────────────────────────── preview ───────────────────────────── */

export interface PreviewSegment { text: string; replaced: boolean }

export const previewTooLong = (text: string): boolean => text.length > GLOSSARY_PREVIEW_MAX_CHARS
export const PREVIEW_LIMIT = GLOSSARY_PREVIEW_MAX_CHARS

/**
 * Splits the replaced text into plain and replaced runs. The node reports offsets into the
 * original text; the output offsets follow from the cumulative length change. The mapping is
 * verified against the returned text, and if it does not hold the result is shown unhighlighted
 * rather than highlighted in the wrong place.
 */
export function previewSegments(result: Pick<GlossaryPreviewResponse, 'text' | 'replacements'>): { segments: PreviewSegment[]; highlighted: boolean } {
  const plain = { segments: [{ text: result.text, replaced: false }], highlighted: false }
  const ordered = [...result.replacements].sort((a, b) => a.start - b.start)
  const segments: PreviewSegment[] = []
  let delta = 0
  let cursor = 0
  let previousEnd = 0
  for (const replacement of ordered) {
    if (replacement.start < previousEnd || replacement.end < replacement.start) return plain
    const start = replacement.start + delta
    const end = start + replacement.replacement.length
    if (start < cursor || end > result.text.length || result.text.slice(start, end) !== replacement.replacement) return plain
    if (start > cursor) segments.push({ text: result.text.slice(cursor, start), replaced: false })
    segments.push({ text: result.text.slice(start, end), replaced: true })
    cursor = end
    previousEnd = replacement.end
    delta += replacement.replacement.length - (replacement.end - replacement.start)
  }
  if (cursor < result.text.length) segments.push({ text: result.text.slice(cursor), replaced: false })
  return segments.length === 0 ? plain : { segments, highlighted: ordered.length > 0 }
}

/* ───────────────────────────── history ───────────────────────────── */

type WireEntry = StoredGlossaryEntryWire['entry']
export type ChangedField = 'canonical' | 'variants' | 'language' | 'caseSensitive' | 'inflect'

export function changedFields(previous: WireEntry | null, current: WireEntry | null): ChangedField[] {
  if (previous === null || current === null) return []
  const changed: ChangedField[] = []
  if (previous.canonical !== current.canonical) changed.push('canonical')
  if (previous.variants.length !== current.variants.length || previous.variants.some((value, index) => value !== current.variants[index])) changed.push('variants')
  if (previous.language !== current.language) changed.push('language')
  if ((previous.caseSensitive === true) !== (current.caseSensitive === true)) changed.push('caseSensitive')
  if ((previous.inflect !== false) !== (current.inflect !== false)) changed.push('inflect')
  return changed
}

/* ───────────────────────────── errors ───────────────────────────── */

export type FailureCode = GlossaryErrorCode | 'unexpected_response' | 'shape' | 'unreachable'
export interface Failure { code: FailureCode; at: string }

// Machine discriminants stay typed references so no display string is a function return.
const CODE = { shape: 'shape', invalid: 'validation_failed', unreachable: 'unreachable' } as const satisfies Record<string, FailureCode>

/** `unreachable`: no HTTP answer at all. Everything else is the node (or a bad body) speaking. */
export function classify(error: unknown): FailureCode {
  if (error instanceof LocalApiError) return error.code
  if (error instanceof LocalApiShapeError) return CODE.shape
  if (error instanceof ZodError) return CODE.invalid
  return CODE.unreachable
}

const REFUSED = 'voiceGlossary.error.refused'
const MESSAGE_KEYS = {
  validation_failed: 'voiceGlossary.error.validation_failed',
  json_required: REFUSED,
  origin_denied: REFUSED,
  loopback_only: REFUSED,
  body_too_large: 'voiceGlossary.error.body_too_large',
  entry_not_found: 'voiceGlossary.error.entry_not_found',
  entry_exists: 'voiceGlossary.error.entry_exists',
  entry_inactive: 'voiceGlossary.error.entry_inactive',
  already_active: 'voiceGlossary.error.already_active',
  already_inactive: 'voiceGlossary.error.already_inactive',
  glossary_invalid: 'voiceGlossary.error.glossary_invalid',
  glossary_unavailable: 'voiceGlossary.error.glossary_unavailable',
  internal_error: 'voiceGlossary.error.internal_error',
  unexpected_response: 'voiceGlossary.error.unexpected_response',
  shape: 'voiceGlossary.error.shape',
} as const satisfies Record<Exclude<FailureCode, 'unreachable'>, LocaleKey>
const UNREACHABLE_KEYS = {
  read: 'voiceGlossary.error.unreachable.read',
  write: 'voiceGlossary.error.unreachable.write',
} as const satisfies Record<'read' | 'write', LocaleKey>

/** The sentence that explains a failure. It never contains a term: the node does not echo any. */
export const failureMessage = (code: FailureCode, intent: 'read' | 'write'): LocaleKey =>
  code === 'unreachable' ? UNREACHABLE_KEYS[intent] : MESSAGE_KEYS[code]
