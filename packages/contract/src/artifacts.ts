import { z } from 'zod'
import { projectReferenceSchema } from './project-reference.ts'

export const ARTIFACT_VERSION = 1 as const
export const ATTACHMENT_VERSION = 1 as const
export const ARTIFACT_TRANSFER_POLICY_VERSION = 1 as const

export const artifactIdSchema = z.string().uuid()
export const artifactWriteIntentKeySchema = z.string().uuid()

export const artifactKindSchema = z.enum([
  'text',
  'reasoning',
  'transcript',
  'image',
  'audio',
  'video',
  'document',
  'structured',
  'embedding',
  'file',
  'checkpoint',
  'report',
])
export type ArtifactKind = z.infer<typeof artifactKindSchema>

/** Canonical lower-case media type; parameters use one explicit SP separator. */
export const artifactMediaTypeSchema = z
  .string()
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:; [a-z0-9][a-z0-9!#$&^_.+-]{0,62}=[a-z0-9][a-z0-9!#$&^_.+:-]{0,126})*$/u,
  )

export const artifactScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('projectless') }).strict(),
  z.object({ scope: z.literal('project'), projectId: projectReferenceSchema }).strict(),
])
export type ArtifactScope = z.infer<typeof artifactScopeSchema>

export const artifactSourceSchema = z
  .object({
    jobId: z.string().uuid().nullable(),
    parentArtifactId: z.string().uuid().nullable(),
  })
  .strict()
export type ArtifactSource = z.infer<typeof artifactSourceSchema>

export const artifactCreateMetadataSchema = z
  .object({
    artifactVersion: z.literal(ARTIFACT_VERSION),
    idempotencyKey: artifactWriteIntentKeySchema,
    kind: artifactKindSchema,
    mediaType: artifactMediaTypeSchema,
    ownership: artifactScopeSchema,
    source: artifactSourceSchema,
  })
  .strict()
export type ArtifactCreateMetadata = z.infer<typeof artifactCreateMetadataSchema>

export const artifactSchema = z
  .object({
    artifactVersion: z.literal(ARTIFACT_VERSION),
    id: artifactIdSchema,
    kind: artifactKindSchema,
    mediaType: artifactMediaTypeSchema,
    byteSize: z.number().int().nonnegative().safe(),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    ownership: artifactScopeSchema,
    source: artifactSourceSchema,
    retention: z.object({ mode: z.literal('keep') }).strict(),
    reference: z.object({ state: z.literal('referenced') }).strict(),
    gc: z.object({ state: z.literal('not_implemented') }).strict(),
    createdAt: z.string().datetime(),
  })
  .strict()
export type Artifact = z.infer<typeof artifactSchema>

export const artifactContentSchema = z
  .object({
    artifact: artifactSchema,
    content: z.instanceof(Uint8Array),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.content.byteLength !== value.artifact.byteSize) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Artifact byte size mismatch',
      })
    }
  })
export type ArtifactContent = z.infer<typeof artifactContentSchema>

/**
 * A filename is presentation metadata only. It is never a storage key or a
 * trusted filesystem path. Rejecting ambiguous characters also keeps the
 * eventual Content-Disposition projection deterministic across platforms.
 */
export const attachmentDisplayNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value === value.trim(), 'Filename must not have outer whitespace')
  .refine((value) => value !== '.' && value !== '..', 'Filename is reserved')
  .refine((value) => !/[\\/\u0000-\u001f\u007f-\u009f]/u.test(value), 'Filename contains an unsafe character')
  .refine(
    (value) => !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value),
    'Filename contains a bidi control',
  )
  .refine((value) => new TextEncoder().encode(value).byteLength <= 255, 'Filename is too large')

export const attachmentScopeQuerySchema = z.discriminatedUnion('scope', [
  z
    .object({
      attachmentVersion: z.coerce.number().pipe(z.literal(ATTACHMENT_VERSION)),
      scope: z.literal('projectless'),
    })
    .strict(),
  z
    .object({
      attachmentVersion: z.coerce.number().pipe(z.literal(ATTACHMENT_VERSION)),
      scope: z.literal('project'),
      projectId: projectReferenceSchema,
    })
    .strict(),
])
export type AttachmentScopeQuery = z.infer<typeof attachmentScopeQuerySchema>

export const attachmentListQuerySchema = z.discriminatedUnion('scope', [
  z
    .object({
      attachmentVersion: z.coerce.number().pipe(z.literal(ATTACHMENT_VERSION)),
      scope: z.literal('projectless'),
      limit: z.coerce.number().int().min(1).max(100),
    })
    .strict(),
  z
    .object({
      attachmentVersion: z.coerce.number().pipe(z.literal(ATTACHMENT_VERSION)),
      scope: z.literal('project'),
      projectId: projectReferenceSchema,
      limit: z.coerce.number().int().min(1).max(100),
    })
    .strict(),
])
export type AttachmentListQuery = z.infer<typeof attachmentListQuerySchema>

export const attachmentUploadQuerySchema = z.discriminatedUnion('scope', [
  z
    .object({
      attachmentVersion: z.coerce.number().pipe(z.literal(ATTACHMENT_VERSION)),
      scope: z.literal('projectless'),
      displayName: attachmentDisplayNameSchema,
    })
    .strict(),
  z
    .object({
      attachmentVersion: z.coerce.number().pipe(z.literal(ATTACHMENT_VERSION)),
      scope: z.literal('project'),
      projectId: projectReferenceSchema,
      displayName: attachmentDisplayNameSchema,
    })
    .strict(),
])
export type AttachmentUploadQuery = z.infer<typeof attachmentUploadQuerySchema>

export const attachmentSchema = z
  .object({
    attachmentVersion: z.literal(ATTACHMENT_VERSION),
    artifact: artifactSchema,
    displayName: attachmentDisplayNameSchema,
    modelConsumption: z
      .object({
        state: z.literal('not_connected'),
        reason: z.literal('attachment_transport_only'),
      })
      .strict(),
    export: z
      .object({
        state: z.literal('available'),
        rangeRequests: z.literal('unsupported'),
      })
      .strict(),
  })
  .strict()
export type Attachment = z.infer<typeof attachmentSchema>

export const listAttachmentsResponse = z
  .object({
    attachmentVersion: z.literal(ATTACHMENT_VERSION),
    scope: z.enum(['projectless', 'project']),
    projectId: projectReferenceSchema.nullable(),
    attachments: z.array(attachmentSchema),
    limit: z.number().int().min(1).max(100),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedProjectId = value.scope === 'project' ? value.projectId : null
    if (value.attachments.length > value.limit) {
      context.addIssue({ code: 'custom', path: ['attachments'], message: 'Attachment page exceeds limit' })
    }
    if ((value.scope === 'project') !== (value.projectId !== null)) {
      context.addIssue({ code: 'custom', path: ['projectId'], message: 'Attachment scope mismatch' })
    }
    value.attachments.forEach((attachment, index) => {
      const ownership = attachment.artifact.ownership
      if (
        ownership.scope !== value.scope
        || (ownership.scope === 'project' ? ownership.projectId : null) !== expectedProjectId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['attachments', index, 'artifact', 'ownership'],
          message: 'Attachment crossed its requested scope',
        })
      }
    })
    const ids = value.attachments.map((attachment) => attachment.artifact.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['attachments'], message: 'Duplicate attachment identity' })
    }
  })
export type ListAttachmentsResponse = z.infer<typeof listAttachmentsResponse>

export const createAttachmentResponse = attachmentSchema
export const getAttachmentResponse = attachmentSchema

const artifactTransferPolicyBase = {
  policyVersion: z.literal(ARTIFACT_TRANSFER_POLICY_VERSION),
  source: z.enum([
    'server_default_storage_policy',
    'application_configuration',
    'test_override',
  ]),
  observedAt: z.string().datetime(),
  modelCapability: z.literal('not_applicable'),
} as const

export const artifactTransferPolicySchema = z.discriminatedUnion('state', [
  z
    .object({
      ...artifactTransferPolicyBase,
      state: z.literal('enabled'),
      maxBytes: z.number().int().nonnegative().safe(),
      maxActiveTransfers: z.number().int().positive().safe(),
      maxQueuedTransfers: z.number().int().nonnegative().safe(),
      rangeRequests: z.literal('unsupported'),
      reason: z.null(),
    })
    .strict(),
  z.object({
    ...artifactTransferPolicyBase,
    state: z.literal('disabled'),
    maxBytes: z.null(),
    maxActiveTransfers: z.null(),
    maxQueuedTransfers: z.null(),
    rangeRequests: z.literal('unsupported'),
    reason: z.literal('disabled_by_configuration'),
  }).strict(),
  z.object({
    ...artifactTransferPolicyBase,
    state: z.literal('unknown'),
    maxBytes: z.null(),
    maxActiveTransfers: z.null(),
    maxQueuedTransfers: z.null(),
    rangeRequests: z.literal('unsupported'),
    reason: z.literal('configuration_invalid'),
  }).strict(),
])
export type ArtifactTransferPolicy = z.infer<typeof artifactTransferPolicySchema>

export const getArtifactTransferPolicyResponse = artifactTransferPolicySchema
