/**
 * P2-L connection-owned exact GGUF download.
 *
 * The operation is intentionally not a durable Job: one POST+SSE connection owns it,
 * disconnect/cancel aborts it, and process restart starts no recovery. Only a fully
 * hashed and header-inspected blob is atomically linked into the managed staging root.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  HUGGING_FACE_DOWNLOAD_VERSION,
  type HuggingFaceDownloadFailureReason,
  type HuggingFaceDownloadProvenance,
  type HuggingFaceDownloadRefusalReason,
  type HuggingFaceDownloadStreamEvent,
  type HuggingFaceSelectionResult,
} from '@alamo/contract'

const HUB_ORIGIN = 'https://huggingface.co'

/** Exact host list from the official HF firewall/download documentation, 2026-08-09. */
export const HUGGING_FACE_DOWNLOAD_ALLOWED_HOSTS = new Set([
  'huggingface.co',
  'cas-server.xethub.hf.co',
  'cas-server.xethub-eu.hf.co',
  'transfer.xethub.hf.co',
  'transfer.xethub-eu.hf.co',
  'us.aws.cdn.hf.co',
  'us.gcp.cdn.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
])

export const HUGGING_FACE_DOWNLOAD_CONNECT_TIMEOUT_MS = 12_000
export const HUGGING_FACE_DOWNLOAD_BODY_TIMEOUT_MS = 30_000
export const HUGGING_FACE_DOWNLOAD_MAX_REDIRECTS = 4
/** Security/resource-policy bound, not a UI ceiling or a capability claim. */
export const HUGGING_FACE_DOWNLOAD_MAX_BYTES = 50_000_000_000

type ConfirmedSelection = Extract<HuggingFaceSelectionResult, { state: 'confirmed' }>

export interface HuggingFaceDownloadOptions {
  rootDir: string
  fetch?: typeof fetch
  connectTimeoutMs?: number
  bodyTimeoutMs?: number
  maxRedirects?: number
  maxBytes?: number
  now?: () => Date
  randomId?: () => string
}

class DownloadRefusal extends Error {
  readonly reason: HuggingFaceDownloadRefusalReason

  constructor(reason: HuggingFaceDownloadRefusalReason) {
    super(reason)
    this.reason = reason
  }
}

class DownloadFailure extends Error {
  readonly reason: HuggingFaceDownloadFailureReason

  constructor(reason: HuggingFaceDownloadFailureReason) {
    super(reason)
    this.reason = reason
  }
}

function targetKey(selection: ConfirmedSelection): string {
  const { identity, revision, filePath } = selection.selection
  return `${identity.repositoryId}\n${revision.commit}\n${filePath}`
}

/** Encode each semantic segment independently; never interpolate the raw remote path. */
export function exactHuggingFaceDownloadUrl(selection: ConfirmedSelection): URL {
  const { identity, revision, filePath } = selection.selection
  const segments = [identity.owner, identity.name, 'resolve', revision.commit, ...filePath.split('/')]
  return new URL(`/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`, HUB_ORIGIN)
}

function assertAllowedRedirect(url: URL): void {
  if (
    url.protocol !== 'https:'
    || (url.port !== '' && url.port !== '443')
    || !HUGGING_FACE_DOWNLOAD_ALLOWED_HOSTS.has(url.hostname)
  ) {
    throw new DownloadRefusal('redirect_not_allowed')
  }
  if (url.username || url.password) throw new DownloadRefusal('redirect_not_allowed')
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new DownloadFailure('content_length_invalid')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new DownloadFailure('content_length_invalid')
  return parsed
}

function expectedChecksum(selection: ConfirmedSelection): string | null {
  if (selection.repository.files.state !== 'listed') return null
  const file = selection.repository.files.ggufFiles.find(
    (candidate) => candidate.path === selection.selection.filePath,
  )
  return file?.sha256Source === 'hugging_face_lfs_oid' ? file.sha256 ?? null : null
}

function inspectGguf(header: Uint8Array): { version: 2 | 3 } {
  if (header.byteLength < 8) throw new DownloadFailure('invalid_gguf_header')
  if (
    header[0] !== 0x47
    || header[1] !== 0x47
    || header[2] !== 0x55
    || header[3] !== 0x46
  ) {
    throw new DownloadFailure('invalid_gguf_magic')
  }
  const version = new DataView(header.buffer, header.byteOffset + 4, 4).getUint32(0, true)
  if (version !== 2 && version !== 3) throw new DownloadFailure('unsupported_gguf_version')
  return { version }
}

async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) throw new DownloadFailure('filesystem_error')
    offset += bytesWritten
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  signal.throwIfAborted()
  return new Promise((resolveRead, rejectRead) => {
    const onAbort = () => rejectRead(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolveRead(result)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        rejectRead(error)
      },
    )
  })
}

function cancellationReason(signal: AbortSignal): 'user_requested' | 'connection_closed' | 'request_cancelled' {
  if (signal.reason === 'hf-download-user-cancelled') return 'user_requested'
  if (signal.reason === 'hf-download-connection-closed') return 'connection_closed'
  return 'request_cancelled'
}

export class HuggingFaceDownloadService {
  private readonly rootDir: string
  private readonly fetchImpl: typeof fetch
  private readonly connectTimeoutMs: number
  private readonly bodyTimeoutMs: number
  private readonly maxRedirects: number
  private readonly maxBytes: number
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly active = new Set<string>()

  constructor(options: HuggingFaceDownloadOptions) {
    this.rootDir = resolve(options.rootDir)
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.connectTimeoutMs = options.connectTimeoutMs ?? HUGGING_FACE_DOWNLOAD_CONNECT_TIMEOUT_MS
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? HUGGING_FACE_DOWNLOAD_BODY_TIMEOUT_MS
    this.maxRedirects = options.maxRedirects ?? HUGGING_FACE_DOWNLOAD_MAX_REDIRECTS
    this.maxBytes = options.maxBytes ?? HUGGING_FACE_DOWNLOAD_MAX_BYTES
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
  }

  async *download(
    selection: ConfirmedSelection,
    signal: AbortSignal,
  ): AsyncGenerator<HuggingFaceDownloadStreamEvent> {
    let seq = 0
    const event = <T extends HuggingFaceDownloadStreamEvent>(value: Omit<T, 'seq'>): T => (
      { ...value, seq: seq++ } as T
    )
    const key = targetKey(selection)
    let owned = false
    let temporaryPath: string | null = null
    let temporaryOwned = false
    let committed = false

    yield event({
      type: 'state',
      data: { version: HUGGING_FACE_DOWNLOAD_VERSION, state: 'preparing' },
    })

    try {
      signal.throwIfAborted()
      if (selection.repository.gated.state !== 'open') {
        throw new DownloadRefusal('gated_repository')
      }
      if (this.active.has(key)) throw new DownloadRefusal('duplicate_active')
      this.active.add(key)
      owned = true

      const expectedSize = selection.selection.sizeBytes
      if (expectedSize !== null && expectedSize > this.maxBytes) {
        throw new DownloadFailure('maximum_bytes_exceeded')
      }

      await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
      const rootStat = await lstat(this.rootDir)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new DownloadFailure('filesystem_error')
      }
      const artifactId = this.randomId()
      const temporaryId = this.randomId()
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      if (!uuid.test(artifactId) || !uuid.test(temporaryId)) {
        throw new DownloadFailure('filesystem_error')
      }
      temporaryPath = join(this.rootDir, `.${temporaryId}.partial`)
      const finalPath = join(this.rootDir, `${artifactId}.gguf`)
      let file: FileHandle | null = null

      try {
        file = await open(temporaryPath, 'wx', 0o600)
        temporaryOwned = true
        const response = await this.fetchExact(exactHuggingFaceDownloadUrl(selection), signal)
        const contentLength = parseContentLength(response.headers.get('content-length'))
        if (contentLength !== null && contentLength > this.maxBytes) {
          throw new DownloadFailure('maximum_bytes_exceeded')
        }
        if (expectedSize !== null && contentLength !== null && expectedSize !== contentLength) {
          throw new DownloadFailure('size_mismatch')
        }
        if (!response.body) throw new DownloadFailure('provider_error')

        const totalBytes = contentLength ?? expectedSize
        const reader = response.body.getReader()
        const hash = createHash('sha256')
        const header = new Uint8Array(8)
        let headerBytes = 0
        let observedSize = 0
        let bodyTimedOut = false
        let bodyTimer: ReturnType<typeof setTimeout> | null = null
        const bodyController = new AbortController()
        const resetBodyTimer = () => {
          if (bodyTimer) clearTimeout(bodyTimer)
          bodyTimer = setTimeout(() => {
            bodyTimedOut = true
            bodyController.abort('alamo:hugging-face-download-body-timeout')
          }, this.bodyTimeoutMs)
        }
        const composed = AbortSignal.any([signal, bodyController.signal])
        resetBodyTimer()
        try {
          for (;;) {
            let result: Awaited<ReturnType<typeof reader.read>>
            try {
              result = await readWithAbort(reader, composed)
            } catch (error) {
              if (signal.aborted) throw error
              if (bodyTimedOut) throw new DownloadFailure('body_timeout')
              throw new DownloadFailure('provider_unavailable')
            }
            if (result.done) break
            resetBodyTimer()
            const chunk = result.value
            if (!chunk || chunk.byteLength === 0) continue
            observedSize += chunk.byteLength
            if (observedSize > this.maxBytes) throw new DownloadFailure('maximum_bytes_exceeded')
            if (contentLength !== null && observedSize > contentLength) {
              throw new DownloadFailure('size_mismatch')
            }
            if (expectedSize !== null && observedSize > expectedSize) {
              throw new DownloadFailure('size_mismatch')
            }
            if (headerBytes < header.byteLength) {
              const copied = Math.min(header.byteLength - headerBytes, chunk.byteLength)
              header.set(chunk.subarray(0, copied), headerBytes)
              headerBytes += copied
            }
            hash.update(chunk)
            try {
              await writeAll(file, chunk)
            } catch (error) {
              if (error instanceof DownloadFailure) throw error
              throw new DownloadFailure('filesystem_error')
            }
            yield event({
              type: 'progress',
              data: {
                version: HUGGING_FACE_DOWNLOAD_VERSION,
                state: 'downloading',
                completedBytes: observedSize,
                totalBytes,
              },
            })
          }
        } finally {
          if (bodyTimer) clearTimeout(bodyTimer)
          void reader.cancel().catch(() => {})
          if (!bodyController.signal.aborted) bodyController.abort('download-body-complete')
        }

        signal.throwIfAborted()
        if (expectedSize !== null && observedSize !== expectedSize) {
          throw new DownloadFailure('size_mismatch')
        }
        if (contentLength !== null && observedSize !== contentLength) {
          throw new DownloadFailure('size_mismatch')
        }

        yield event({
          type: 'state',
          data: { version: HUGGING_FACE_DOWNLOAD_VERSION, state: 'verifying' },
        })
        signal.throwIfAborted()
        const format = inspectGguf(header.subarray(0, headerBytes))
        const observedDigest = hash.digest('hex')
        const providerDigest = expectedChecksum(selection)
        if (providerDigest !== null && providerDigest !== observedDigest) {
          throw new DownloadFailure('checksum_mismatch')
        }

        try {
          await file.sync()
          await file.close()
          file = null
          signal.throwIfAborted()
          const currentRootStat = await lstat(this.rootDir)
          if (
            !currentRootStat.isDirectory()
            || currentRootStat.isSymbolicLink()
            || currentRootStat.dev !== rootStat.dev
            || currentRootStat.ino !== rootStat.ino
          ) {
            throw new DownloadFailure('filesystem_error')
          }
          // link() is an atomic no-overwrite commit: collision/symlink targets fail EEXIST.
          await link(temporaryPath, finalPath)
          committed = true
          await unlink(temporaryPath).catch(() => {})
          temporaryOwned = false
          temporaryPath = null
        } catch (error) {
          if (error instanceof DownloadFailure) throw error
          throw new DownloadFailure('filesystem_error')
        }

        const provenance: HuggingFaceDownloadProvenance = {
          version: HUGGING_FACE_DOWNLOAD_VERSION,
          identity: selection.selection.identity,
          revision: selection.selection.revision,
          remotePath: selection.selection.filePath,
          license: selection.repository.license,
          gated: selection.repository.gated,
          sourceUrlPolicy: 'hugging_face_exact_revision_explicit_hosts_v1',
          expectedSizeBytes: expectedSize,
          observedSizeBytes: observedSize,
          checksum: {
            algorithm: 'sha256',
            expectedDigest: providerDigest,
            observedDigest,
            relation: providerDigest === null
              ? 'locally_observed_only'
              : 'matched_provider_claim',
          },
          format: {
            kind: 'gguf', magic: 'GGUF', version: format.version,
            inspection: 'bounded_header_only',
          },
          artifact: { state: 'managed_staging', id: artifactId },
          observedAt: this.now().toISOString(),
          terminalState: 'completed',
        }
        yield event({
          type: 'completed',
          data: { version: HUGGING_FACE_DOWNLOAD_VERSION, state: 'completed', provenance },
        })
      } finally {
        await file?.close().catch(() => {})
      }
    } catch (error) {
      if (signal.aborted) {
        yield event({
          type: 'cancelled',
          data: {
            version: HUGGING_FACE_DOWNLOAD_VERSION,
            state: 'cancelled',
            reason: cancellationReason(signal),
          },
        })
      } else if (error instanceof DownloadRefusal) {
        yield event({
          type: 'refused',
          data: { version: HUGGING_FACE_DOWNLOAD_VERSION, state: 'refused', reason: error.reason },
        })
      } else {
        yield event({
          type: 'failed',
          data: {
            version: HUGGING_FACE_DOWNLOAD_VERSION,
            state: 'failed',
            reason: error instanceof DownloadFailure ? error.reason : 'filesystem_error',
          },
        })
      }
    } finally {
      if (!committed && temporaryOwned && temporaryPath !== null) {
        await unlink(temporaryPath).catch(() => {})
      }
      if (owned) this.active.delete(key)
    }
  }

  private async fetchExact(initialUrl: URL, signal: AbortSignal): Promise<Response> {
    let url = initialUrl
    for (let redirects = 0;; redirects += 1) {
      assertAllowedRedirect(url)
      signal.throwIfAborted()
      const controller = new AbortController()
      const composed = AbortSignal.any([signal, controller.signal])
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort('alamo:hugging-face-download-connect-timeout')
      }, this.connectTimeoutMs)
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: composed,
          headers: {
            accept: 'application/octet-stream',
            // Anonymous P2-L: no Authorization/Cookie/credentials to forward.
          },
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new DownloadFailure(timedOut ? 'connect_timeout' : 'provider_unavailable')
      } finally {
        clearTimeout(timer)
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        if (redirects >= this.maxRedirects) {
          throw new DownloadRefusal('redirect_limit_exceeded')
        }
        const location = response.headers.get('location')
        if (!location) throw new DownloadRefusal('redirect_not_allowed')
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new DownloadRefusal('redirect_not_allowed')
        }
        assertAllowedRedirect(next)
        url = next
        continue
      }
      // P2-L has no Range/resume semantics: only a complete 200 response can be committed.
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadFailure('provider_error')
      }
      return response
    }
  }
}
