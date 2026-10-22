/**
 * Quota alert vocabulary for ADR-0033 decision 2. These types are the pure input and output
 * of the rule engine; persistence and delivery belong to later NC1 slices.
 */

/** One quota surface published by a connection (ADR-0033 decision 1). */
export type QuotaWindowKind = 'five_hour' | 'seven_day' | 'daily' | 'monthly' | 'balance' | 'rate_requests' | 'rate_tokens'

/** `observed` comes from a provider; `estimated` is Guanxi's own metering. */
export type Confidence = 'observed' | 'estimated'

/** One immutable observation. Unknown values stay `null`, never zero or a hundred. */
export interface QuotaFact {
  connectionId: string
  window: QuotaWindowKind
  /** 0..100; `null` means unknown. */
  remainingPercent: number | null
  /** Balances: the provider's decimal amount as reported (currency in `source`); windows: tokens; `null` means unknown. */
  remainingAbsolute: number | null
  /** ISO-8601; `null` means no reset (a balance) or unknown. */
  resetsAt: string | null
  /** e.g. `claude-statusline`, `codex-app-server`, `local-meter`. */
  source: string
  /** ISO-8601 observation time. */
  observedAt: string
  confidence: Confidence
}

/** Per-connection thresholds and hysteresis, in percentage points. */
export interface AlertConfig {
  /** Percent-remaining values in (0, 100), unique; evaluated highest first. */
  thresholds: number[]
  /** Reserved for callers that need jitter bookkeeping; fired thresholds never re-arm. */
  hysteresisPoints: number
}

/** ADR-0033 defaults: 20, 10 and 5 percent remaining with two points of hysteresis. */
export const DEFAULT_ALERT_CONFIG: AlertConfig = { thresholds: [20, 10, 5], hysteresisPoints: 2 }

/** Caller-persisted rule state for one connection and window. JSON-serialisable. */
export interface WindowState {
  connectionId: string
  window: QuotaWindowKind
  /** Identifies one window instance; see `evaluateQuota`. */
  instanceKey: string
  /** Thresholds already fired in this instance, sorted descending. */
  fired: number[]
  /** Reserved for hysteresis bookkeeping; preserved within an instance. */
  armedBelow: number[]
  lastPercent: number | null
  /** Last non-null percent in this instance; carried across unknown readings for reset detection. */
  lastKnownPercent?: number | null
  lastObservedAt: string | null
  forecastFired: boolean
  exhaustedFired: boolean
}

export type AlertKind = 'threshold' | 'forecast' | 'exhausted'

/** One alert to append to the durable inbox. The idempotency key is stable per instance. */
export interface Alert {
  kind: AlertKind
  severity: 'info' | 'warning' | 'critical'
  connectionId: string
  window: QuotaWindowKind
  instanceKey: string
  /** The crossed threshold for `threshold` alerts; `null` otherwise. */
  threshold: number | null
  /** `${connectionId}|${window}|${instanceKey}|${kind}|${threshold ?? '-'}` */
  idempotencyKey: string
  /** Provenance invariant: every alert shows its source, time and confidence. */
  facts: {
    remainingPercent: number | null
    resetsAt: string | null
    source: string
    observedAt: string
    confidence: Confidence
  }
  forecast?: {
    exhaustsAt: string
    before: 'reset' | 'dependent_run_eta'
    runId?: string
  }
}

/** A run that depends on the connection; its P80 ETA is an ISO-8601 instant. */
export interface DependentRun {
  runId: string
  etaP80: string
}
