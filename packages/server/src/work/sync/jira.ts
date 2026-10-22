/**
 * One Jira REST adapter for Cloud (`/rest/api/3`) and Data Center (`/rest/api/2`) (D-121).
 *
 * Reads import summary, description, priority, assignee and labels. Writes are a status
 * comment and a mapped transition only. Comment payloads are Atlas Document Format on v3
 * and plain/wiki text on v2; comment reads flatten ADF back to text before the engine
 * checks idempotency markers.
 */
import {
  TrackerSyncError,
  TrackerTransportError,
  headerValue,
  isSuccessStatus,
  type AuthorizeHeaders,
  type CoarseStatus,
  type ConditionalRead,
  type HttpHeaders,
  type HttpResponse,
  type HttpTransport,
  type RemoteBusinessFields,
  type RemoteComment,
  type RemoteReadResult,
  type TrackerAdapter,
  type TrackerMutation,
  type TrackerWriteResult,
} from './types.ts'
import type { SecretRef } from '../../egress/types.ts'

const USER_AGENT = 'Guanxi-tracker-sync/0.1'
const COMMENT_PAGE_SIZE = 100

export interface JiraAdapterOptions {
  http: HttpTransport
  authorize: AuthorizeHeaders
  /** A `secret://` reference recorded for configuration/audit; never resolved here. */
  credential: SecretRef
  /** Instance root, optionally with a context path such as `/jira`. */
  baseUrl: string
  /** 3 selects Cloud; 2 selects Data Center/Server. */
  apiVersion: 2 | 3
  /** Derived status to transition id or name. Absent entries are comment-only. */
  transitions?: Partial<Record<CoarseStatus, string>>
  userAgent?: string
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrackerSyncError('invalid_response', `${what} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TrackerSyncError('invalid_response', `${what} must be a JSON array`)
  }
  return value
}

function parseJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new TrackerSyncError('invalid_response', `${what} response was not JSON`)
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Flattens an ADF node tree to plain text with block newlines. */
export function adfToText(value: unknown): string {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(walk).join('')
    if (node === null || typeof node !== 'object') return ''
    const record = node as Record<string, unknown>
    if (record.type === 'text') return typeof record.text === 'string' ? record.text : ''
    if (record.type === 'hardBreak') return '\n'
    const inner = walk(record.content)
    const block = record.type === 'paragraph'
      || record.type === 'heading'
      || record.type === 'codeBlock'
      || record.type === 'listItem'
      || record.type === 'blockquote'
    return block ? `${inner}\n` : inner
  }
  return walk(value).replace(/\n{2,}/g, '\n').trim()
}

/** Builds the Cloud ADF comment body from plain text, preserving each line. */
export function adfDocument(text: string): Record<string, unknown> {
  const content = text.split(/\r?\n/).map(line => ({
    type: 'paragraph',
    content: line === '' ? [] : [{ type: 'text', text: line }],
  }))
  return { type: 'doc', version: 1, content }
}

function jiraBodyText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return adfToText(value)
  return ''
}

function isRetryable(response: HttpResponse): boolean {
  if (response.status === 429 || response.status >= 500) return true
  if (response.status !== 403) return false
  if (headerValue(response.headers, 'retry-after') !== undefined) return true
  return /rate limit|abuse/i.test(response.body)
}

function retryableResult(response: HttpResponse): TrackerWriteResult {
  return {
    status: response.status,
    headers: response.headers,
    retryable: isRetryable(response),
  }
}

export class JiraAdapter implements TrackerAdapter {
  readonly tracker = 'jira' as const
  readonly credential: SecretRef
  private readonly http: HttpTransport
  private readonly authorize: AuthorizeHeaders
  private readonly baseUrl: string
  private readonly apiVersion: 2 | 3
  private readonly transitions: Partial<Record<CoarseStatus, string>>
  private readonly userAgent: string

  constructor(options: JiraAdapterOptions) {
    if (options.apiVersion !== 2 && options.apiVersion !== 3) {
      throw new TrackerSyncError('invalid_config', 'Jira apiVersion must be 2 or 3')
    }
    let base: URL
    try {
      base = new URL(options.baseUrl)
    } catch {
      throw new TrackerSyncError('invalid_config', 'Jira baseUrl must be an absolute URL')
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new TrackerSyncError('invalid_config', 'Jira baseUrl must use http or https')
    }
    this.http = options.http
    this.authorize = options.authorize
    this.credential = options.credential
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiVersion = options.apiVersion
    this.transitions = options.transitions ?? {}
    this.userAgent = options.userAgent ?? USER_AGENT
  }

  statusMapping(status: CoarseStatus): 'transition' | 'none' {
    const mapped = this.transitions[status]
    return mapped === undefined || mapped === '' ? 'none' : 'transition'
  }

  async read(externalKey: string, conditional?: ConditionalRead): Promise<RemoteReadResult> {
    const issueKey = this.issueKey(externalKey)
    const headers: HttpHeaders = { accept: 'application/json' }
    if (conditional?.etag !== null && conditional?.etag !== undefined && conditional.etag !== '') {
      headers['if-none-match'] = conditional.etag
    }
    if (conditional?.updatedAt !== null && conditional?.updatedAt !== undefined) {
      const at = Date.parse(conditional.updatedAt)
      if (Number.isFinite(at)) headers['if-modified-since'] = new Date(at).toUTCString()
    }

    const response = await this.send('GET', `${this.apiBase()}/issue/${issueKey}`, undefined, headers)
    if (response.status === 304) return { notModified: true }
    if (response.status !== 200) {
      throw new TrackerSyncError(
        'remote_rejected',
        `Jira issue read rejected with status ${response.status}`,
      )
    }
    const issue = object(parseJson(response.body, 'Jira issue'), 'Jira issue')
    const fields = object(issue.fields, 'Jira issue fields')
    if (typeof fields.summary !== 'string') {
      throw new TrackerSyncError('invalid_response', 'Jira summary must be a string')
    }
    const labels = Array.isArray(fields.labels)
      ? fields.labels.filter((label): label is string => typeof label === 'string')
      : []
    const priority = fields.priority === null || fields.priority === undefined
      ? null
      : typeof fields.priority === 'string'
        ? fields.priority
        : stringField(object(fields.priority, 'Jira priority').name)
    let assignee: string | null = null
    if (fields.assignee !== null && typeof fields.assignee === 'object') {
      const record = fields.assignee as Record<string, unknown>
      assignee = stringField(record.displayName)
        ?? stringField(record.name)
        ?? stringField(record.emailAddress)
    }
    const description = fields.description === null || fields.description === undefined
      ? null
      : typeof fields.description === 'string'
        ? fields.description
        : adfToText(fields.description)

    const business: RemoteBusinessFields = {
      title: fields.summary,
      description,
      priority,
      assignee,
      labels,
    }
    return {
      notModified: false,
      fields: business,
      etag: headerValue(response.headers, 'etag') ?? null,
      updatedAt: typeof fields.updated === 'string' ? fields.updated : null,
    }
  }

  async listComments(externalKey: string): Promise<RemoteComment[]> {
    const issueKey = this.issueKey(externalKey)
    const comments: RemoteComment[] = []
    let startAt = 0
    for (;;) {
      const url = `${this.apiBase()}/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`
      const response = await this.send('GET', url, undefined, { accept: 'application/json' })
      if (response.status !== 200) {
        throw new TrackerSyncError(
          'remote_rejected',
          `Jira comment list rejected with status ${response.status}`,
        )
      }
      const page = object(parseJson(response.body, 'Jira comments'), 'Jira comments')
      const entries = array(page.comments, 'Jira comments')
      for (const entry of entries) {
        const comment = object(entry, 'Jira comment')
        if (comment.id === undefined || comment.id === null) {
          throw new TrackerSyncError('invalid_response', 'Jira comment id is missing')
        }
        comments.push({ id: String(comment.id), body: jiraBodyText(comment.body) })
      }
      const total = typeof page.total === 'number' ? page.total : null
      const pageSize = typeof page.maxResults === 'number' && page.maxResults > 0
        ? page.maxResults
        : COMMENT_PAGE_SIZE
      startAt += entries.length
      if (entries.length === 0) break
      if (total !== null && startAt >= total) break
      if (entries.length < pageSize && (total === null || startAt >= total)) break
    }
    return comments
  }

  async mutate(externalKey: string, mutation: TrackerMutation): Promise<TrackerWriteResult> {
    const issueKey = this.issueKey(externalKey)
    switch (mutation.kind) {
      case 'comment': {
        if (!mutation.body.includes(mutation.marker)) {
          throw new TrackerSyncError('invalid_mutation', 'status comment must carry its marker')
        }
        const payload = this.apiVersion === 3
          ? { body: adfDocument(mutation.body) }
          : { body: mutation.body }
        const response = await this.send(
          'POST',
          `${this.apiBase()}/issue/${issueKey}/comment`,
          JSON.stringify(payload),
          { accept: 'application/json' },
        )
        const result = retryableResult(response)
        if (isSuccessStatus(response.status)) {
          const parsed = object(parseJson(response.body, 'Jira comment'), 'Jira comment')
          if (parsed.id !== undefined && parsed.id !== null) result.commentId = String(parsed.id)
        }
        return result
      }
      case 'transition':
        return this.transition(issueKey, mutation.status)
      default:
        throw new TrackerSyncError(
          'business_field_write_refused',
          'Jira sync may only create a status comment and apply a mapped transition',
        )
    }
  }

  private async transition(
    issueKey: string,
    status: CoarseStatus,
  ): Promise<TrackerWriteResult> {
    const mapped = this.transitions[status]
    if (mapped === undefined || mapped === '') {
      return { status: 200, headers: {}, retryable: false, skipped: true }
    }
    const response = await this.send(
      'GET',
      `${this.apiBase()}/issue/${issueKey}/transitions`,
      undefined,
      { accept: 'application/json' },
    )
    if (response.status !== 200) {
      const result = retryableResult(response)
      if (result.retryable) return result
      throw new TrackerSyncError(
        'remote_rejected',
        `Jira transition list rejected with status ${response.status}`,
      )
    }
    const parsed = object(parseJson(response.body, 'Jira transitions'), 'Jira transitions')
    const candidates = array(parsed.transitions, 'Jira transitions')
    let transitionId: string | null = null
    for (const candidate of candidates) {
      const record = object(candidate, 'Jira transition')
      const id = record.id === undefined || record.id === null ? '' : String(record.id)
      const name = typeof record.name === 'string' ? record.name : ''
      if (id === mapped || name.toLowerCase() === mapped.toLowerCase()) {
        transitionId = id
        break
      }
    }
    if (transitionId === null || transitionId === '') {
      throw new TrackerSyncError(
        'transition_not_found',
        `Jira does not offer the mapped transition for ${status}`,
      )
    }
    const applied = await this.send(
      'POST',
      `${this.apiBase()}/issue/${issueKey}/transitions`,
      JSON.stringify({ transition: { id: transitionId } }),
      { accept: 'application/json' },
    )
    return retryableResult(applied)
  }

  private apiBase(): string {
    return `${this.baseUrl}/rest/api/${this.apiVersion}`
  }

  private issueKey(externalKey: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(externalKey)) {
      throw new TrackerSyncError('invalid_external_key', 'Jira external key must be PROJ-12')
    }
    return encodeURIComponent(externalKey)
  }

  private async send(
    method: string,
    url: string,
    body: string | undefined,
    headers: HttpHeaders,
  ): Promise<HttpResponse> {
    const outgoingHeaders: HttpHeaders = { 'user-agent': this.userAgent, ...headers }
    if (body !== undefined) outgoingHeaders['content-type'] = 'application/json'
    const request = {
      method,
      url,
      headers: outgoingHeaders,
      ...(body === undefined ? {} : { body }),
    }
    try {
      const extra = await this.authorize(request.headers)
      if (extra !== undefined && extra !== null && typeof extra === 'object') {
        Object.assign(request.headers, extra)
      }
    } catch {
      throw new TrackerSyncError('authorization_failed', 'credential authorization failed')
    }
    try {
      const response = await this.http(request)
      if (
        response === null || typeof response !== 'object'
        || typeof response.status !== 'number'
        || typeof response.body !== 'string'
        || response.headers === null || typeof response.headers !== 'object'
      ) {
        throw new TrackerSyncError('invalid_response', 'Jira transport returned a malformed response')
      }
      return response
    } catch (error) {
      if (error instanceof TrackerSyncError) throw error
      throw new TrackerTransportError()
    }
  }
}
