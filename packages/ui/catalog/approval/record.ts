/**
 * Review record (`<id>.review.json`) format, D-138. Agents may write `draft` and `review`
 * records and change requests; only the node's approval route writes `approval`, signed with
 * the owner key. `stale` is derived from hashes and never stored.
 */
export const REVIEW_STATUSES = ['draft', 'review', 'approved', 'deprecated'] as const
export type StoredReviewStatus = (typeof REVIEW_STATUSES)[number]
export type EffectiveReviewStatus = StoredReviewStatus | 'stale' | 'invalid'

export const APPROVAL_SCHEMA = 'guanxi.ui-approval/1'
export const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

export interface ReviewApproval {
  at: string
  sourceHash: string
  snapshotHashes: Record<string, string>
  comment: string
  keyId: string
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
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)
}

const RECORD_KEYS = new Set(['$schema', 'id', 'status', 'approval', 'deprecated', 'requests'])
const APPROVAL_KEYS = new Set(['at', 'sourceHash', 'snapshotHashes', 'comment', 'keyId', 'signature'])

export type ParseResult = { ok: true; record: ReviewRecord } | { ok: false; errors: string[] }

/** Strict structural validation; unknown fields are rejected so nothing unsigned hides in it. */
export function parseReviewRecord(value: unknown, expectedId?: string): ParseResult {
  const errors: string[] = []
  if (!isRecordObject(value)) return { ok: false, errors: ['record is not an object'] }
  for (const key of Object.keys(value)) {
    if (!RECORD_KEYS.has(key)) errors.push(`unknown field "${key}"`)
  }
  const { id, status, approval, requests, deprecated } = value
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
      if (typeof approval['signature'] !== 'string' || approval['signature'] === '') errors.push('approval.signature is missing')
    }
  }
  if (deprecated !== undefined && deprecated !== null) {
    if (!isRecordObject(deprecated) || !isIsoTime(deprecated['at']) || typeof deprecated['note'] !== 'string') {
      errors.push('deprecated must be null or { at, replacement, note }')
    }
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
      }
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, record: value as unknown as ReviewRecord }
}
