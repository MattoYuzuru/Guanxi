import type { NotificationAction } from './store.ts'
import type { Alert, QuotaFact } from './types.ts'

export interface Recommendation {
  action: NotificationAction
  reason: string
}

export interface RecommendInput {
  fact: QuotaFact
  alerts: readonly Alert[]
  dependentLeads: number
  /** Ordered connection ids/names, best first. */
  fallbacks: readonly string[]
  /** Milliseconds from the observation to the reset, or null when no reset is known. */
  resetsInMs: number | null
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/

/** Offsetless ISO values are UTC, matching the rule engine on every host timezone. */
function isoMs(value: string): number {
  if (!ISO_TIMESTAMP.test(value)) return Number.NaN
  let normalized = value
  if (!normalized.includes('T') && !normalized.includes(' ')) normalized = `${normalized}T00:00:00Z`
  else {
    normalized = normalized.replace(' ', 'T')
    if (!EXPLICIT_OFFSET.test(normalized)) normalized = `${normalized}Z`
  }
  return Date.parse(normalized)
}

function timestampMs(value: string | null, field: string): number | null {
  if (value === null) return null
  const ms = isoMs(value)
  if (!Number.isFinite(ms)) throw new TypeError(`${field} must be an ISO-8601 timestamp or null`)
  return ms
}

/**
 * Deterministic rules from ADR-0033 decision 5. No model, clock or randomness is consulted;
 * equal input produces an equal list in the same order.
 */
export function recommend(input: RecommendInput): Recommendation[] {
  if (input === null || typeof input !== 'object') throw new TypeError('input must be an object')
  if (!Array.isArray(input.alerts)) throw new TypeError('alerts must be an array')
  if (!Number.isInteger(input.dependentLeads) || input.dependentLeads < 0) {
    throw new TypeError('dependentLeads must be a non-negative integer')
  }
  if (!Array.isArray(input.fallbacks) || input.fallbacks.some(fallback => typeof fallback !== 'string' || fallback.length === 0)) {
    throw new TypeError('fallbacks must be an array of non-empty strings')
  }
  if (input.resetsInMs !== null && (!Number.isFinite(input.resetsInMs) || input.resetsInMs < 0)) {
    throw new TypeError('resetsInMs must be null or a non-negative finite number')
  }

  const observedMs = timestampMs(input.fact.observedAt, 'fact.observedAt')
  const resetMs = input.fact.resetsAt === null
    ? (input.resetsInMs === null || observedMs === null ? null : observedMs + input.resetsInMs)
    : timestampMs(input.fact.resetsAt, 'fact.resetsAt')

  let projectedExhaustionMs: number | null = null
  for (const alert of input.alerts) {
    if (alert.kind !== 'forecast' || alert.forecast === undefined) continue
    const exhaustionMs = isoMs(alert.forecast.exhaustsAt)
    if (!Number.isFinite(exhaustionMs)) throw new TypeError('forecast.exhaustsAt must be an ISO-8601 timestamp')
    if (projectedExhaustionMs === null || exhaustionMs < projectedExhaustionMs) {
      projectedExhaustionMs = exhaustionMs
    }
  }

  const recommendations: Recommendation[] = []
  if (
    input.dependentLeads >= 1 &&
    resetMs !== null &&
    projectedExhaustionMs !== null &&
    resetMs < projectedExhaustionMs
  ) {
    recommendations.push({ action: 'snooze', reason: 'Defer lead wakes until the window resets' })
  }
  if (input.fallbacks.length > 0) {
    recommendations.push({
      action: 'switch_connection',
      reason: `Switch to ${input.fallbacks[0]} for future steps`,
    })
  }
  if (resetMs !== null && !recommendations.some(item => item.action === 'snooze')) {
    recommendations.push({ action: 'snooze', reason: 'Snooze until the window resets' })
  }
  return recommendations
}
