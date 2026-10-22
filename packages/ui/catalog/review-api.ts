import type { EffectiveReviewStatus, ReviewRecord } from './approval/record.ts'

/** Mirrors the contract's UiCatalogReadOnlyReason; the web adapter maps one onto the other. */
export type ReadOnlyReason =
  | 'release_build'
  | 'not_source_checkout'
  | 'platform_unsupported'
  | 'signing_key_missing'
  | 'signing_key_untrusted'
  | 'signer_helper_missing'

export interface ReviewCapability {
  writable: boolean
  reason: ReadOnlyReason | null
  keyId: string | null
}

export interface ReviewState {
  id: string
  record: ReviewRecord
  current: { sourceHash: string; snapshotHashes: Record<string, string> }
  signature: 'absent' | 'valid' | 'invalid'
  status: EffectiveReviewStatus
}

export interface ReviewSubmitBody {
  decision: 'approve' | 'request_changes'
  comment: string
  expectedSourceHash: string
  expectedSnapshotHashes: Record<string, string>
}

export type ReviewFailure = 'conflict' | 'signer_unavailable' | 'read_only' | 'failed'

export class ReviewApiError extends Error {
  readonly kind: ReviewFailure

  constructor(kind: ReviewFailure, message: string) {
    super(message)
    this.name = 'ReviewApiError'
    this.kind = kind
  }
}

/** The node's catalog review API, injected by the host app (web) so this package stays I/O-free. */
export interface ReviewApi {
  capability(signal?: AbortSignal): Promise<ReviewCapability>
  get(id: string, signal?: AbortSignal): Promise<ReviewState>
  submit(id: string, body: ReviewSubmitBody): Promise<ReviewState>
}
