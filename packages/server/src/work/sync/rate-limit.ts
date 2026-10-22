/**
 * Pure rate-limit and retry calculator for tracker writes (WG2-a).
 *
 * No timers, no sleeps and no I/O: callers inject the clock, ask whether a write may
 * happen now, and receive the exact epoch millisecond at which it may be retried.
 * GitHub content creation is a token bucket of 80 per minute and 500 per hour (ADR-0032);
 * Jira allows about 20 writes per issue per two seconds. Server headers
 * (`x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after`) override the local budget,
 * and retryable failures use bounded exponential backoff.
 */
import {
  headerValue,
  type DeferReason,
  type HttpHeaders,
  type TrackerKind,
} from './types.ts'

export const GITHUB_CONTENT_PER_MINUTE = 80
export const GITHUB_CONTENT_PER_HOUR = 500
export const GITHUB_MINUTE_WINDOW_MS = 60_000
export const GITHUB_HOUR_WINDOW_MS = 3_600_000
export const JIRA_WRITES_PER_ISSUE = 20
export const JIRA_WRITE_WINDOW_MS = 2_000
export const RETRY_BACKOFF_BASE_MS = 1_000
export const RETRY_BACKOFF_MAX_MS = 60_000
export const SECONDARY_LIMIT_BACKOFF_BASE_MS = 60_000
export const SECONDARY_LIMIT_BACKOFF_MAX_MS = 900_000

/** A token bucket whose refill rate is `capacity / windowMs`. */
export class TokenBucket {
  readonly capacity: number
  readonly windowMs: number
  private tokens: number
  private updatedAt: number | null = null

  constructor(capacity: number, windowMs: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive number')
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be a positive number')
    }
    this.capacity = capacity
    this.windowMs = windowMs
    this.tokens = capacity
  }

  private refill(now: number): void {
    if (this.updatedAt === null) {
      this.updatedAt = now
      return
    }
    if (now <= this.updatedAt) return
    const elapsed = now - this.updatedAt
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs)
    this.updatedAt = now
  }

  /** Fractional tokens available at `now`, refilling lazily. */
  available(now: number): number {
    this.refill(now)
    return this.tokens
  }

  canTake(now: number): boolean {
    this.refill(now)
    return this.tokens + 1e-9 >= 1
  }

  /** Exact earliest moment one token is available. */
  nextAllowedAt(now: number): number {
    this.refill(now)
    if (this.tokens + 1e-9 >= 1) return now
    const missing = Math.max(0, 1 - this.tokens)
    return now + Math.ceil((missing * this.windowMs) / this.capacity)
  }

  take(now: number): void {
    this.refill(now)
    if (this.tokens + 1e-9 < 1) {
      throw new RangeError('token bucket is empty')
    }
    this.tokens = Math.max(0, this.tokens - 1)
  }
}

export interface RateLimitCheck {
  tracker: TrackerKind
  /** GitHub ignores this per-write key; Jira counts per issue. */
  key: string
  /** GitHub's 80/min and 500/h budgets apply only to content creation. */
  contentCreation: boolean
  now?: number
}

export interface RateLimitDecision {
  allowed: boolean
  reason?: DeferReason
  nextAllowedAt: number
}

export interface RateLimitObservation {
  tracker: TrackerKind
  key: string
  status: number
  headers: HttpHeaders
  contentCreation: boolean
  /** Computed by the adapter from status and response headers/body. */
  retryable: boolean
  now?: number
}

export interface RateLimitObservationResult {
  retry: boolean
  reason?: DeferReason
  nextAllowedAt: number
}

export interface RateLimitGovernorOptions {
  now?: () => number
  github?: {
    contentPerMinute?: number
    contentPerHour?: number
    retryBackoffMs?: number
    retryBackoffMaxMs?: number
    secondaryBackoffMs?: number
    secondaryBackoffMaxMs?: number
  }
  jira?: {
    writesPerIssue?: number
    windowMs?: number
    retryBackoffMs?: number
    retryBackoffMaxMs?: number
  }
}

interface JiraState {
  bucket: TokenBucket
  attempts: number
  deferUntil: number
  deferReason: DeferReason
}

interface FailureBudget {
  attempts: number
  deferUntil: number
  reason: DeferReason
}

/** Parses `retry-after` as delta seconds or an HTTP date. Returns milliseconds or null. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (text === '') return null
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.max(0, Math.ceil(Number(text) * 1_000))
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return null
  return Math.max(0, at - now)
}

/** Bounded exponential backoff: `base * 2^(attempt-1)`, capped. */
export function backoffMs(attempt: number, base: number, max: number): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1))
  return Math.min(max, base * 2 ** exponent)
}

function resetAtMs(headers: HttpHeaders): number | null {
  const raw = headerValue(headers, 'x-ratelimit-reset')
  if (raw === undefined) return null
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.ceil(seconds * 1_000)
}

/**
 * A pure governor. `checkWrite` reserves budget only when it returns `allowed`; a denied
 * write consumes nothing and reports the exact next-allowed time. `observeWrite` records
 * server backoff after the adapter receives a response.
 */
export class RateLimitGovernor {
  private readonly clock: () => number
  private readonly githubMinute: TokenBucket
  private readonly githubHour: TokenBucket
  private readonly githubRetryBackoffMs: number
  private readonly githubRetryBackoffMaxMs: number
  private readonly secondaryBackoffMs: number
  private readonly secondaryBackoffMaxMs: number
  private readonly jiraWrites: number
  private readonly jiraWindowMs: number
  private readonly jiraRetryBackoffMs: number
  private readonly jiraRetryBackoffMaxMs: number
  private githubBudget: FailureBudget = { attempts: 0, deferUntil: 0, reason: 'server_backoff' }
  private readonly jira = new Map<string, JiraState>()

  constructor(options: RateLimitGovernorOptions = {}) {
    this.clock = options.now ?? (() => Date.now())
    const github = options.github ?? {}
    this.githubMinute = new TokenBucket(
      github.contentPerMinute ?? GITHUB_CONTENT_PER_MINUTE,
      GITHUB_MINUTE_WINDOW_MS,
    )
    this.githubHour = new TokenBucket(
      github.contentPerHour ?? GITHUB_CONTENT_PER_HOUR,
      GITHUB_HOUR_WINDOW_MS,
    )
    this.githubRetryBackoffMs = github.retryBackoffMs ?? RETRY_BACKOFF_BASE_MS
    this.githubRetryBackoffMaxMs = github.retryBackoffMaxMs ?? RETRY_BACKOFF_MAX_MS
    this.secondaryBackoffMs = github.secondaryBackoffMs ?? SECONDARY_LIMIT_BACKOFF_BASE_MS
    this.secondaryBackoffMaxMs = github.secondaryBackoffMaxMs ?? SECONDARY_LIMIT_BACKOFF_MAX_MS
    const jira = options.jira ?? {}
    this.jiraWrites = jira.writesPerIssue ?? JIRA_WRITES_PER_ISSUE
    this.jiraWindowMs = jira.windowMs ?? JIRA_WRITE_WINDOW_MS
    this.jiraRetryBackoffMs = jira.retryBackoffMs ?? RETRY_BACKOFF_BASE_MS
    this.jiraRetryBackoffMaxMs = jira.retryBackoffMaxMs ?? RETRY_BACKOFF_MAX_MS
  }

  private jiraState(key: string): JiraState {
    const existing = this.jira.get(key)
    if (existing) return existing
    const created: JiraState = {
      bucket: new TokenBucket(this.jiraWrites, this.jiraWindowMs),
      attempts: 0,
      deferUntil: 0,
      deferReason: 'server_backoff',
    }
    this.jira.set(key, created)
    return created
  }

  checkWrite(input: RateLimitCheck): RateLimitDecision {
    const now = input.now ?? this.clock()
    if (input.tracker === 'github') {
      const serverNext = this.githubBudget.deferUntil
      let budgetNext = now
      if (input.contentCreation) {
        budgetNext = Math.max(
          this.githubMinute.nextAllowedAt(now),
          this.githubHour.nextAllowedAt(now),
        )
      }
      const next = Math.max(serverNext, budgetNext)
      if (next > now) {
        const reason: DeferReason = serverNext >= budgetNext
          ? this.githubBudget.reason
          : 'content_budget'
        return { allowed: false, reason, nextAllowedAt: next }
      }
      if (input.contentCreation) {
        this.githubMinute.take(now)
        this.githubHour.take(now)
      }
      return { allowed: true, nextAllowedAt: now }
    }

    const state = this.jiraState(input.key)
    const budgetNext = state.bucket.nextAllowedAt(now)
    const next = Math.max(state.deferUntil, budgetNext)
    if (next > now) {
      const reason: DeferReason = state.deferUntil >= budgetNext ? state.deferReason : 'jira_burst'
      return { allowed: false, reason, nextAllowedAt: next }
    }
    state.bucket.take(now)
    return { allowed: true, nextAllowedAt: now }
  }

  observeWrite(input: RateLimitObservation): RateLimitObservationResult {
    const now = input.now ?? this.clock()
    const retryAfter = parseRetryAfter(headerValue(input.headers, 'retry-after'), now)
    const reset = resetAtMs(input.headers)
    const remaining = headerValue(input.headers, 'x-ratelimit-remaining')

    if (input.status >= 200 && input.status < 300) {
      this.resetAttempts(input.tracker, input.key)
      if (retryAfter !== null && retryAfter > 0) {
        this.setDefer(input.tracker, input.key, now + retryAfter, 'retry_after')
      } else if (input.tracker === 'github' && remaining === '0') {
        const until = reset ?? now + this.githubRetryBackoffMaxMs
        this.setDefer('github', input.key, until, 'server_backoff')
      }
      return { retry: false, nextAllowedAt: now }
    }

    if (!input.retryable) return { retry: false, nextAllowedAt: now }

    const isSecondary = input.status === 403
    const base = isSecondary ? this.secondaryBackoffMs : this.retryBase(input.tracker)
    const max = isSecondary ? this.secondaryBackoffMaxMs : this.retryMax(input.tracker)
    const attempts = this.bumpAttempts(input.tracker, input.key)
    const exponential = backoffMs(attempts, base, max)
    const headerDelay = retryAfter ?? (reset !== null && reset > now ? reset - now : null)
    const delay = headerDelay !== null ? headerDelay : exponential
    const reason: DeferReason = retryAfter !== null
      ? 'retry_after'
      : isSecondary
        ? 'secondary_limit'
        : 'server_backoff'
    this.setDefer(input.tracker, input.key, now + Math.max(0, delay), reason)
    return { retry: true, reason, nextAllowedAt: now + Math.max(0, delay) }
  }

  /** Network failure on an ambiguous write: treat as a bounded 5xx-style retry. */
  observeTransportFailure(input: {
    tracker: TrackerKind
    key: string
    now?: number
  }): RateLimitObservationResult {
    const now = input.now ?? this.clock()
    const base = this.retryBase(input.tracker)
    const max = this.retryMax(input.tracker)
    const attempts = this.bumpAttempts(input.tracker, input.key)
    const delay = backoffMs(attempts, base, max)
    this.setDefer(input.tracker, input.key, now + delay, 'server_backoff')
    return { retry: true, reason: 'server_backoff', nextAllowedAt: now + delay }
  }

  /** Earliest time a write could pass, without consuming budget. */
  nextAllowedAt(input: Omit<RateLimitCheck, 'now'> & { now?: number }): number {
    const now = input.now ?? this.clock()
    if (input.tracker === 'github') {
      const budget = input.contentCreation
        ? Math.max(this.githubMinute.nextAllowedAt(now), this.githubHour.nextAllowedAt(now))
        : now
      return Math.max(this.githubBudget.deferUntil, budget)
    }
    const state = this.jiraState(input.key)
    return Math.max(state.deferUntil, state.bucket.nextAllowedAt(now))
  }

  private retryBase(tracker: TrackerKind): number {
    return tracker === 'jira' ? this.jiraRetryBackoffMs : this.githubRetryBackoffMs
  }

  private retryMax(tracker: TrackerKind): number {
    return tracker === 'jira' ? this.jiraRetryBackoffMaxMs : this.githubRetryBackoffMaxMs
  }

  private bumpAttempts(tracker: TrackerKind, key: string): number {
    if (tracker === 'github') {
      this.githubBudget.attempts += 1
      return this.githubBudget.attempts
    }
    const state = this.jiraState(key)
    state.attempts += 1
    return state.attempts
  }

  private resetAttempts(tracker: TrackerKind, key: string): void {
    if (tracker === 'github') {
      this.githubBudget.attempts = 0
      return
    }
    this.jiraState(key).attempts = 0
  }

  private setDefer(
    tracker: TrackerKind,
    key: string,
    until: number,
    reason: DeferReason,
  ): void {
    if (tracker === 'github') {
      this.githubBudget.deferUntil = Math.max(this.githubBudget.deferUntil, until)
      this.githubBudget.reason = reason
      return
    }
    const state = this.jiraState(key)
    state.deferUntil = Math.max(state.deferUntil, until)
    state.deferReason = reason
  }
}
