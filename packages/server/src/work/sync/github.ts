/**
 * GitHub Issues adapter (WG2-a).
 *
 * One REST adapter over the injected transport. Reads import only business fields plus
 * one conditional validator; writes are limited to a status comment and a swap of one
 * `guanxi:<status>` label. There is no issue-edit request in this file, and the mutation
 * entry point refuses anything else with `business_field_write_refused`.
 */
import {
  COARSE_STATUSES,
  TrackerRetryableError,
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
  type TrackerReadObservation,
  type TrackerReadObserver,
  type TrackerWriteResult,
} from './types.ts'
import type { SecretRef } from '../../egress/types.ts'

const DEFAULT_API_BASE = 'https://api.github.com'
const USER_AGENT = 'Guanxi-tracker-sync/0.1'
/** Guanxi owns exactly its coarse status labels; other `guanxi:*` labels are user intent. */
const GUANXI_STATUS_LABELS: ReadonlySet<string> = new Set(
  COARSE_STATUSES.map(status => `guanxi:${status}`),
)

export interface GitHubAdapterOptions {
  http: HttpTransport
  authorize: AuthorizeHeaders
  /** A `secret://` reference recorded for configuration/audit; never resolved here. */
  credential: SecretRef
  apiBase?: string
  userAgent?: string
}

interface GitHubIssueRef {
  owner: string
  repo: string
  number: number
}

export function parseGitHubExternalKey(externalKey: string): GitHubIssueRef {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(externalKey)
  if (match === null) {
    throw new TrackerSyncError(
      'invalid_external_key',
      'GitHub external key must be owner/repo#number',
    )
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) }
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

function labelNames(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return array(value, 'labels').map(entry => {
    if (typeof entry === 'string') return entry
    const label = object(entry, 'label')
    return typeof label.name === 'string' ? label.name : ''
  }).filter(name => name !== '')
}

function commentAuthor(comment: Record<string, unknown>): string | null {
  const user = comment.user
  if (user === null || typeof user !== 'object') return null
  const login = (user as Record<string, unknown>).login
  return typeof login === 'string' && login !== '' ? login : null
}

function assigneeName(issue: Record<string, unknown>): string | null {
  const single = issue.assignee
  if (single !== null && typeof single === 'object') {
    const login = (single as Record<string, unknown>).login
    if (typeof login === 'string' && login !== '') return login
  }
  const list = issue.assignees
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry !== null && typeof entry === 'object') {
        const login = (entry as Record<string, unknown>).login
        if (typeof login === 'string' && login !== '') return login
      }
    }
  }
  return null
}

function priorityFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const match = /^priority[:/](.+)$/i.exec(label)
    if (match !== null) return match[1]!.trim()
  }
  return null
}

function isRetryable(response: HttpResponse): boolean {
  if (response.status === 429 || response.status >= 500) return true
  if (response.status !== 403) return false
  if (headerValue(response.headers, 'retry-after') !== undefined) return true
  if (headerValue(response.headers, 'x-ratelimit-remaining') === '0') return true
  return /secondary rate limit|abuse detection/i.test(response.body)
}

function nextLink(header: string | undefined, current: string, origin: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(',')) {
    if (!/rel="next"/.test(part)) continue
    const match = /<([^>]+)>/.exec(part)
    if (match === null) continue
    let url: URL
    try {
      url = new URL(match[1]!, current)
    } catch {
      throw new TrackerSyncError('invalid_response', 'GitHub pagination link was not a URL')
    }
    if (url.origin !== origin) {
      throw new TrackerSyncError('invalid_response', 'GitHub pagination crossed origins')
    }
    return url.toString()
  }
  return null
}

export class GitHubAdapter implements TrackerAdapter {
  readonly tracker = 'github' as const
  readonly credential: SecretRef
  private readonly http: HttpTransport
  private readonly authorize: AuthorizeHeaders
  private readonly apiBase: string
  private readonly origin: string
  private readonly userAgent: string
  private readObserver: TrackerReadObserver | null = null
  private selfIdentity: string | null = null

  constructor(options: GitHubAdapterOptions) {
    const base = options.apiBase ?? DEFAULT_API_BASE
    let parsed: URL
    try {
      parsed = new URL(base)
    } catch {
      throw new TrackerSyncError('invalid_config', 'GitHub apiBase must be an absolute URL')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new TrackerSyncError('invalid_config', 'GitHub apiBase must use http or https')
    }
    this.http = options.http
    this.authorize = options.authorize
    this.credential = options.credential
    this.apiBase = base.replace(/\/+$/, '')
    this.origin = parsed.origin
    this.userAgent = options.userAgent ?? USER_AGENT
  }

  observeReads(observer: TrackerReadObserver): void {
    this.readObserver = observer
  }

  statusMapping(_status: CoarseStatus): 'label' {
    return 'label'
  }

  async read(externalKey: string, conditional?: ConditionalRead): Promise<RemoteReadResult> {
    const ref = parseGitHubExternalKey(externalKey)
    const headers: HttpHeaders = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
    if (conditional?.etag !== null && conditional?.etag !== undefined && conditional.etag !== '') {
      headers['if-none-match'] = conditional.etag
    }
    if (conditional?.updatedAt !== null && conditional?.updatedAt !== undefined) {
      const at = Date.parse(conditional.updatedAt)
      if (Number.isFinite(at)) headers['if-modified-since'] = new Date(at).toUTCString()
    }

    const response = await this.send('GET', this.issueUrl(ref), undefined, headers, externalKey)
    if (response.status === 304) return { notModified: true }
    if (response.status !== 200) {
      if (isRetryable(response)) {
        throw new TrackerRetryableError(response.status, response.headers)
      }
      throw new TrackerSyncError(
        'remote_rejected',
        `GitHub issue read rejected with status ${response.status}`,
      )
    }
    const issue = object(parseJson(response.body, 'GitHub issue'), 'GitHub issue')
    if (typeof issue.title !== 'string') {
      throw new TrackerSyncError('invalid_response', 'GitHub issue title must be a string')
    }
    const allLabels = labelNames(issue.labels)
    // A guanxi:<coarse status> label is Guanxi execution state, not tracker business intent.
    const labels = allLabels.filter(label => !GUANXI_STATUS_LABELS.has(label))
    const fields: RemoteBusinessFields = {
      title: issue.title,
      description: typeof issue.body === 'string' ? issue.body : null,
      priority: priorityFromLabels(allLabels),
      assignee: assigneeName(issue),
      labels,
    }
    return {
      notModified: false,
      fields,
      etag: headerValue(response.headers, 'etag') ?? null,
      updatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : null,
    }
  }

  async listComments(externalKey: string): Promise<RemoteComment[]> {
    const ref = parseGitHubExternalKey(externalKey)
    const comments: RemoteComment[] = []
    const seen = new Set<string>()
    let url: string | null = `${this.issueUrl(ref)}/comments?per_page=100`
    while (url !== null) {
      if (seen.has(url)) {
        throw new TrackerSyncError('invalid_response', 'GitHub comment pagination repeated a page')
      }
      seen.add(url)
      const response = await this.send('GET', url, undefined, {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      }, externalKey)
      if (response.status !== 200) {
        if (isRetryable(response)) {
          throw new TrackerRetryableError(response.status, response.headers)
        }
        throw new TrackerSyncError(
          'remote_rejected',
          `GitHub comment list rejected with status ${response.status}`,
        )
      }
      for (const entry of array(parseJson(response.body, 'GitHub comments'), 'GitHub comments')) {
        const comment = object(entry, 'GitHub comment')
        if (comment.id === undefined || comment.id === null) {
          throw new TrackerSyncError('invalid_response', 'GitHub comment id is missing')
        }
        comments.push({
          id: String(comment.id),
          body: typeof comment.body === 'string' ? comment.body : '',
          author: commentAuthor(comment),
        })
      }
      url = nextLink(headerValue(response.headers, 'link'), url, this.origin)
    }
    return comments
  }

  async self(): Promise<string> {
    if (this.selfIdentity !== null) return this.selfIdentity
    const response = await this.send(
      'GET',
      `${this.apiBase}/user`,
      undefined,
      { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      'github:self',
    )
    if (response.status !== 200) {
      if (isRetryable(response)) {
        throw new TrackerRetryableError(response.status, response.headers)
      }
      throw new TrackerSyncError(
        'remote_rejected',
        `GitHub identity read rejected with status ${response.status}`,
      )
    }
    const user = object(parseJson(response.body, 'GitHub user'), 'GitHub user')
    if (typeof user.login !== 'string' || user.login === '') {
      throw new TrackerSyncError('invalid_response', 'GitHub user login must be a string')
    }
    this.selfIdentity = user.login
    return user.login
  }

  async mutate(externalKey: string, mutation: TrackerMutation): Promise<TrackerWriteResult> {
    const ref = parseGitHubExternalKey(externalKey)
    switch (mutation.kind) {
      case 'comment': {
        if (!mutation.body.includes(mutation.marker)) {
          throw new TrackerSyncError('invalid_mutation', 'status comment must carry its marker')
        }
        const response = await this.send(
          'POST',
          `${this.issueUrl(ref)}/comments`,
          JSON.stringify({ body: mutation.body }),
          { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        )
        const result = this.result(response)
        if (isSuccessStatus(response.status)) {
          const parsed = object(parseJson(response.body, 'GitHub comment'), 'GitHub comment')
          if (parsed.id !== undefined && parsed.id !== null) result.commentId = String(parsed.id)
        }
        return result
      }
      case 'status-label':
        return this.setStatusLabel(ref, mutation.status, externalKey)
      default:
        throw new TrackerSyncError(
          'business_field_write_refused',
          'GitHub sync may only create a status comment and swap one guanxi:<status> label',
        )
    }
  }

  private async setStatusLabel(
    ref: GitHubIssueRef,
    status: CoarseStatus,
    externalKey: string,
  ): Promise<TrackerWriteResult> {
    const target = `guanxi:${status}`
    const response = await this.send('GET', this.issueUrl(ref), undefined, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }, externalKey)
    if (response.status !== 200) {
      if (isRetryable(response)) {
        throw new TrackerRetryableError(response.status, response.headers)
      }
      throw new TrackerSyncError(
        'remote_rejected',
        `GitHub label read rejected with status ${response.status}`,
      )
    }
    const issue = object(parseJson(response.body, 'GitHub issue'), 'GitHub issue')
    const current = labelNames(issue.labels)
    const stale = current.filter(label => GUANXI_STATUS_LABELS.has(label) && label !== target)
    let last: HttpResponse | null = null

    for (const label of stale) {
      const removal = await this.send(
        'DELETE',
        `${this.issueUrl(ref)}/labels/${encodeURIComponent(label)}`,
        undefined,
        { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      )
      last = removal
      if (!isSuccessStatus(removal.status)) {
        const result = this.result(removal)
        if (result.retryable) return result
        throw new TrackerSyncError(
          'remote_rejected',
          `GitHub label removal rejected with status ${removal.status}`,
        )
      }
    }

    if (!current.includes(target)) {
      const addition = await this.send(
        'POST',
        `${this.issueUrl(ref)}/labels`,
        JSON.stringify({ labels: [target] }),
        { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      )
      last = addition
      if (!isSuccessStatus(addition.status)) {
        const result = this.result(addition)
        if (result.retryable) return result
        throw new TrackerSyncError(
          'remote_rejected',
          `GitHub label addition rejected with status ${addition.status}`,
        )
      }
    }

    if (last === null) {
      return { status: 200, headers: {}, retryable: false, skipped: true }
    }
    return this.result(last)
  }

  private issueUrl(ref: GitHubIssueRef): string {
    return `${this.apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`
  }

  private result(response: HttpResponse): TrackerWriteResult {
    return {
      status: response.status,
      headers: response.headers,
      retryable: isRetryable(response),
    }
  }

  private async send(
    method: string,
    url: string,
    body: string | undefined,
    headers: HttpHeaders,
    readKey: string | null = null,
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
        throw new TrackerSyncError('invalid_response', 'GitHub transport returned a malformed response')
      }
      if (readKey !== null && this.readObserver !== null) {
        const observation: TrackerReadObservation = {
          tracker: this.tracker,
          key: readKey,
          status: response.status,
          headers: response.headers,
          retryable: isRetryable(response),
        }
        this.readObserver(observation)
      }
      return response
    } catch (error) {
      if (error instanceof TrackerSyncError) throw error
      // Never carry the original error: its message could contain a credential.
      throw new TrackerTransportError()
    }
  }
}
