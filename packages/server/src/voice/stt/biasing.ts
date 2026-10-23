/**
 * Glossary biasing for STT backends (ADR-0028 decision 2, D-157).
 *
 * The planner maps canonical glossary terms to the mechanism an adapter declared, within the
 * character budget the adapter supplies. It never invents a budget: a prompt mechanism without
 * `maxPromptChars` is a contract error, and a term is never split to make it fit.
 *
 * D-157: a glossary may be sent to a local adapter, or to a cloud adapter only after explicit
 * per-connection consent. When consent is absent the plan carries no prompt; the caller must
 * omit the field rather than send an empty string.
 */

import { createHash } from 'node:crypto'
import { glossaryRevisionHash } from '../marker.ts'
import { foldKey } from '../translit.ts'
import type {
  SttBiasingOutcome,
  SttCapabilities,
  SttConnection,
  SttGlossaryEntry,
} from './types.ts'

export type BiasingOutcome = SttBiasingOutcome

export interface BiasingPlan {
  /** What the adapter actually applied; report this value in the transcription result. */
  outcome: BiasingOutcome
  /** Prompt to send as the backend's `prompt` field. Absent when no field may be sent. */
  prompt?: string
  /** Deduplicated canonical terms that fit in the prompt. */
  included: number
  /** Deduplicated canonical terms dropped by the budget or by D-157 withholding. */
  omitted: number
}

export interface BiasingInput {
  entries: readonly SttGlossaryEntry[]
  capabilities: Pick<SttCapabilities, 'biasing' | 'maxPromptChars'>
  connection: SttConnection
  /** Speech language; it does not change the script of a canonical term. */
  language?: string
}

const MECHANISMS: ReadonlySet<string> = new Set(['initial_prompt', 'hotwords', 'keyterms', 'none'])
const SEPARATORS: Readonly<Record<'initial_prompt' | 'hotwords' | 'keyterms', string>> =
  Object.freeze({ initial_prompt: ', ', hotwords: '\n', keyterms: '\n' })

function compareText(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

function codePointLength(value: string): number {
  return [...value].length
}

/**
 * D-157 gate. Locally hosted audio may use the glossary without a cloud-style consent flag;
 * a cloud connection needs an explicit boolean `glossaryConsent: true`.
 */
export function glossaryAllowed(connection: SttConnection): boolean {
  if (connection === null || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new TypeError('STT connection must be an object')
  }
  if (connection.kind !== 'local' && connection.kind !== 'cloud') {
    throw new TypeError('STT connection kind must be "local" or "cloud"')
  }
  if (typeof connection.glossaryConsent !== 'boolean') {
    throw new TypeError('STT connection glossaryConsent must be a boolean')
  }
  return connection.kind === 'local' || connection.glossaryConsent
}

function validateEntries(entries: readonly SttGlossaryEntry[]): void {
  if (!Array.isArray(entries)) throw new TypeError('Glossary entries must be an array')
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Glossary entry must be an object')
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new TypeError('Glossary entry id must be a non-empty string')
    }
    if (typeof entry.canonical !== 'string' || entry.canonical.trim().length === 0) {
      throw new TypeError('Glossary entry canonical must be a non-empty string')
    }
    if (!Array.isArray(entry.variants)) {
      throw new TypeError('Glossary entry variants must be an array')
    }
  }
}

/**
 * Canonical terms in deterministic prompt order: by folded key, then exact canonical, then id.
 * Duplicate folded keys keep the first sorted entry. Canonicals stay in their stored script, so
 * a Latin canonical remains Latin for Cyrillic speech instead of being transliterated.
 */
export function orderedPromptTerms(entries: readonly SttGlossaryEntry[]): string[] {
  validateEntries(entries)
  const candidates = entries
    .map((entry) => ({
      key: foldKey(entry.canonical.trim()),
      canonical: entry.canonical.trim(),
      id: entry.id,
    }))
    .filter((candidate) => candidate.key.length > 0)
    .sort((first, second) => compareText(first.key, second.key)
      || compareText(first.canonical, second.canonical)
      || compareText(first.id, second.id))
  const seen = new Set<string>()
  const terms: string[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue
    seen.add(candidate.key)
    terms.push(candidate.canonical)
  }
  return terms
}

/**
 * Fit canonical terms into the adapter's character budget. Terms are added in deterministic
 * order; a term that would exceed the budget is skipped whole, and separators count toward the
 * budget because they are sent on the wire. The result is measured in Unicode code points, so a
 * surrogate pair is never split.
 */
function buildPrompt(
  terms: readonly string[],
  separator: string,
  maxPromptChars: number,
): { prompt: string | null; included: number; omitted: number } {
  let prompt = ''
  let included = 0
  for (const term of terms) {
    const next = included === 0 ? term : `${prompt}${separator}${term}`
    if (codePointLength(next) > maxPromptChars) continue
    prompt = next
    included += 1
  }
  return {
    prompt: included === 0 ? null : prompt,
    included,
    omitted: terms.length - included,
  }
}

function validateLimit(value: number | undefined, mechanism: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${mechanism} biasing requires a positive integer maxPromptChars`)
  }
  return value
}

/**
 * Map an effective glossary to the adapter's declared mechanism.
 *
 * Order of decisions:
 * 1. no entries -> `none` (nothing to send or withhold);
 * 2. adapter declares `none` -> `none`;
 * 3. D-157 denies a prompt (cloud without consent) -> `withheld_no_consent`, no prompt;
 * 4. otherwise build a bounded prompt for `initial_prompt`, `hotwords` or `keyterms`.
 *
 * `hotwords` and `keyterms` use one term per line here; an adapter that declares those
 * mechanisms owns its wire format and can map the returned prompt accordingly.
 */
export function planBiasing(input: BiasingInput): BiasingPlan {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Biasing input must be an object')
  }
  validateEntries(input.entries)
  if (input.capabilities === null || typeof input.capabilities !== 'object') {
    throw new TypeError('Biasing capabilities must be an object')
  }
  if (input.language !== undefined
    && (typeof input.language !== 'string' || input.language.trim().length === 0)) {
    throw new TypeError('Biasing language must be a non-empty string when present')
  }
  if (!MECHANISMS.has(input.capabilities.biasing)) {
    throw new TypeError('Biasing mechanism must be initial_prompt, hotwords, keyterms or none')
  }

  // `input.language` is deliberately script-neutral: a Latin canonical stays Latin for Cyrillic
  // speech, and a Cyrillic canonical stays as stored. It is validated above for provenance only.
  const mechanism = input.capabilities.biasing
  const allowed = glossaryAllowed(input.connection)
  const limit = mechanism === 'none'
    ? null
    : validateLimit(input.capabilities.maxPromptChars, mechanism)
  const terms = orderedPromptTerms(input.entries)
  if (terms.length === 0) return { outcome: 'none', included: 0, omitted: 0 }
  if (mechanism === 'none' || limit === null) {
    return { outcome: 'none', included: 0, omitted: terms.length }
  }
  if (!allowed) {
    return { outcome: 'withheld_no_consent', included: 0, omitted: terms.length }
  }

  const fitted = buildPrompt(terms, SEPARATORS[mechanism], limit)
  if (fitted.prompt === null) {
    return { outcome: 'none', included: 0, omitted: fitted.omitted }
  }
  return { outcome: mechanism, prompt: fitted.prompt, included: fitted.included, omitted: fitted.omitted }
}

function canonicalContentEntry(entry: SttGlossaryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    canonical: entry.canonical.trim(),
    variants: entry.variants.map((variant) => variant.trim()).sort(compareText),
    language: entry.language,
    caseSensitive: entry.caseSensitive === true,
    inflect: entry.inflect !== false,
  }
}

/**
 * Stable identifier for the glossary a transcription used.
 *
 * When every supplied entry carries a positive integer `revision` (the shape returned by
 * `GlossaryService.effective`), this is exactly `glossaryRevisionHash` over ids and revisions.
 * Otherwise it is SHA-256 over a canonical content projection, so plain V1-a entries still get
 * a stable marker. The two forms are deliberately distinct: a revision hash never changes when
 * only the content of an already-revised row is edited without a revision bump.
 */
export function glossaryFingerprint(entries: readonly SttGlossaryEntry[]): string {
  validateEntries(entries)
  if (entries.every((entry) => typeof entry.revision === 'number'
    && Number.isSafeInteger(entry.revision) && entry.revision > 0)) {
    return glossaryRevisionHash(entries.map((entry) => ({
      id: entry.id,
      revision: entry.revision as number,
    })))
  }
  const canonical = entries
    .map(canonicalContentEntry)
    .sort((first, second) => compareText(String(first.id), String(second.id)))
  return createHash('sha256')
    .update(JSON.stringify({ kind: 'glossary-content-v1', entries: canonical }))
    .digest('hex')
}
