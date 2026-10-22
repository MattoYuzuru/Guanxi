/**
 * Review record (`<id>.review.json`) format, D-138; documented for the DS2 signing helper in
 * docs/design/COMPONENTS_AND_CATALOG.md §4.1. Agents may write `draft` and `review` records,
 * change requests and deprecations; only the owner signs decisions (`approval`, `revocation`).
 * Each signed decision names the digest of the decision it supersedes (`previous`), so the
 * decisions form a hash chain that an unsigned edit cannot shorten. `stale` is derived from
 * hashes and never stored.
 */

export const REVIEW_STATUSES = ['draft', 'review', 'approved', 'deprecated'] as const
export type StoredReviewStatus = (typeof REVIEW_STATUSES)[number]
export type EffectiveReviewStatus = StoredReviewStatus | 'stale' | 'invalid'

export const APPROVAL_SCHEMA = 'guanxi.ui-approval/3'
export const REVOCATION_SCHEMA = 'guanxi.ui-revocation/3'
/**
 * Base64 of exactly 64 bytes: an ECDSA P-256 signature in IEEE P1363 form (r‖s). 64 bytes
 * encode to 86 base64 characters plus "==", so nothing else may ride along in the field.
 */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/
export const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

export interface ReviewApproval {
  at: string
  sourceHash: string
  snapshotHashes: Record<string, string>
  comment: string
  keyId: string
  /** Digest of the signed decision this one supersedes (`decisionDigest`), or null for the first. */
  previous: string | null
  signature: string
}

/**
 * The owner's signed "request changes" on an approved record. It chains to that approval, so
 * restoring the approval later leaves a committed decision unchained, which G12 rejects.
 */
export interface ReviewRevocation {
  at: string
  keyId: string
  previous: string | null
  signature: string
}

export interface ReviewRequest {
  id: string
  at: string
  text: string
  state: 'open' | 'resolved'
}

export interface ReviewDeprecation {
  at: string
  replacement: string | null
  note: string
}

export interface ReviewRecord {
  $schema?: string
  id: string
  status: StoredReviewStatus
  approval: ReviewApproval | null
  revocation?: ReviewRevocation | null
  deprecated?: ReviewDeprecation | null
  requests: ReviewRequest[]
}

/** The exact object the owner key signs. */
export interface ApprovalPayload {
  schema: typeof APPROVAL_SCHEMA
  id: string
  status: 'approved'
  at: string
  sourceHash: string
  snapshotHashes: Record<string, string>
  comment: string
  keyId: string
  previous: string | null
}

export interface RevocationPayload {
  schema: typeof REVOCATION_SCHEMA
  id: string
  decision: 'request_changes'
  at: string
  keyId: string
  previous: string | null
}

export function revocationPayload(id: string, revocation: Omit<ReviewRevocation, 'signature'>): RevocationPayload {
  return {
    schema: REVOCATION_SCHEMA,
    id,
    decision: 'request_changes',
    at: revocation.at,
    keyId: revocation.keyId,
    previous: revocation.previous,
  }
}

export function approvalPayload(id: string, approval: Omit<ReviewApproval, 'signature'>): ApprovalPayload {
  return {
    schema: APPROVAL_SCHEMA,
    id,
    status: 'approved',
    at: approval.at,
    sourceHash: approval.sourceHash,
    snapshotHashes: approval.snapshotHashes,
    comment: approval.comment,
    keyId: approval.keyId,
    previous: approval.previous,
  }
}

export type DecisionKind = 'approval' | 'revocation'

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrevious(value: unknown): boolean {
  return value === null || (typeof value === 'string' && HASH_PATTERN.test(value))
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)
}

const RECORD_KEYS = new Set(['$schema', 'id', 'status', 'approval', 'revocation', 'deprecated', 'requests'])
const APPROVAL_KEYS = new Set(['at', 'sourceHash', 'snapshotHashes', 'comment', 'keyId', 'previous', 'signature'])
const REVOCATION_KEYS = new Set(['at', 'keyId', 'previous', 'signature'])
const REQUEST_KEYS = new Set(['id', 'at', 'text', 'state'])
const DEPRECATION_KEYS = new Set(['at', 'replacement', 'note'])

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `unknown ${where} field "${key}"`)
}

export type ParseResult = { ok: true; record: ReviewRecord } | { ok: false; errors: string[] }

/** Strict structural validation; unknown fields are rejected so nothing unsigned hides in it. */
export function parseReviewRecord(value: unknown, expectedId?: string): ParseResult {
  const errors: string[] = []
  if (!isRecordObject(value)) return { ok: false, errors: ['record is not an object'] }
  for (const key of Object.keys(value)) {
    if (!RECORD_KEYS.has(key)) errors.push(`unknown field "${key}"`)
  }
  const { id, status, approval, revocation, requests, deprecated } = value
  if (typeof id !== 'string' || !COMPONENT_ID_PATTERN.test(id)) errors.push('id is not a component id')
  else if (expectedId !== undefined && id !== expectedId) errors.push(`id "${id}" does not match folder "${expectedId}"`)
  if (!REVIEW_STATUSES.includes(status as StoredReviewStatus)) errors.push('status is not one of draft, review, approved, deprecated')
  if (approval !== null) {
    if (!isRecordObject(approval)) errors.push('approval must be null or an object')
    else {
      for (const key of Object.keys(approval)) {
        if (!APPROVAL_KEYS.has(key)) errors.push(`unknown approval field "${key}"`)
      }
      if (!isIsoTime(approval['at'])) errors.push('approval.at is not an ISO time')
      if (typeof approval['sourceHash'] !== 'string' || !HASH_PATTERN.test(approval['sourceHash'])) {
        errors.push('approval.sourceHash is not sha256:<hex>')
      }
      const snapshots = approval['snapshotHashes']
      if (!isRecordObject(snapshots)) errors.push('approval.snapshotHashes is not an object')
      else {
        for (const [key, hash] of Object.entries(snapshots)) {
          if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) errors.push(`snapshot hash "${key}" is not sha256:<hex>`)
        }
      }
      if (typeof approval['comment'] !== 'string') errors.push('approval.comment is not a string')
      if (typeof approval['keyId'] !== 'string' || approval['keyId'] === '') errors.push('approval.keyId is missing')
      if (!isPrevious(approval['previous'])) errors.push('approval.previous is not null or sha256:<hex>')
      if (typeof approval['signature'] !== 'string' || !SIGNATURE_PATTERN.test(approval['signature'])) {
        errors.push('approval.signature is not a base64 P-256 signature')
      }
    }
  }
  if (revocation !== undefined && revocation !== null) {
    if (!isRecordObject(revocation)) errors.push('revocation must be null or an object')
    else {
      errors.push(...unknownKeys(revocation, REVOCATION_KEYS, 'revocation'))
      if (!isIsoTime(revocation['at'])) errors.push('revocation.at is not an ISO time')
      if (typeof revocation['keyId'] !== 'string' || revocation['keyId'] === '') errors.push('revocation.keyId is missing')
      if (!isPrevious(revocation['previous'])) errors.push('revocation.previous is not null or sha256:<hex>')
      if (typeof revocation['signature'] !== 'string' || !SIGNATURE_PATTERN.test(revocation['signature'])) {
        errors.push('revocation.signature is not a base64 P-256 signature')
      }
    }
  }
  if (deprecated !== undefined && deprecated !== null) {
    if (!isRecordObject(deprecated) || !isIsoTime(deprecated['at']) || typeof deprecated['note'] !== 'string') {
      errors.push('deprecated must be null or { at, replacement, note }')
    } else errors.push(...unknownKeys(deprecated, DEPRECATION_KEYS, 'deprecated'))
  }
  if (!Array.isArray(requests)) errors.push('requests is not an array')
  else {
    requests.forEach((request, index) => {
      if (
        !isRecordObject(request) ||
        typeof request['id'] !== 'string' ||
        !isIsoTime(request['at']) ||
        typeof request['text'] !== 'string' ||
        (request['state'] !== 'open' && request['state'] !== 'resolved')
      ) {
        errors.push(`requests[${index}] must be { id, at, text, state: open | resolved }`)
      } else errors.push(...unknownKeys(request, REQUEST_KEYS, `requests[${index}]`))
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, record: value as unknown as ReviewRecord }
}

const RECORD_SCHEMA_PATH = '../../../catalog/review.schema.json'

/** The one serialisation the node writes; G12 requires signed records to match it exactly. */
export function serialiseRecord(record: ReviewRecord): string {
  const ordered: Record<string, unknown> = {
    $schema: record.$schema ?? RECORD_SCHEMA_PATH,
    id: record.id,
    status: record.status,
    approval: record.approval,
  }
  if (record.revocation !== undefined) ordered['revocation'] = record.revocation
  if (record.deprecated !== undefined) ordered['deprecated'] = record.deprecated
  ordered['requests'] = record.requests
  return `${JSON.stringify(ordered, null, 2)}\n`
}
