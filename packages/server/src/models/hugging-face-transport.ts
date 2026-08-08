/**
 * Bounded server-owned Hugging Face Hub access for P2-J read-only discovery.
 *
 * Only the server talks to the Hub. The Web client never issues a cross-origin request
 * and never learns the endpoint. Every failure is published as a typed redacted reason:
 * no raw provider body, endpoint, host, path, header or credential leaves this module.
 *
 * Anonymous public access only. This slice requests no token, stores no token and sends
 * no `Authorization` header, so a gated repository is *recognised* but never unlocked.
 *
 * One explicit search is one bounded request: a fixed connect and response deadline, a
 * hard response byte cap, a bounded file-entry count and the caller's AbortSignal. It
 * starts no download, pull, probe, load, unload, Governor admission, catalog refresh or
 * background Job — the only side effect is the outbound read itself.
 */
import {
  HUGGING_FACE_DISCOVERY_VERSION,
  HUGGING_FACE_SEARCH_MAX_PAGE_SIZE,
  HUGGING_FACE_SEARCH_MAX_PAGES,
  type HuggingFaceFileInventory,
  type HuggingFaceGatedState,
  type HuggingFaceGgufFile,
  type HuggingFaceLicenseState,
  type HuggingFaceReferencePreview,
  type HuggingFaceRepository,
  type HuggingFaceRepositoryIdentity,
  type HuggingFaceRepositoryResult,
  type HuggingFaceRevision,
  type HuggingFaceSearchResult,
  type HuggingFaceSourceHealth,
  type HuggingFaceSupportVerdict,
  type HuggingFaceTransportFailureReason,
  type HuggingFaceUnknownVerdictReason,
} from '@alamo/contract'
import { parseHuggingFaceRepositoryId } from './hugging-face-reference.ts'

/** The documented public Hub origin. It is a constant, never caller-supplied. */
const HUB_ORIGIN = 'https://huggingface.co'

export const HUGGING_FACE_CONNECT_TIMEOUT_MS = 8_000
export const HUGGING_FACE_RESPONSE_TIMEOUT_MS = 12_000
/** Hard cap on the bytes read from one Hub response before it is abandoned. */
export const HUGGING_FACE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Bounded per-repository file listing. Beyond this the inventory is truncated. */
export const HUGGING_FACE_MAX_FILE_ENTRIES = 512

export interface HuggingFaceTransportOptions {
  fetch?: typeof fetch
  connectTimeoutMs?: number
  responseTimeoutMs?: number
  maxResponseBytes?: number
  /** Injected only so tests can assert observedAt without a real clock. */
  now?: () => Date
}

/** Internal typed failure. Callers only ever see the redacted reason enum. */
class HubFailure extends Error {
  readonly reason: HuggingFaceTransportFailureReason

  constructor(reason: HuggingFaceTransportFailureReason) {
    super(`hugging face hub read failed: ${reason}`)
    this.name = 'HubFailure'
    this.reason = reason
  }
}

/* ─────────────────────────── Bounded HTTP boundary ───────────────────────── */

/**
 * Reads one Hub JSON response under an explicit byte cap. The body is streamed so an
 * oversized or endless response is abandoned instead of being buffered whole.
 */
async function readCappedJson(
  response: Response,
  maxResponseBytes: number,
): Promise<{ value: unknown; raw: string }> {
  const body = response.body
  if (!body) throw new HubFailure('provider_malformed')

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxResponseBytes) {
        // Stop reading and refuse the whole response: a partial JSON prefix must
        // never be parsed into "facts" about a repository.
        throw new HubFailure('response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const buffer = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  try {
    return { value: JSON.parse(raw) as unknown, raw }
  } catch {
    throw new HubFailure('provider_malformed')
  }
}

function classifyStatus(status: number): HuggingFaceTransportFailureReason {
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  // 401/403 on an anonymous read means the repository is not publicly readable.
  if (status === 401 || status === 403) return 'not_found'
  if (status >= 500) return 'provider_unavailable'
  return 'provider_error'
}

export class HuggingFaceTransport {
  private readonly fetchImpl: typeof fetch
  private readonly connectTimeoutMs: number
  private readonly responseTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly now: () => Date

  constructor(options: HuggingFaceTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.connectTimeoutMs = options.connectTimeoutMs ?? HUGGING_FACE_CONNECT_TIMEOUT_MS
    this.responseTimeoutMs = options.responseTimeoutMs ?? HUGGING_FACE_RESPONSE_TIMEOUT_MS
    this.maxResponseBytes = options.maxResponseBytes ?? HUGGING_FACE_MAX_RESPONSE_BYTES
    this.now = options.now ?? (() => new Date())
  }

  /**
   * One bounded anonymous GET. The caller's signal stays authoritative: when it is
   * already aborted, or aborts during the read, nothing is published at all.
   */
  private async get(
    path: string,
    search: URLSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<{ value: unknown; headers: Headers }> {
    signal?.throwIfAborted()

    const url = new URL(path, HUB_ORIGIN)
    url.search = search.toString()

    const controller = new AbortController()
    const composed = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal

    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let responseTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut: HuggingFaceTransportFailureReason | null = null

    try {
      let response: Response
      try {
        connectTimer = setTimeout(() => {
          timedOut = 'connect_timeout'
          controller.abort('alamo:hugging-face-connect-timeout')
        }, this.connectTimeoutMs)
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          signal: composed,
          redirect: 'error',
          headers: {
            accept: 'application/json',
            // No Authorization header: this slice is anonymous public access only.
          },
        })
      } catch (error) {
        if (signal?.aborted) throw error
        throw new HubFailure(timedOut ?? 'provider_unavailable')
      } finally {
        if (connectTimer) clearTimeout(connectTimer)
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new HubFailure(classifyStatus(response.status))
      }

      try {
        responseTimer = setTimeout(() => {
          timedOut = 'response_timeout'
          controller.abort('alamo:hugging-face-response-timeout')
        }, this.responseTimeoutMs)
        const { value } = await readCappedJson(response, this.maxResponseBytes)
        return { value, headers: response.headers }
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof HubFailure) throw error
        throw new HubFailure(timedOut ?? 'provider_unavailable')
      } finally {
        if (responseTimer) clearTimeout(responseTimer)
      }
    } finally {
      // Release the socket for the abandoned-response paths too.
      if (!controller.signal.aborted) controller.abort('alamo:hugging-face-request-done')
    }
  }

  private available(): HuggingFaceSourceHealth {
    return {
      state: 'available',
      source: 'hugging_face_public_api',
      observedAt: this.now().toISOString(),
      reason: null,
    }
  }

  private unavailable(
    reason: HuggingFaceTransportFailureReason,
  ): HuggingFaceSourceHealth {
    return {
      state: 'unavailable',
      source: 'hugging_face_public_api',
      observedAt: this.now().toISOString(),
      reason,
    }
  }

  /**
   * One explicit bounded search page. `page` is an ordinal bound only — the Hub list API
   * is cursor-paginated, so no offset is computed and no total-result count is invented.
   */
  async search(input: {
    query: string
    page: number
    pageSize: number
    cursor: string | null
    signal?: AbortSignal
  }): Promise<HuggingFaceSearchResult> {
    const { query, cursor, signal } = input
    // The published page/pageSize must stay inside the contract bounds even when a
    // direct caller asks beyond them, or the result itself would be unrepresentable.
    const page = Math.min(input.page, HUGGING_FACE_SEARCH_MAX_PAGES)
    const pageSize = Math.min(input.pageSize, HUGGING_FACE_SEARCH_MAX_PAGE_SIZE)
    if (input.page > HUGGING_FACE_SEARCH_MAX_PAGES) {
      return this.failedPage(page, pageSize, 'provider_error')
    }

    const search = new URLSearchParams({
      search: query,
      limit: String(pageSize),
      // `full` is what makes the per-repository file listing available in one request.
      full: 'true',
    })
    if (cursor !== null) search.set('cursor', cursor)

    let payload: { value: unknown; headers: Headers }
    try {
      payload = await this.get('/api/models', search, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return this.failedPage(
        page,
        pageSize,
        error instanceof HubFailure ? error.reason : 'provider_unavailable',
      )
    }

    if (!Array.isArray(payload.value)) {
      return this.failedPage(page, pageSize, 'provider_malformed')
    }

    const observedAt = this.now().toISOString()
    const repositories: HuggingFaceRepository[] = []
    let droppedRows = 0
    // `limit` is only a request hint: a provider may answer with more rows than were
    // asked for. The published page is bounded here so one response cannot grow
    // without limit, and the surplus is reported as dropped rather than hidden.
    for (const row of payload.value) {
      if (repositories.length >= pageSize) {
        droppedRows += 1
        continue
      }
      const repository = buildRepositoryFromHub(row, observedAt)
      if (repository) repositories.push(repository)
      else droppedRows += 1
    }

    const source = this.available()
    if (repositories.length === 0) {
      return {
        state: 'empty',
        version: HUGGING_FACE_DISCOVERY_VERSION,
        page,
        pageSize,
        source,
        droppedRows,
        repositories: [],
        nextCursor: null,
        reason: null,
      }
    }

    return {
      state: 'listed',
      version: HUGGING_FACE_DISCOVERY_VERSION,
      page,
      pageSize,
      source,
      droppedRows,
      repositories,
      nextCursor:
        page >= HUGGING_FACE_SEARCH_MAX_PAGES
          ? null
          : nextCursorFromLink(payload.headers.get('link')),
      reason: null,
    }
  }

  private failedPage(
    page: number,
    pageSize: number,
    reason: HuggingFaceTransportFailureReason,
  ): HuggingFaceSearchResult {
    return {
      state: 'failed',
      version: HUGGING_FACE_DISCOVERY_VERSION,
      page,
      pageSize,
      source: this.unavailable(reason),
      droppedRows: 0,
      repositories: [],
      nextCursor: null,
      reason,
    }
  }

  /**
   * One bounded repository read for an already-parsed identity. A failed read still
   * returns the row with `metadata: 'unavailable'` and an unknown verdict, because
   * failing to read the Hub is not evidence that a repository lacks GGUF files.
   */
  async repository(input: {
    preview: HuggingFaceReferencePreview
    signal?: AbortSignal
  }): Promise<HuggingFaceRepositoryResult> {
    const { preview, signal } = input
    let payload: { value: unknown; headers: Headers }
    try {
      payload = await this.get(
        `/api/models/${encodeURIComponent(preview.identity.owner)}/${
          encodeURIComponent(preview.identity.name)
        }`,
        new URLSearchParams(),
        signal,
      )
    } catch (error) {
      if (signal?.aborted) throw error
      return this.failedRepository(
        preview,
        error instanceof HubFailure ? error.reason : 'provider_unavailable',
      )
    }

    const observedAt = this.now().toISOString()
    const repository = buildRepositoryFromHub(
      payload.value,
      observedAt,
      preview.identity,
    )
    if (!repository) return this.failedRepository(preview, 'provider_malformed')

    return {
      state: 'resolved',
      version: HUGGING_FACE_DISCOVERY_VERSION,
      preview,
      repository,
      source: this.available(),
      reason: null,
    }
  }

  private failedRepository(
    preview: HuggingFaceReferencePreview,
    reason: HuggingFaceTransportFailureReason,
  ): HuggingFaceRepositoryResult {
    return {
      state: 'failed',
      version: HUGGING_FACE_DISCOVERY_VERSION,
      preview,
      repository: unavailableRepository(
        preview.identity,
        this.now().toISOString(),
        'metadata_unavailable',
      ),
      source: this.unavailable(reason),
      reason,
    }
  }
}

/* ──────────────────────── Pure Hub payload projection ────────────────────── */

/**
 * A repository whose metadata could not be read. Every evidence field stays unknown
 * and the verdict is explicitly `unknown`, never `unsupported`.
 */
export function unavailableRepository(
  identity: HuggingFaceRepositoryIdentity,
  observedAt: string,
  reason: HuggingFaceUnknownVerdictReason,
): HuggingFaceRepository {
  return {
    version: HUGGING_FACE_DISCOVERY_VERSION,
    provider: 'hugging_face',
    identity,
    metadata: 'unavailable',
    observedAt,
    revision: { state: 'unknown', commit: null, source: 'not_reported' },
    gated: { state: 'unknown', mode: null },
    license: {
      state: 'unknown',
      value: null,
      source: 'metadata_unavailable',
      confidence: 'unknown',
    },
    files: {
      state: 'unknown',
      source: 'metadata_unavailable',
      totalFiles: null,
      malformedEntries: null,
      truncated: null,
      ggufFiles: [],
    },
    verdict: {
      state: 'unknown',
      scope: 'exact_gguf_file_only',
      basis: 'insufficient_evidence',
      reason,
      requiresExactFileSelection: true,
    },
  }
}

/**
 * Reuses the one strict local grammar rather than restating it, so a provider row can
 * never carry an identity that `normalizeHuggingFaceReference` would refuse — including
 * reserved Hub route names such as `datasets/...`.
 */
function parseIdentity(
  row: Record<string, unknown>,
): HuggingFaceRepositoryIdentity | null {
  const id = typeof row['id'] === 'string' ? row['id'] : null
  if (!id) return null
  return parseHuggingFaceRepositoryId(id)
}

function parseRevision(row: Record<string, unknown>): HuggingFaceRevision {
  const sha = row['sha']
  if (sha === undefined || sha === null) {
    return { state: 'unknown', commit: null, source: 'not_reported' }
  }
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/u.test(sha)) {
    return { state: 'unknown', commit: null, source: 'malformed' }
  }
  return { state: 'exact_commit', commit: sha, source: 'hugging_face_api_model' }
}

function parseGated(row: Record<string, unknown>): HuggingFaceGatedState {
  const gated = row['gated']
  if (gated === false) return { state: 'open', mode: null }
  if (gated === 'auto') return { state: 'gated', mode: 'auto' }
  if (gated === 'manual') return { state: 'gated', mode: 'manual' }
  if (gated === true) return { state: 'gated', mode: 'unspecified' }
  return { state: 'unknown', mode: null }
}

/**
 * License is read from author-declared `license:` tags. It is a claim, never a legal
 * review, and two different declarations are a conflict rather than a pick.
 */
function parseLicense(row: Record<string, unknown>): HuggingFaceLicenseState {
  const tags = row['tags']
  if (!Array.isArray(tags)) {
    return {
      state: 'unknown',
      value: null,
      source: Object.hasOwn(row, 'tags') ? 'malformed' : 'not_reported',
      confidence: 'unknown',
    }
  }
  const declared = new Set<string>()
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    if (!tag.toLowerCase().startsWith('license:')) continue
    const value = tag.slice('license:'.length).trim()
    if (value.length > 0) declared.add(value)
  }
  if (declared.size === 0) {
    return {
      state: 'unknown', value: null, source: 'not_reported', confidence: 'unknown',
    }
  }
  if (declared.size > 1) {
    return {
      state: 'unknown',
      value: null,
      source: 'conflicting_declarations',
      confidence: 'unknown',
    }
  }
  return {
    state: 'declared',
    value: [...declared][0]!,
    source: 'hugging_face_model_tags',
    confidence: 'declared',
  }
}

function isGgufPath(path: string): boolean {
  return path.toLowerCase().endsWith('.gguf')
}

/**
 * Projects the Hub `siblings` listing into a bounded inventory. `truncated` records
 * that the listing was cut, which is what keeps "no GGUF seen" from being published
 * as proof that the repository has no GGUF.
 */
function parseFiles(row: Record<string, unknown>): HuggingFaceFileInventory {
  const siblings = row['siblings']
  if (!Array.isArray(siblings)) {
    return {
      state: 'unknown',
      source: Object.hasOwn(row, 'siblings') ? 'malformed' : 'not_reported',
      totalFiles: null,
      malformedEntries: null,
      truncated: null,
      ggufFiles: [],
    }
  }

  const truncated = siblings.length > HUGGING_FACE_MAX_FILE_ENTRIES
  const considered = truncated
    ? siblings.slice(0, HUGGING_FACE_MAX_FILE_ENTRIES)
    : siblings

  const ggufFiles: HuggingFaceGgufFile[] = []
  const seen = new Set<string>()
  let malformedEntries = 0
  for (const entry of considered) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      malformedEntries += 1
      continue
    }
    const record = entry as Record<string, unknown>
    const path = record['rfilename']
    if (typeof path !== 'string' || path.length === 0) {
      malformedEntries += 1
      continue
    }
    if (!isGgufPath(path)) continue
    // A duplicate path is a malformed listing, not two files.
    if (seen.has(path)) {
      malformedEntries += 1
      continue
    }
    seen.add(path)

    const rawSize = record['size']
    const sizeReported =
      typeof rawSize === 'number'
      && Number.isSafeInteger(rawSize)
      && rawSize >= 0
    ggufFiles.push({
      path,
      sizeBytes: sizeReported ? rawSize : null,
      sizeSource: sizeReported ? 'hugging_face_api_model' : 'not_reported',
    })
  }

  return {
    state: 'listed',
    source: 'hugging_face_api_model',
    totalFiles: considered.length,
    malformedEntries,
    truncated,
    ggufFiles,
  }
}

/**
 * The single place the support verdict is decided.
 *
 * `supported` requires exact GGUF evidence. `unsupported` requires a *complete*
 * listing that proves their absence. Truncation or malformed entries are neither, so
 * they yield `unknown` with a reason. Gated state and license never move the verdict.
 */
export function decideVerdict(files: HuggingFaceFileInventory): HuggingFaceSupportVerdict {
  if (files.state !== 'listed') {
    return {
      state: 'unknown',
      scope: 'exact_gguf_file_only',
      basis: 'insufficient_evidence',
      reason:
        files.source === 'metadata_unavailable'
          ? 'metadata_unavailable'
          : files.source === 'malformed'
            ? 'file_entries_malformed'
            : 'file_inventory_unavailable',
      requiresExactFileSelection: true,
    }
  }

  if (files.ggufFiles.length > 0) {
    return {
      state: 'supported',
      scope: 'exact_gguf_file_only',
      basis: 'exact_gguf_files_listed',
      reason: null,
      requiresExactFileSelection: true,
    }
  }

  if (files.truncated) {
    return {
      state: 'unknown',
      scope: 'exact_gguf_file_only',
      basis: 'insufficient_evidence',
      reason: 'file_listing_truncated',
      requiresExactFileSelection: true,
    }
  }

  if (files.malformedEntries > 0) {
    return {
      state: 'unknown',
      scope: 'exact_gguf_file_only',
      basis: 'insufficient_evidence',
      reason: 'file_entries_malformed',
      requiresExactFileSelection: true,
    }
  }

  return {
    state: 'unsupported',
    scope: 'exact_gguf_file_only',
    basis: 'complete_listing_without_gguf',
    reason: null,
    requiresExactFileSelection: true,
  }
}

/**
 * Projects one Hub row into one contract repository row, or `null` when the row is not
 * even identifiable. `expectedIdentity` pins a detail read to the identity that was
 * requested, so a redirected or mismatched payload cannot be published as that
 * repository's facts.
 */
export function buildRepositoryFromHub(
  row: unknown,
  observedAt: string,
  expectedIdentity?: HuggingFaceRepositoryIdentity,
): HuggingFaceRepository | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const record = row as Record<string, unknown>

  const identity = parseIdentity(record)
  if (!identity) return null
  if (
    expectedIdentity
    && identity.comparisonKey !== expectedIdentity.comparisonKey
  ) {
    return null
  }

  const files = parseFiles(record)
  return {
    version: HUGGING_FACE_DISCOVERY_VERSION,
    provider: 'hugging_face',
    identity: expectedIdentity ?? identity,
    metadata: 'resolved',
    observedAt,
    revision: parseRevision(record),
    gated: parseGated(record),
    license: parseLicense(record),
    files,
    verdict: decideVerdict(files),
  }
}

/**
 * Extracts the opaque `cursor` value from a Hub `Link: <…>; rel="next"` header.
 *
 * The Link URL must point at the documented Hub origin, so a hostile header cannot
 * redirect the next page read. `rel` is matched as a whole token, not a substring, so
 * `rel="next-page"` is a different relation and is ignored.
 *
 * The cursor is opaque and only ever echoed back, but it is still character-checked:
 * a control character or whitespace in a value that later reaches a log line or a
 * header would be an injection vector, so such a cursor is refused outright rather
 * than relying on re-encoding at the point of use.
 */
export function nextCursorFromLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/u.exec(part)
    if (!match) continue
    const [, target, attributes] = match
    if (!target || !attributes) continue
    const isNext = attributes
      .split(';')
      .some((attribute) => {
        const relation = /^\s*rel\s*=\s*"?([^";]*)"?\s*$/u.exec(attribute)?.[1]
        return relation !== undefined && relation.trim().toLowerCase() === 'next'
      })
    if (!isNext) continue
    let url: URL
    try {
      url = new URL(target, HUB_ORIGIN)
    } catch {
      return null
    }
    if (url.origin !== HUB_ORIGIN) return null
    const cursor = url.searchParams.get('cursor')
    if (!cursor || cursor.length === 0 || cursor.length > 2_048) return null
    if (/[\u0000-\u0020\u007f\s]/u.test(cursor)) return null
    return cursor
  }
  return null
}
