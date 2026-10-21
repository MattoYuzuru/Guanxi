/**
 * Session-owned, content-addressed input artifacts (K4 bounded input slice).
 *
 * Root: `<dataDir>/session-artifacts/<sha256(sessionId)>/`, directory `0700`,
 * file `0400`, filename the lowercase digest. The directory key is derived,
 * never a user path or raw session id. The full bytes are internal to the
 * session log for replay; REST, export, search and query see only the scrubbed
 * excerpt that travels in the v2 event.
 *
 * The directory identity is verified by the pinned helper before any payload
 * byte leaves the parent; writes, publishes, reads and temporary cleanup are
 * relative to the helper's `cwd`. A replaced parent cannot redirect content and
 * a published digest is never unlinked by a failing writer.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  SESSION_INPUT_JSON_MEDIA_TYPE,
  SESSION_INPUT_TEXT_MEDIA_TYPE,
  sessionInputMediaTypeSchema,
  type SessionInputMediaType,
  type SessionInputArtifactRef,
} from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import {
  PinnedDirectoryError,
  directoryIdentity,
  relativeDirectoryOperation,
  type RelativeDirectoryIdentity,
} from '../store/pinned-directory.ts'

export type SessionInputErrorCode =
  | 'invalid_input'
  | 'unsafe_storage'
  | 'integrity_mismatch'
  | 'not_found'
  | 'storage_failure'
  | 'aborted'

export class SessionInputError extends Error {
  readonly code: SessionInputErrorCode

  constructor(code: SessionInputErrorCode, message: string) {
    super(message)
    this.name = 'SessionInputError'
    this.code = code
  }
}

export interface SessionInputStoreHooks {
  /** After the trusted directory identity is captured, before the helper starts. */
  beforeHelperStart?(): void | Promise<void>
  /** After the helper handshake is validated, before its first command byte. */
  beforeWrite?(): void | Promise<void>
  beforeRead?(): void | Promise<void>
}

export interface SessionInputStoreOptions {
  dataDir: string
  db: Db
  helperTimeoutMs?: number
  hooks?: SessionInputStoreHooks
  now?: () => number
}

export interface SessionInputReapOptions {
  /** Session ids with a live writer or pre-admission owner in this process. */
  isLive(sessionId: string): boolean
  /** The same ids, used to keep their directories from the orphan scan. */
  liveSessionIds?: readonly string[]
  /** Re-checks the R1 home fence before a destructive filesystem step. */
  assertHome(): void
  now?: () => number
  tempGraceMs?: number
  /** Test seam: runs after the quarantine rename and before the remove re-check. */
  beforeQuarantineRemove?(): void | Promise<void>
}

export interface SessionInputReapResult {
  removedDirectories: number
  quarantinedKept: number
  removedTemps: number
}

export interface SessionInputWrite {
  checksum: string
  byteSize: number
}

/** The append-time descriptor a producer passes to the log. */
export interface SessionInputArtifactDescriptor extends SessionInputWrite {
  mediaType: SessionInputMediaType
  excerpt: string
}

const DIGEST = /^[0-9a-f]{64}$/u
const DEFAULT_TEMP_GRACE_MS = 60 * 60 * 1_000

export function sessionInputDirectoryName(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

/** A UTF-8-safe prefix of at most `maxBytes` bytes. */
export function utf8Excerpt(text: string, maxBytes = INPUT_EXCERPT_BYTES): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export function inputMediaTypeFor(type: 'prompt' | 'tool.call'): SessionInputMediaType {
  return type === 'prompt' ? SESSION_INPUT_TEXT_MEDIA_TYPE : SESSION_INPUT_JSON_MEDIA_TYPE
}

export function isInlineInput(bytes: number): boolean {
  return bytes <= INPUT_INLINE_BYTES
}

function inside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}

function storageError(error: unknown): SessionInputError {
  if (error instanceof SessionInputError) return error
  if (error instanceof PinnedDirectoryError) return new SessionInputError(error.code, error.message)
  return new SessionInputError('storage_failure', 'Session input storage operation failed')
}

export class SessionInputStore {
  private readonly dataDir: string
  private readonly db: Db
  private readonly helperTimeoutMs: number
  private readonly hooks: SessionInputStoreHooks
  private readonly now: () => number
  private canonicalRoot: string | null = null

  constructor(options: SessionInputStoreOptions) {
    this.dataDir = options.dataDir
    this.db = options.db
    this.helperTimeoutMs = options.helperTimeoutMs ?? 30_000
    this.hooks = options.hooks ?? {}
    this.now = options.now ?? (() => Date.now())
    if (!Number.isSafeInteger(this.helperTimeoutMs) || this.helperTimeoutMs < 1) {
      throw new SessionInputError('invalid_input', 'Session input helper timeout is invalid')
    }
  }

  directoryFor(sessionId: string): string {
    return join(this.canonicalRootPath(), sessionInputDirectoryName(sessionId))
  }

  /** Root path before canonicalisation; safe for tests to inspect after a write. */
  private canonicalRootPath(): string {
    return this.canonicalRoot ?? join(this.dataDir, 'session-artifacts')
  }

  private async ensureRoot(): Promise<string> {
    const root = join(this.dataDir, 'session-artifacts')
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw storageError(error)
    }
    let state
    try {
      state = await lstat(root)
    } catch (error) {
      throw storageError(error)
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new SessionInputError('unsafe_storage', 'Session input storage boundary is unsafe')
    }
    const canonical = await realpath(root)
    if (this.canonicalRoot !== null && this.canonicalRoot !== canonical) {
      throw new SessionInputError('unsafe_storage', 'Session input storage identity changed')
    }
    this.canonicalRoot = canonical
    return canonical
  }

  private async sessionDirectory(sessionId: string, create: boolean): Promise<RelativeDirectoryIdentity & { path: string }> {
    const root = await this.ensureRoot()
    const path = join(root, sessionInputDirectoryName(sessionId))
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw storageError(error)
      }
    } else {
      try {
        await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SessionInputError('not_found', 'Session input artifact is unavailable')
        }
        throw storageError(error)
      }
    }
    let identity: RelativeDirectoryIdentity
    try {
      identity = await directoryIdentity(path)
    } catch (error) {
      throw storageError(error)
    }
    if (!inside(root, identity.canonicalPath)) {
      throw new SessionInputError('unsafe_storage', 'Session input storage boundary is unsafe')
    }
    return { ...identity, path }
  }

  async write(
    sessionId: string,
    content: string | Uint8Array,
    mediaType: SessionInputMediaType,
    options: { signal?: AbortSignal } = {},
  ): Promise<SessionInputWrite> {
    const parsed = sessionInputMediaTypeSchema.safeParse(mediaType)
    if (!parsed.success) throw new SessionInputError('invalid_input', 'Session input media type is invalid')
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 0) {
      throw new SessionInputError('invalid_input', 'Session input content is invalid')
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    const directory = await this.sessionDirectory(sessionId, true)
    try {
      await relativeDirectoryOperation({
        parent: directory.path,
        name: digest,
        action: 'write',
        content: bytes,
        byteSize: bytes.byteLength,
        digest,
        beforeSpawn: this.hooks.beforeHelperStart,
        ready: this.hooks.beforeWrite,
        signal: options.signal,
        timeoutMs: this.helperTimeoutMs,
      })
    } catch (error) {
      throw storageError(error)
    }
    return { checksum: `sha256:${digest}`, byteSize: bytes.byteLength }
  }

  async read(
    sessionId: string,
    reference: Pick<SessionInputArtifactRef, 'artifactId' | 'checksum' | 'byteSize' | 'mediaType'>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    if (
      typeof reference.artifactId !== 'string'
      || typeof reference.checksum !== 'string'
      || !Number.isSafeInteger(reference.byteSize)
      || reference.byteSize < 0
      || !sessionInputMediaTypeSchema.safeParse(reference.mediaType).success
    ) {
      throw new SessionInputError('invalid_input', 'Session input reference is invalid')
    }
    const digest = reference.checksum.slice('sha256:'.length)
    if (reference.checksum.slice(0, 7) !== 'sha256:' || !DIGEST.test(digest)) {
      throw new SessionInputError('invalid_input', 'Session input reference is invalid')
    }
    const row = this.db.prepare(
      `SELECT artifact_id, checksum, byte_size, media_type
       FROM session_input_artifacts
       WHERE session_id = ? AND artifact_id = ?`,
    ).get(sessionId, reference.artifactId) as
      | { artifact_id: string; checksum: string; byte_size: number; media_type: string }
      | undefined
    if (
      !row
      || row.checksum !== reference.checksum
      || row.byte_size !== reference.byteSize
      || row.media_type !== reference.mediaType
    ) {
      throw new SessionInputError('not_found', 'Session input artifact is unavailable')
    }
    const directory = await this.sessionDirectory(sessionId, false)
    try {
      const content = await relativeDirectoryOperation({
        parent: directory.path,
        name: digest,
        action: 'read',
        byteSize: reference.byteSize,
        digest,
        ready: this.hooks.beforeRead,
        signal: options.signal,
        timeoutMs: this.helperTimeoutMs,
      })
      if (content === null) throw new SessionInputError('integrity_mismatch', 'Session input integrity check failed')
      return content
    } catch (error) {
      throw storageError(error)
    }
  }

  async remove(sessionId: string): Promise<void> {
    const root = await this.ensureRoot()
    const path = join(root, sessionInputDirectoryName(sessionId))
    try {
      const state = await lstat(path)
      if (state.isSymbolicLink()) {
        await unlink(path)
        return
      }
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw storageError(error)
    }
  }

  /**
   * Removes a session-artifacts directory with no `sessions` row and no live
   * owner. The directory is first renamed to a random quarantine name; a
   * session row or live owner appearing before removal keeps the quarantined
   * bytes instead of merging them into the new session. Stale temporary files
   * of known sessions are removed only when no live writer owns the session.
   */
  async reap(options: SessionInputReapOptions): Promise<SessionInputReapResult> {
    const root = await this.ensureRoot()
    const now = options.now ?? this.now
    const grace = options.tempGraceMs ?? DEFAULT_TEMP_GRACE_MS
    const liveHashes = new Set<string>()
    const hashToId = new Map<string, string>()
    for (const row of this.db.prepare('SELECT id FROM sessions').iterate() as Iterable<{ id: string }>) {
      const hash = sessionInputDirectoryName(row.id)
      liveHashes.add(hash)
      hashToId.set(hash, row.id)
    }
    for (const id of options.liveSessionIds ?? []) {
      liveHashes.add(sessionInputDirectoryName(id))
    }
    let removedDirectories = 0
    let quarantinedKept = 0
    let removedTemps = 0
    const entries: string[] = []
    const directory = await opendir(root)
    for await (const entry of directory) entries.push(entry.name)
    for (const name of entries) {
      if (DIGEST.test(name)) {
        const known = liveHashes.has(name)
        if (!known) {
          options.assertHome()
          const quarantine = join(root, `.orphan-${randomUUID()}`)
          try {
            await rename(join(root, name), quarantine)
          } catch {
            continue
          }
          await options.beforeQuarantineRemove?.()
          options.assertHome()
          const recheck = new Set<string>(liveHashes)
          for (const row of this.db.prepare('SELECT id FROM sessions').iterate() as Iterable<{ id: string }>) {
            recheck.add(sessionInputDirectoryName(row.id))
          }
          for (const id of options.liveSessionIds ?? []) recheck.add(sessionInputDirectoryName(id))
          if (recheck.has(name)) {
            quarantinedKept += 1
            continue
          }
          try {
            const state = await lstat(quarantine)
            if (state.isSymbolicLink() || !state.isDirectory()) {
              await unlink(quarantine)
              removedDirectories += 1
              continue
            }
            // Remove only the identity captured immediately after the rename.
            const after = await lstat(quarantine)
            if (after.dev !== state.dev || after.ino !== state.ino) continue
            await rm(quarantine, { recursive: true, force: true })
            removedDirectories += 1
          } catch {
            // A replaced quarantine stays for the next pass instead of being followed.
          }
          continue
        }
        const sessionId = hashToId.get(name) ?? null
        if (sessionId !== null && options.isLive(sessionId)) continue
        try {
          const target = join(root, name)
          const state = await lstat(target)
          if (!state.isDirectory() || state.isSymbolicLink()) continue
          const sessionDir = await opendir(target)
          for await (const entry of sessionDir) {
            if (!entry.name.startsWith('.partial-') || entry.isSymbolicLink()) continue
            const file = join(target, entry.name)
            try {
              const fileState = await lstat(file)
              if (!fileState.isFile() || now() - fileState.mtimeMs < grace) continue
              await unlink(file)
              removedTemps += 1
            } catch {
              // A live helper may have published and unlinked it already.
            }
          }
        } catch {
          // Unavailable storage is retried next pass.
        }
      }
    }
    return { removedDirectories, quarantinedKept, removedTemps }
  }
}
