/**
 * Component catalog review (D-137, D-138): the owner approves or requests changes from the
 * in-app catalog; the node writes the component's review record and signs approvals with the
 * owner key in the OS keychain. Approvals are written only from a source checkout.
 */
import { z } from 'zod'

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const isoTime = z.string().datetime({ offset: true })
const componentId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/)

/** Policy bound on a review comment: it is signed and committed, so it stays reviewable. */
export const UI_REVIEW_COMMENT_MAX = 4000

export const uiCatalogReadOnlyReasonSchema = z.enum([
  'release_build',
  'not_source_checkout',
  'platform_unsupported',
  'signing_key_missing',
  'signing_key_untrusted',
])
export type UiCatalogReadOnlyReason = z.infer<typeof uiCatalogReadOnlyReasonSchema>

export const uiCatalogReviewCapabilityResponse = z
  .object({
    /** True only when this node can write and sign review records. */
    writable: z.boolean(),
    reason: uiCatalogReadOnlyReasonSchema.nullable(),
    /** The keychain key's id when known; never the key itself. */
    keyId: z.string().nullable(),
    observedAt: isoTime,
  })
  .strict()
export type UiCatalogReviewCapability = z.infer<typeof uiCatalogReviewCapabilityResponse>

export const uiReviewApprovalSchema = z
  .object({
    at: isoTime,
    sourceHash: hash,
    snapshotHashes: z.record(hash),
    comment: z.string(),
    keyId: z.string().min(1),
    signature,
  })
  .strict()

/** The owner's signed "request changes" on an approved record (replay protection). */
export const uiReviewRevocationSchema = z
  .object({ at: isoTime, keyId: z.string().min(1), signature })
  .strict()

export const uiReviewRequestSchema = z
  .object({
    id: z.string().min(1),
    at: isoTime,
    text: z.string(),
    state: z.enum(['open', 'resolved']),
  })
  .strict()

export const uiReviewRecordSchema = z
  .object({
    $schema: z.string().optional(),
    id: componentId,
    status: z.enum(['draft', 'review', 'approved', 'deprecated']),
    approval: uiReviewApprovalSchema.nullable(),
    revocation: uiReviewRevocationSchema.nullable().optional(),
    deprecated: z
      .object({ at: isoTime, replacement: z.string().nullable(), note: z.string() })
      .strict()
      .nullable()
      .optional(),
    requests: z.array(uiReviewRequestSchema),
  })
  .strict()
export type UiReviewRecord = z.infer<typeof uiReviewRecordSchema>

export const uiComponentReviewResponse = z
  .object({
    id: componentId,
    record: uiReviewRecordSchema,
    current: z.object({ sourceHash: hash, snapshotHashes: z.record(hash) }).strict(),
    signature: z.enum(['absent', 'valid', 'invalid']),
    signatureReason: z.string().nullable(),
    status: z.enum(['draft', 'review', 'approved', 'deprecated', 'stale', 'invalid']),
    observedAt: isoTime,
  })
  .strict()
export type UiComponentReview = z.infer<typeof uiComponentReviewResponse>

const reviewBase = {
  /** The source hash the owner saw; a mismatch means the component changed (409). */
  expectedSourceHash: hash,
  expectedSnapshotHashes: z.record(hash),
}

export const uiComponentReviewBody = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('approve'),
      comment: z.string().max(UI_REVIEW_COMMENT_MAX),
      ...reviewBase,
    })
    .strict(),
  z
    .object({
      decision: z.literal('request_changes'),
      comment: z.string().trim().min(1).max(UI_REVIEW_COMMENT_MAX),
      ...reviewBase,
    })
    .strict(),
])
export type UiComponentReviewBody = z.infer<typeof uiComponentReviewBody>
