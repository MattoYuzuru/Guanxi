import { DEFAULT_ALERT_CONFIG } from './types.ts'
import type { Alert, AlertConfig, DependentRun, QuotaFact, WindowState } from './types.ts'

export interface EvaluateQuotaInput {
  fact: QuotaFact
  previous: WindowState | null
  config?: AlertConfig
  dependentRuns?: DependentRun[]
  refusal?: boolean
  /** Caller clock as ISO-8601. The engine never reads the system clock. */
  now: string
}

interface ResolvedConfig {
  thresholds: number[]
  hysteresisPoints: number
}

const MAX_DATE_MS = 8.64e15
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/

/** Parse an ISO instant deterministically: date-only and offsetless values are UTC. */
function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null
  let normalized = value
  if (!normalized.includes('T') && !normalized.includes(' ')) normalized = `${normalized}T00:00:00Z`
  else {
    normalized = normalized.replace(' ', 'T')
    if (!EXPLICIT_OFFSET.test(normalized)) normalized = `${normalized}Z`
  }
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

function parseTimestamp(value: unknown, field: string): number {
  const ms = timestampMs(value)
  if (ms === null) throw new TypeError(`${field} must be a parsable ISO-8601 timestamp`)
  return ms
}

function validatePercent(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError('remainingPercent must be null or a finite number between 0 and 100')
  }
  return value
}

function resolveConfig(config: AlertConfig | undefined): ResolvedConfig {
  const source: unknown = config === undefined ? DEFAULT_ALERT_CONFIG : config
  if (source === null || typeof source !== 'object') throw new TypeError('config must be an object')
  const rawThresholds = (source as { thresholds?: unknown }).thresholds
  if (!Array.isArray(rawThresholds)) throw new TypeError('config.thresholds must be an array')

  const thresholds: number[] = []
  const seen = new Set<number>()
  for (const value of rawThresholds) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 100) {
      throw new TypeError('config.thresholds must contain finite numbers between 0 and 100')
    }
    if (seen.has(value)) throw new TypeError(`config.thresholds must be unique; duplicate ${value}`)
    seen.add(value)
    thresholds.push(value)
  }

  const hysteresis = (source as { hysteresisPoints?: unknown }).hysteresisPoints
  if (typeof hysteresis !== 'number' || !Number.isFinite(hysteresis) || hysteresis < 0) {
    throw new TypeError('config.hysteresisPoints must be a non-negative finite number')
  }
  return { thresholds: thresholds.sort((left, right) => right - left), hysteresisPoints: hysteresis }
}

/** The reset timestamp is the instance identity; a synthetic provider reset appends `#observedAt`. */
function resetKeyOf(instanceKey: string): string {
  const separator = instanceKey.indexOf('#')
  return separator < 0 ? instanceKey : instanceKey.slice(0, separator)
}

/** Equal reset instants keep one instance even when the caller spells the timestamp differently. */
function sameReset(previousBase: string, resetsMs: number | null): boolean {
  if (resetsMs === null) return previousBase === 'no-reset'
  if (previousBase === 'no-reset') return false
  const previousMs = timestampMs(previousBase)
  return previousMs !== null && previousMs === resetsMs
}

function severityFor(threshold: number, sorted: readonly number[]): Alert['severity'] {
  if (sorted.length === 1) return 'warning'
  if (threshold === sorted[sorted.length - 1]) return 'critical'
  if (threshold === sorted[0]) return 'info'
  return 'warning'
}

/** Every dependent ETA must parse; an unparsable ETA is a caller error, not a silent skip. */
function dependentEtas(runs: readonly DependentRun[]): { run: DependentRun; etaMs: number }[] {
  return runs.map(run => ({ run, etaMs: parseTimestamp(run.etaP80, 'dependentRuns.etaP80') }))
}

/** The earliest dependent run that cannot finish before the projected exhaustion, if any. */
function firstOutlivedRun(runs: readonly { run: DependentRun; etaMs: number }[], projectedMs: number): { run: DependentRun; etaMs: number } | null {
  let first: { run: DependentRun; etaMs: number } | null = null
  for (const entry of runs) {
    if (entry.etaMs <= projectedMs || (first !== null && entry.etaMs >= first.etaMs)) continue
    first = entry
  }
  return first
}

/**
 * Evaluate one quota fact against the previous window state. Pure and deterministic: the caller
 * supplies the clock, `previous` is never mutated, and equal input yields equal output.
 *
 * Emits threshold alerts highest-first, then at most one forecast and at most one exhausted
 * alert per window instance.
 */
export function evaluateQuota(input: EvaluateQuotaInput): { state: WindowState; alerts: Alert[] } {
  const { fact, previous, dependentRuns = [], refusal = false } = input
  const config = resolveConfig(input.config)
  const remaining = validatePercent(fact.remainingPercent)
  const observedMs = parseTimestamp(fact.observedAt, 'observedAt')
  const resetsMs = fact.resetsAt === null ? null : parseTimestamp(fact.resetsAt, 'resetsAt')
  // Validate the caller clock even though the rules only compare supplied instants.
  parseTimestamp(input.now, 'now')
  if (fact.connectionId.includes('|')) throw new TypeError('connectionId must not contain "|" (idempotency key separator)')
  const etas = dependentEtas(dependentRuns)

  const baseKey = fact.resetsAt ?? 'no-reset'
  let instanceKey = baseKey
  let prior: WindowState | null = null

  if (previous !== null && previous.connectionId === fact.connectionId && previous.window === fact.window) {
    const previousObservedMs = timestampMs(previous.lastObservedAt)
    if (previousObservedMs !== null && observedMs < previousObservedMs) {
      // Out-of-order delivery: ignore the stale fact, even if it names an older reset instance.
      return { state: previous, alerts: [] }
    }
    if (sameReset(resetKeyOf(previous.instanceKey), resetsMs)) {
      // Compare with the last KNOWN percent so a reset hidden behind an unknown reading is still seen.
      const lastKnown = previous.lastKnownPercent ?? previous.lastPercent
      const providerReset = lastKnown !== null && lastKnown !== undefined && remaining !== null && remaining - lastKnown > 50
      if (providerReset) instanceKey = `${baseKey}#${fact.observedAt}`
      else {
        instanceKey = previous.instanceKey
        prior = previous
      }
    }
  }

  const fired = prior === null ? [] : [...prior.fired]
  const armedBelow = prior === null ? [] : [...prior.armedBelow]
  let forecastFired = prior === null ? false : prior.forecastFired
  let exhaustedFired = prior === null ? false : prior.exhaustedFired
  const alerts: Alert[] = []
  const facts = {
    remainingPercent: remaining,
    resetsAt: fact.resetsAt,
    source: fact.source,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
  }
  const idempotencyKey = (kind: Alert['kind'], threshold: number | null) =>
    `${fact.connectionId}|${fact.window}|${instanceKey}|${kind}|${threshold ?? '-'}`

  let firedChanged = false
  if (remaining !== null) {
    for (const threshold of config.thresholds) {
      if (remaining > threshold || fired.includes(threshold)) continue
      alerts.push({
        kind: 'threshold',
        severity: severityFor(threshold, config.thresholds),
        connectionId: fact.connectionId,
        window: fact.window,
        instanceKey,
        threshold,
        idempotencyKey: idempotencyKey('threshold', threshold),
        facts,
      })
      fired.push(threshold)
      firedChanged = true
    }
  }
  if (firedChanged) fired.sort((left, right) => right - left)

  if (!forecastFired && prior !== null && remaining !== null && prior.lastPercent !== null) {
    const previousObservedMs = timestampMs(prior.lastObservedAt)
    const drop = prior.lastPercent - remaining
    if (previousObservedMs !== null && previousObservedMs < observedMs && drop > 0) {
      const projectedMs = observedMs + Math.floor(remaining * (observedMs - previousObservedMs) / drop)
      if (Number.isFinite(projectedMs) && projectedMs >= -MAX_DATE_MS && projectedMs <= MAX_DATE_MS) {
        const dependent = firstOutlivedRun(etas, projectedMs)
        const beforeDependent = dependent !== null
        const beforeReset = resetsMs !== null && projectedMs < resetsMs
        if (beforeDependent || beforeReset) {
          alerts.push({
            kind: 'forecast',
            severity: 'warning',
            connectionId: fact.connectionId,
            window: fact.window,
            instanceKey,
            threshold: null,
            idempotencyKey: idempotencyKey('forecast', null),
            facts,
            forecast: beforeDependent
              ? { exhaustsAt: new Date(projectedMs).toISOString(), before: 'dependent_run_eta', runId: dependent.run.runId }
              : { exhaustsAt: new Date(projectedMs).toISOString(), before: 'reset' },
          })
          forecastFired = true
        }
      }
    }
  }

  if (refusal === true && !exhaustedFired) {
    alerts.push({
      kind: 'exhausted',
      severity: 'critical',
      connectionId: fact.connectionId,
      window: fact.window,
      instanceKey,
      threshold: null,
      idempotencyKey: idempotencyKey('exhausted', null),
      facts,
    })
    exhaustedFired = true
  }

  return {
    state: {
      connectionId: fact.connectionId,
      window: fact.window,
      instanceKey,
      fired,
      armedBelow,
      lastPercent: remaining,
      lastKnownPercent: remaining ?? (prior === null ? null : (prior.lastKnownPercent ?? prior.lastPercent)),
      lastObservedAt: fact.observedAt,
      forecastFired,
      exhaustedFired,
    },
    alerts,
  }
}
