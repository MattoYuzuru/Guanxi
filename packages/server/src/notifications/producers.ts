/**
 * Pure producers that turn a vendor quota observation or a K3 connection balance into the
 * NC1-a `QuotaFact` vocabulary (ADR-0033 decision 1). No clock, storage or delivery lives here:
 * the caller supplies the connection id and persists or evaluates the returned facts.
 */

import { connectionBalanceSchema, type ConnectionBalance } from '@guanxi/contract'
import { quotaObservationSchema, type QuotaObservation } from '../external-agents/types.ts'
import type { Confidence, QuotaFact, QuotaWindowKind } from './types.ts'

/**
 * Why a reported value did not become a fact.
 *
 * - `unknown_window_kind`: the window name is not one this producer can map without guessing.
 *   Codex `primary`/`secondary` names are relative, and `QuotaWindow` carries no period, so
 *   they are not guessed into `five_hour`/`seven_day` here.
 * - `missing_observed_at`: a balance has no observation time and cannot be shown as a fact.
 * - `unknown_confidence`: a balance has unknown confidence and cannot be shown as a fact.
 */
export type QuotaFactSkipReason = 'unknown_window_kind' | 'missing_observed_at' | 'unknown_confidence'

/** One reported value that was intentionally not converted into a fact. */
export interface QuotaFactSkip {
  /** The reported window name; `null` for a balance. */
  window: string | null
  reason: QuotaFactSkipReason
}

/**
 * Producers return facts plus the reports they could not represent. A skipped report is never
 * silently dropped: callers can log its reason or surface it as unknown.
 */
export interface QuotaFactProducerResult {
  facts: QuotaFact[]
  skipped: QuotaFactSkip[]
}

const WINDOW_BY_NAME = new Map<string, QuotaWindowKind>([
  ['five_hour', 'five_hour'],
  ['seven_day', 'seven_day'],
])

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function confidenceOf(value: 'high' | 'medium' | 'low'): Confidence {
  return value === 'high' ? 'observed' : 'estimated'
}

/**
 * Convert one K5 quota observation into facts. Every recognised window becomes one fact.
 * `usedPercent` above 100 is clamped so `remainingPercent` stays in `[0, 100]`; a null
 * `usedPercent` stays unknown (`remainingPercent: null`), never zero or one hundred.
 *
 * Codex `primary`/`secondary` names carry no period in the current `QuotaWindow` contract, so
 * mapping them by name would invent a window kind. They and every other unrecognised name are
 * skipped with `unknown_window_kind`. A future window-length field must be mapped before this
 * producer can accept those names.
 */
export function factsFromQuotaObservation(o: QuotaObservation, connectionId: string): QuotaFactProducerResult {
  const observation = quotaObservationSchema.parse(o)
  const facts: QuotaFact[] = []
  const skipped: QuotaFactSkip[] = []
  for (const window of observation.windows) {
    const kind = WINDOW_BY_NAME.get(window.name)
    if (kind === undefined) {
      skipped.push({ window: window.name, reason: 'unknown_window_kind' })
      continue
    }
    facts.push({
      connectionId,
      window: kind,
      remainingPercent: window.usedPercent === null ? null : clampPercent(100 - window.usedPercent),
      remainingAbsolute: null,
      resetsAt: window.resetsAt,
      source: observation.source,
      observedAt: observation.observedAt,
      confidence: confidenceOf(observation.confidence),
    })
  }
  return { facts, skipped }
}

/**
 * Convert one K3 connection balance into a `balance` fact. The provider's decimal amount is
 * kept as-is: `ConnectionBalance` carries a currency, `QuotaFact` does not, and this producer
 * neither converts minor units nor invents a currency. A percentage is emitted only when the
 * caller supplies a positive finite `initialAmount`; otherwise it stays unknown.
 *
 * A balance without an observation time or with `unknown` confidence cannot be presented as a
 * fact, so it returns no fact and one reason in `skipped`. `scope: 'key_allowance'` is appended
 * to `source` because a key allowance is not an account balance.
 */
export function factFromBalance(
  b: ConnectionBalance,
  connectionId: string,
  opts: { initialAmount?: number | null } = {},
): QuotaFactProducerResult {
  const balance = connectionBalanceSchema.parse(b)
  if (balance.observedAt == null) {
    return { facts: [], skipped: [{ window: null, reason: 'missing_observed_at' }] }
  }
  if (balance.confidence === 'unknown') {
    return { facts: [], skipped: [{ window: null, reason: 'unknown_confidence' }] }
  }

  const { amount } = balance
  const initialAmount = opts.initialAmount
  const remainingPercent = amount !== null && typeof initialAmount === 'number' &&
    Number.isFinite(initialAmount) && initialAmount > 0
    ? clampPercent((amount / initialAmount) * 100)
    : null
  // Scope and currency travel in `source`: an allowance is not an account balance, and an
  // absolute amount is meaningless without its currency.
  const scope = balance.scope ?? 'scope_unknown'
  const currency = balance.currency ?? 'currency_unknown'
  const base = balance.source.replace(/#(key_allowance|account_balance|scope_unknown)?(#[A-Za-z_]+)?$/, '')
  const source = `${base}#${scope}#${currency}`

  return {
    facts: [{
      connectionId,
      window: 'balance',
      remainingPercent,
      remainingAbsolute: amount,
      resetsAt: null,
      source,
      observedAt: balance.observedAt,
      confidence: confidenceOf(balance.confidence),
    }],
    skipped: [],
  }
}
