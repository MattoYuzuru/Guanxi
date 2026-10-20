import { Hono, type Context } from 'hono'
import {
  ATTACHMENT_VERSION,
  artifactIdSchema,
  artifactMediaTypeSchema,
  artifactWriteIntentKeySchema,
  attachmentScopeQuerySchema,
  attachmentListQuerySchema,
  attachmentUploadQuerySchema,
  createAttachmentResponse,
  getArtifactTransferPolicyResponse,
  getAttachmentResponse,
  listAttachmentsResponse,
  type ApiError,
  type ArtifactScope,
} from '@guanxi/contract'
import type { AppContext } from '../context.ts'
import {
  ArtifactTransferError,
} from '../artifacts/transfer-service.ts'
import { ArtifactStoreError } from '../store/artifacts.ts'
import { notFound } from './errors.ts'

const SCOPE_QUERY_KEYS = new Set(['attachmentVersion', 'scope', 'projectId'])
const LIST_QUERY_KEYS = new Set(['attachmentVersion', 'scope', 'projectId', 'limit'])
const UPLOAD_QUERY_KEYS = new Set([
  'attachmentVersion',
  'scope',
  'projectId',
  'displayName',
])
const UPLOAD_HEADER_KEYS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'dnt',
  'host',
  'idempotency-key',
  'origin',
  'pragma',
  'priority',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'te',
  'transfer-encoding',
  'upgrade-insecure-requests',
  'user-agent',
])

function exactQuery(url: string, allowed: ReadonlySet<string>): Record<string, string> | null {
  const query = new URL(url).searchParams
  if (
    [...query.keys()].some((key) => !allowed.has(key))
    || [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
  ) return null
  return Object.fromEntries(query)
}

function scopeFromQuery(url: string): ArtifactScope | null {
  const query = exactQuery(url, SCOPE_QUERY_KEYS)
  if (!query) return null
  const parsed = attachmentScopeQuerySchema.safeParse(query)
  if (!parsed.success) return null
  return parsed.data.scope === 'project'
    ? { scope: 'project', projectId: parsed.data.projectId }
    : { scope: 'projectless' }
}

function validateProject(
  app: Pick<AppContext, 'projects'>,
  scope: ArtifactScope,
): boolean {
  return scope.scope === 'projectless' || app.projects.get(scope.projectId) !== null
}

function error(
  context: Context,
  status: 400 | 404 | 409 | 413 | 416 | 500 | 503,
  code: ApiError['code'],
  message: string,
  details: Record<string, unknown> | null = null,
): Response {
  return context.json({ code, message, details }, status)
}

function transferError(context: Context, cause: unknown, read = false): Response {
  if (cause instanceof ArtifactTransferError) {
    if (cause.code === 'policy_unavailable') {
      return error(
        context,
        503,
        'artifact_policy_unavailable',
        'Attachment byte transfer is unavailable by the observed storage policy',
      )
    }
    if (cause.code === 'admission_full') {
      return error(
        context,
        503,
        'artifact_admission_full',
        'Attachment transfer capacity is full; retry later',
      )
    }
    return error(context, 400, 'validation_failed', 'Attachment transfer was cancelled')
  }
  if (cause instanceof ArtifactStoreError) {
    if (cause.code === 'aborted') {
      return error(context, 400, 'validation_failed', 'Attachment transfer was cancelled')
    }
    if (read && cause.code !== 'invalid_input') {
      return error(context, 404, 'artifact_not_found', 'Attachment is unavailable in this scope')
    }
    if (cause.code === 'invalid_input') {
      return error(context, 400, 'validation_failed', 'Invalid attachment request')
    }
    if (cause.code === 'size_limit_exceeded') {
      return error(context, 413, 'artifact_too_large', 'Attachment exceeds the observed storage policy')
    }
    if (cause.code === 'idempotency_conflict') {
      return error(context, 409, 'artifact_conflict', 'Attachment intent conflicts with stored bytes or metadata')
    }
    if (cause.code === 'invalid_reference') {
      return error(context, 400, 'validation_failed', 'Attachment scope is invalid')
    }
  }
  return error(context, 500, 'storage_error', 'Attachment storage operation failed')
}

function contentLength(value: string | undefined): number | null | 'invalid' {
  if (value === undefined) return null
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return 'invalid'
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 'invalid'
}

async function* requestBytes(
  request: Request,
  expectedLength: number | null,
): AsyncGenerator<Uint8Array> {
  if (request.signal.aborted) {
    throw new ArtifactTransferError('aborted', 'Artifact transfer was cancelled')
  }
  if (request.body === null) {
    if (expectedLength !== null && expectedLength !== 0) {
      throw new ArtifactStoreError('invalid_input', 'Attachment body length mismatch')
    }
    return
  }
  const reader = request.body.getReader()
  let rejectAbort!: (error: ArtifactTransferError) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(
    new ArtifactTransferError('aborted', 'Artifact transfer was cancelled'),
  )
  request.signal.addEventListener('abort', onAbort, { once: true })
  let observed = 0
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) break
      observed += chunk.value.byteLength
      if (!Number.isSafeInteger(observed)) {
        throw new ArtifactStoreError('size_limit_exceeded', 'Attachment body is too large')
      }
      yield chunk.value
    }
    if (expectedLength !== null && observed !== expectedLength) {
      throw new ArtifactStoreError('invalid_input', 'Attachment body length mismatch')
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => undefined)
  }
}

function contentDisposition(id: string, displayName: string): string {
  const encoded = encodeURIComponent(displayName).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
  return `attachment; filename="attachment-${id}"; filename*=UTF-8''${encoded}`
}

export function artifactsRoutes(
  app: Pick<AppContext, 'artifactTransfers' | 'projects'>,
): Hono {
  const routes = new Hono()

  routes.get('/policy', (context) => {
    if (new URL(context.req.url).search.length !== 0) {
      return error(context, 400, 'validation_failed', 'Artifact policy query must be empty')
    }
    return context.json(getArtifactTransferPolicyResponse.parse(app.artifactTransfers.policy))
  })

  routes.get('/', (context) => {
    const query = exactQuery(context.req.url, LIST_QUERY_KEYS)
    const parsed = query ? attachmentListQuerySchema.safeParse(query) : null
    if (!parsed?.success) return error(context, 400, 'validation_failed', 'Invalid attachment scope')
    const scope: ArtifactScope = parsed.data.scope === 'project'
      ? { scope: 'project', projectId: parsed.data.projectId }
      : { scope: 'projectless' }
    if (!validateProject(app, scope)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    const page = app.artifactTransfers.list(scope, parsed.data.limit)
    return context.json(listAttachmentsResponse.parse({
      attachmentVersion: ATTACHMENT_VERSION,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : null,
      attachments: page.attachments,
      limit: parsed.data.limit,
      truncated: page.truncated,
    }))
  })

  routes.post('/', async (context) => {
    const query = exactQuery(context.req.url, UPLOAD_QUERY_KEYS)
    const parsed = query ? attachmentUploadQuerySchema.safeParse(query) : null
    const idempotencyKey = artifactWriteIntentKeySchema.safeParse(
      context.req.header('idempotency-key'),
    )
    const mediaType = artifactMediaTypeSchema.safeParse(context.req.header('content-type'))
    const claimedLength = contentLength(context.req.header('content-length'))
    const hasUnknownHeader = [...context.req.raw.headers.keys()].some(
      (name) => !UPLOAD_HEADER_KEYS.has(name.toLowerCase()),
    )
    if (
      !parsed?.success
      || !idempotencyKey.success
      || !mediaType.success
      || claimedLength === 'invalid'
      || hasUnknownHeader
    ) {
      return error(context, 400, 'validation_failed', 'Invalid attachment upload contract')
    }
    const scope: ArtifactScope = parsed.data.scope === 'project'
      ? { scope: 'project', projectId: parsed.data.projectId }
      : { scope: 'projectless' }
    if (!validateProject(app, scope)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    const policy = app.artifactTransfers.policy
    if (policy.state !== 'enabled') {
      return error(
        context,
        503,
        'artifact_policy_unavailable',
        'Attachment byte transfer is unavailable by the observed storage policy',
      )
    }
    if (claimedLength !== null && claimedLength > policy.maxBytes) {
      return error(
        context,
        413,
        'artifact_too_large',
        'Attachment exceeds the observed storage policy',
        { maxBytes: policy.maxBytes, source: policy.source, observedAt: policy.observedAt },
      )
    }
    try {
      const attachment = await app.artifactTransfers.upload({
        attachmentVersion: ATTACHMENT_VERSION,
        idempotencyKey: idempotencyKey.data,
        displayName: parsed.data.displayName,
        mediaType: mediaType.data,
        ownership: scope,
      }, requestBytes(context.req.raw, claimedLength), context.req.raw.signal)
      return context.json(createAttachmentResponse.parse(attachment), 201)
    } catch (cause) {
      return transferError(context, cause)
    }
  })

  routes.get('/:id/content', async (context) => {
    const scope = scopeFromQuery(context.req.url)
    const id = artifactIdSchema.safeParse(context.req.param('id'))
    if (!scope || !id.success) {
      return error(context, 400, 'validation_failed', 'Invalid attachment reference')
    }
    if (!validateProject(app, scope)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    if (context.req.header('range') !== undefined) {
      context.header('Accept-Ranges', 'none')
      return error(context, 416, 'range_not_supported', 'Attachment Range requests are not supported')
    }
    try {
      const result = await app.artifactTransfers.download(id.data, scope, context.req.raw.signal)
      return new Response(Buffer.from(result.content), {
        status: 200,
        headers: {
          'Accept-Ranges': 'none',
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDisposition(id.data, result.attachment.displayName),
          'Content-Length': result.headers.contentLength,
          'Content-Type': result.headers.contentType,
          'Content-Security-Policy': "sandbox; default-src 'none'",
          Digest: result.headers.digest,
          ETag: result.headers.etag,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (cause) {
      return transferError(context, cause, true)
    }
  })

  routes.get('/:id', (context) => {
    const scope = scopeFromQuery(context.req.url)
    const id = artifactIdSchema.safeParse(context.req.param('id'))
    if (!scope || !id.success) {
      return error(context, 400, 'validation_failed', 'Invalid attachment reference')
    }
    if (!validateProject(app, scope)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    const attachment = app.artifactTransfers.get(id.data, scope)
    if (!attachment) {
      return error(context, 404, 'artifact_not_found', 'Attachment is unavailable in this scope')
    }
    return context.json(getAttachmentResponse.parse(attachment))
  })

  return routes
}
