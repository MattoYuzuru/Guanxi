/**
 * Tracker sync vocabulary (WG2-a).
 *
 * Adapters speak to GitHub Issues and Jira through the injected HTTP transport and the
 * injected `authorize` callback. Neither the engine nor an adapter ever resolves a
 * `secret://` reference or keeps a token value. Business fields belong to the tracker;
 * the only outward writes are one status comment and one Guanxi-owned status label or a
 * mapped Jira transition.
 */
import type { SecretRef } from '../../egress/types.ts'
import type { DerivedStatus } from '../types.ts'

export type TrackerKind = 'github' | 'jira'

/** The derived statuses that may write outward (ADR-0032 §7). */
export const COARSE_STATUSES = ['in_progress', 'blocked', 'failed', 'done'] as const
export type CoarseStatus = (typeof COARSE_STATUSES)[number]

export function isCoarseStatus(status: DerivedStatus): status is CoarseStatus {
  return (COARSE_STATUSES as readonly string[]).includes(status)
}

/** Persisted link between one ledger item and one external issue. */
export interface TrackerLink {
  itemId: string
  tracker: TrackerKind
  /** `owner/repo#123` for GitHub, `PROJ-12` for Jira. */
  externalKey: string
  lastSyncedStatus: DerivedStatus | null
  lastRemoteEtag: string | null
  lastRemoteUpdatedAt: string | null
  lastCommentId: string | null
  /**
   * Monotonic transition counter used in the idempotency marker. Optional on input for
   * compatibility with links persisted before this field existed; absent means zero.
   */
  lastTransitionSeq?: number
}

export type HttpHeaders = Record<string, string>

export interface HttpRequest {
  method: string
  url: string
  headers: HttpHeaders
  body?: string
}

export interface HttpResponse {
  status: number
  headers: HttpHeaders
  body: string
}

/** The only network boundary adapters may use; tests replay recorded fixtures here. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

/**
 * Resolves credentials into the outgoing headers. It may mutate `headers` or return a
 * patch. The adapter passes the object to the transport without reading the result, so a
 * token value exists only in the authorization header.
 */
export type AuthorizeHeaders = (
  headers: HttpHeaders,
) => void | HttpHeaders | Promise<void | HttpHeaders>

export interface TrackerCredentials {
  /** A reference, never the value. Resolution happens inside `authorize`. */
  credential: SecretRef
  authorize: AuthorizeHeaders
}

/** Tracker-owned fields. They are imported, never written back. */
export interface RemoteBusinessFields {
  title: string
  description: string | null
  priority: string | null
  assignee: string | null
  labels: string[]
}

export interface ItemDisplayMetadata extends RemoteBusinessFields {
  itemId: string
  tracker: TrackerKind
  externalKey: string
  fetchedAt: number
}

export interface ConditionalRead {
  etag?: string | null
  updatedAt?: string | null
}

export type RemoteReadResult =
  | { notModified: true }
  | {
      notModified: false
      fields: RemoteBusinessFields
      etag: string | null
      updatedAt: string | null
    }

export interface RemoteComment {
  id: string
  /** Plain text. Jira ADF comment bodies are flattened before they reach the engine. */
  body: string
}

/**
 * The complete outward-write surface. Any other mutation is refused by the adapter with
 * `business_field_write_refused`; there is deliberately no issue-update operation.
 */
export type TrackerMutation =
  | { kind: 'comment'; body: string; marker: string }
  | { kind: 'status-label'; status: CoarseStatus }
  | { kind: 'transition'; status: CoarseStatus }

export type TrackerWriteKind = TrackerMutation['kind']

export interface TrackerWriteResult {
  status: number
  headers: HttpHeaders
  /** True for 429, secondary-limit 403, 5xx and responses carrying `retry-after`. */
  retryable: boolean
  commentId?: string
  /** True when the requested write was already satisfied and no request was sent. */
  skipped?: boolean
}

export interface TrackerAdapter {
  readonly tracker: TrackerKind
  /** Non-secret audit reference; the token is supplied only by `authorize`. */
  readonly credential: SecretRef
  /** Optional: the engine subscribes here to observe every read response. */
  observeReads?(observer: TrackerReadObserver): void
  /** Whether a status maps to a label, a Jira transition, or a comment only. */
  statusMapping(status: CoarseStatus): 'label' | 'transition' | 'none'
  read(externalKey: string, conditional?: ConditionalRead): Promise<RemoteReadResult>
  listComments(externalKey: string): Promise<RemoteComment[]>
  mutate(externalKey: string, mutation: TrackerMutation): Promise<TrackerWriteResult>
}

export type BusinessField = keyof RemoteBusinessFields
export type BusinessFieldValue = string | string[] | null

export interface BusinessFieldChange {
  field: BusinessField
  from: BusinessFieldValue
  to: BusinessFieldValue
}

export interface PollResult {
  link: TrackerLink
  notModified: boolean
  changed: boolean
  changes: BusinessFieldChange[]
  metadata: ItemDisplayMetadata | null
  /** Set when the tracker read was retryable; the caller retries at the exact time. */
  deferred?: SyncDeferral
}

export interface TransitionEvidence {
  /** Evidence URL, normally the accepted commit. */
  url?: string
  commit?: string
  summary?: string
}

export type DeferReason =
  | 'content_budget'
  | 'jira_burst'
  | 'server_backoff'
  | 'secondary_limit'
  | 'retry_after'

export interface SyncWrite {
  kind: TrackerWriteKind
  skipped: boolean
  commentId?: string
}

export interface SyncDeferral {
  reason: DeferReason
  /** Epoch milliseconds. The caller schedules a retry; the engine never sleeps. */
  nextAllowedAt: number
}

export interface SyncResult {
  outcome: 'synced' | 'unchanged' | 'deferred'
  link: TrackerLink
  writes: SyncWrite[]
  commentPosted: boolean
  deferred?: SyncDeferral
}

export type TrackerSyncErrorCode =
  | 'business_field_write_refused'
  | 'invalid_external_key'
  | 'invalid_response'
  | 'invalid_config'
  | 'invalid_mutation'
  | 'authorization_failed'
  | 'remote_rejected'
  | 'rate_limited'
  | 'retryable_response'
  | 'transition_not_found'
  | 'tracker_mismatch'
  | 'invalid_status'

export class TrackerSyncError extends Error {
  readonly code: TrackerSyncErrorCode

  constructor(code: TrackerSyncErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TrackerSyncError'
    this.code = code
  }
}

/** A transport failure contains no cause: an error message could have carried a token. */
export class TrackerTransportError extends TrackerSyncError {
  constructor() {
    super('remote_rejected', 'tracker transport failed')
    this.name = 'TrackerTransportError'
  }
}

/**
 * A read response the caller may retry (429, secondary-limit 403, 5xx). It carries only
 * status and response headers; the engine turns it into a deferral at the exact server time.
 */
export class TrackerRetryableError extends TrackerSyncError {
  readonly status: number
  readonly headers: HttpHeaders

  constructor(status: number, headers: HttpHeaders) {
    super('retryable_response', `tracker read is retryable with status ${status}`)
    this.name = 'TrackerRetryableError'
    this.status = status
    this.headers = { ...headers }
  }
}

/** One read response reported to the engine's rate-limit governor. */
export interface TrackerReadObservation {
  tracker: TrackerKind
  key: string
  status: number
  headers: HttpHeaders
  retryable: boolean
}

export type TrackerReadObserver = (observation: TrackerReadObservation) => void

/** Exact marker checked against existing comments before posting. */
export function transitionMarker(itemId: string, status: CoarseStatus, seq: number): string {
  return `<!-- guanxi:transition:${itemId}:${status}:${seq} -->`
}

export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

/** Case-insensitive header read; transports may preserve server casing. */
export function headerValue(headers: HttpHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}
