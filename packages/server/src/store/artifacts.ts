import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import {
  ARTIFACT_VERSION,
  artifactCreateMetadataSchema,
  artifactIdSchema,
  artifactSchema,
  artifactScopeSchema,
  type Artifact,
  type ArtifactCreateMetadata,
  type ArtifactScope,
} from '@alamo/contract'
import type { Db } from './db.ts'

const STORAGE_KEY = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/u
const RELATIVE_FILE_HELPER = String.raw`
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, stat } from 'node:fs/promises'

const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const directory = await stat('.')
send({ state: 'ready', cwd: process.cwd(), dev: String(directory.dev), ino: String(directory.ino) })
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
  const command = JSON.parse(input)
  if (!/^[0-9a-f]{64}$/u.test(command.name)) throw new Error('invalid_name')
  let published = false
  if (command.action === 'publish') {
    try {
      await link(command.source, command.name)
      published = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  } else if (command.action !== 'read') {
    throw new Error('invalid_action')
  }
  const file = await open(command.name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.size !== command.byteSize) throw new Error('integrity')
    const hash = createHash('sha256')
    const buffers = []
    let total = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength)
      if (bytesRead === 0) break
      total += bytesRead
      if (!Number.isSafeInteger(total) || total > command.byteSize) throw new Error('integrity')
      const value = Buffer.from(buffer.subarray(0, bytesRead))
      hash.update(value)
      if (command.action === 'read') buffers.push(value)
    }
    if (total !== command.byteSize || hash.digest('hex') !== command.digest) {
      throw new Error('integrity')
    }
    if (published) {
      const parent = await open('.', constants.O_RDONLY)
      try { await parent.sync() } finally { await parent.close() }
    }
    send({
      state: 'verified',
      content: command.action === 'read' ? Buffer.concat(buffers, total).toString('base64') : null,
    })
  } finally {
    await file.close()
  }
} catch (error) {
  send({
    state: 'failed',
    code: ['ELOOP', 'ENOTDIR'].includes(error?.code) ? 'unsafe' : 'invalid',
  })
  process.exitCode = 1
}
`

export type ArtifactStoreErrorCode =
  | 'invalid_input'
  | 'size_limit_exceeded'
  | 'unsafe_storage'
  | 'integrity_mismatch'
  | 'idempotency_conflict'
  | 'invalid_reference'
  | 'not_found'
  | 'storage_failure'

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message)
    this.name = 'ArtifactStoreError'
    this.code = code
  }
}

interface ArtifactRow {
  id: string
  artifact_version: number
  write_intent_key: string
  kind: string
  media_type: string
  blob_checksum: string
  byte_size: number
  storage_key: string
  project_id: string | null
  source_job_id: string | null
  parent_artifact_id: string | null
  retention_mode: string
  reference_state: string
  created_at: string
}

interface RelativeDirectoryIdentity {
  canonicalPath: string
  dev: string
  ino: string
}

export interface ArtifactStoreHooks {
  afterTempWrite?(): void | Promise<void>
  beforePublish?(): void | Promise<void>
  afterPublish?(): void | Promise<void>
  beforeDatabase?(): void
  beforeRead?(): void | Promise<void>
}

export interface ArtifactStoreOptions {
  db: Db
  rootDir: string
  now?: () => Date
  randomId?: () => string
  hooks?: ArtifactStoreHooks
}

export interface ArtifactWriteOptions {
  /** Explicit policy envelope supplied by the caller; this is not a UI/capability ceiling. */
  maxBytes: number
}

export interface ArtifactReadOptions {
  /** Explicit allocation envelope for this buffered internal read. */
  maxBytes: number
}

export interface ArtifactDownloadHeaders {
  contentType: string
  contentLength: string
  digest: string
  etag: string
}

export interface ArtifactOrphanInventory {
  state: 'inventory_only_gc_not_implemented'
  storageKeys: string[]
  scannedEntries: number
  unsafeEntries: number
  truncated: boolean
  complete: boolean
}

type ArtifactBytes = Uint8Array | AsyncIterable<Uint8Array>

function projectId(metadata: ArtifactCreateMetadata): string | null {
  return metadata.ownership.scope === 'project' ? metadata.ownership.projectId : null
}

function storageKey(checksum: string): string {
  const digest = checksum.slice('sha256:'.length)
  return `sha256/${digest.slice(0, 2)}/${digest}`
}

function toArtifact(row: ArtifactRow): Artifact {
  return artifactSchema.parse({
    artifactVersion: row.artifact_version,
    id: row.id,
    kind: row.kind,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    checksum: row.blob_checksum,
    ownership: row.project_id === null
      ? { scope: 'projectless' }
      : { scope: 'project', projectId: row.project_id },
    source: {
      jobId: row.source_job_id,
      parentArtifactId: row.parent_artifact_id,
    },
    retention: { mode: row.retention_mode },
    reference: { state: row.reference_state },
    gc: { state: 'not_implemented' },
    createdAt: row.created_at,
  })
}

function sameIntentMetadata(row: ArtifactRow, metadata: ArtifactCreateMetadata): boolean {
  return row.artifact_version === metadata.artifactVersion
    && row.kind === metadata.kind
    && row.media_type === metadata.mediaType
    && row.project_id === projectId(metadata)
    && row.source_job_id === metadata.source.jobId
    && row.parent_artifact_id === metadata.source.parentArtifactId
}

function inside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}

async function directoryIdentity(path: string): Promise<RelativeDirectoryIdentity> {
  const state = await lstat(path)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new ArtifactStoreError('unsafe_storage', 'Artifact storage boundary is unsafe')
  }
  return {
    canonicalPath: await realpath(path),
    dev: String(state.dev),
    ino: String(state.ino),
  }
}

async function relativeFileOperation(input: {
  parent: string
  name: string
  action: 'publish' | 'read'
  source?: string
  byteSize: number
  digest: string
  ready?(): void | Promise<void>
}): Promise<Uint8Array | null> {
  const expected = await directoryIdentity(input.parent)
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', RELATIVE_FILE_HELPER],
    { cwd: input.parent, stdio: ['pipe', 'pipe', 'ignore'] },
  )
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', () => resolveExit({ code: null, signal: null }))
  })
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  try {
    const ready = await lines.next()
    if (ready.done) throw new ArtifactStoreError('unsafe_storage', 'Artifact storage helper failed')
    const identity = JSON.parse(ready.value) as Record<string, unknown>
    if (
      identity['state'] !== 'ready'
      || identity['cwd'] !== expected.canonicalPath
      || identity['dev'] !== expected.dev
      || identity['ino'] !== expected.ino
    ) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage identity changed')
    }
    await input.ready?.()
    child.stdin!.end(JSON.stringify({
      action: input.action,
      source: input.source,
      name: input.name,
      byteSize: input.byteSize,
      digest: input.digest,
    }))
    const response = await lines.next()
    const outcome = response.done ? null : JSON.parse(response.value) as Record<string, unknown>
    const exit = await exited
    if (outcome?.['state'] !== 'verified' || exit.code !== 0 || exit.signal !== null) {
      throw new ArtifactStoreError(
        outcome?.['code'] === 'unsafe'
          ? 'unsafe_storage'
          : outcome?.['code'] === 'invalid'
            ? 'integrity_mismatch'
            : 'storage_failure',
        'Artifact blob integrity check failed',
      )
    }
    const current = await directoryIdentity(input.parent)
    if (
      current.canonicalPath !== expected.canonicalPath
      || current.dev !== expected.dev
      || current.ino !== expected.ino
    ) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage identity changed')
    }
    if (input.action === 'publish') return null
    if (typeof outcome['content'] !== 'string') {
      throw new ArtifactStoreError('integrity_mismatch', 'Artifact blob integrity check failed')
    }
    const content = Buffer.from(outcome['content'], 'base64')
    if (content.byteLength !== input.byteSize) {
      throw new ArtifactStoreError('integrity_mismatch', 'Artifact blob integrity check failed')
    }
    return content
  } finally {
    child.stdin?.destroy()
    child.stdout?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) {
      throw new ArtifactStoreError('storage_failure', 'Artifact storage write failed')
    }
    offset += bytesWritten
  }
}

async function* chunks(content: ArtifactBytes): AsyncGenerator<Uint8Array> {
  if (content instanceof Uint8Array) {
    yield content
    return
  }
  for await (const chunk of content) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ArtifactStoreError('invalid_input', 'Artifact content must contain bytes')
    }
    yield chunk
  }
}

export class ArtifactStore {
  private readonly db: Db
  private readonly rootDir: string
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly hooks: ArtifactStoreHooks
  private canonicalRoot: string | null = null

  constructor(options: ArtifactStoreOptions) {
    this.db = options.db
    this.rootDir = resolve(options.rootDir)
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.hooks = options.hooks ?? {}
  }

  private rowByIntent(key: string): ArtifactRow | null {
    return (this.db.prepare(
      `SELECT artifact.*, blob.byte_size, blob.storage_key
       FROM artifacts artifact
       JOIN artifact_blobs blob ON blob.checksum = artifact.blob_checksum
       WHERE artifact.write_intent_key = ?`,
    ).get(key) as unknown as ArtifactRow | undefined) ?? null
  }

  private generatedId(): string {
    const id = this.randomId()
    if (!artifactIdSchema.safeParse(id).success) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage identifier is invalid')
    }
    return id
  }

  private rowById(id: string, scope: ArtifactScope): ArtifactRow | null {
    const scoped = scope.scope === 'project'
      ? this.db.prepare(
        `SELECT artifact.*, blob.byte_size, blob.storage_key
         FROM artifacts artifact
         JOIN artifact_blobs blob ON blob.checksum = artifact.blob_checksum
         WHERE artifact.id = ? AND artifact.project_id = ?`,
      ).get(id, scope.projectId)
      : this.db.prepare(
        `SELECT artifact.*, blob.byte_size, blob.storage_key
         FROM artifacts artifact
         JOIN artifact_blobs blob ON blob.checksum = artifact.blob_checksum
         WHERE artifact.id = ? AND artifact.project_id IS NULL`,
      ).get(id)
    return (scoped as unknown as ArtifactRow | undefined) ?? null
  }

  private async ensureDirectory(path: string, canonicalParent: string): Promise<string> {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const state = await lstat(path)
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage boundary is unsafe')
    }
    const canonical = await realpath(path)
    if (!inside(canonicalParent, canonical)) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage boundary is unsafe')
    }
    return canonical
  }

  private async ensureRoot(): Promise<{ root: string; temp: string; blobs: string }> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const rootState = await lstat(this.rootDir)
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage boundary is unsafe')
    }
    const canonicalRoot = await realpath(this.rootDir)
    if (this.canonicalRoot !== null && this.canonicalRoot !== canonicalRoot) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage identity changed')
    }
    this.canonicalRoot = canonicalRoot
    const temp = await this.ensureDirectory(join(this.rootDir, 'tmp'), canonicalRoot)
    const blobs = await this.ensureDirectory(join(this.rootDir, 'blobs'), canonicalRoot)
    const sha = await this.ensureDirectory(join(blobs, 'sha256'), canonicalRoot)
    return { root: canonicalRoot, temp, blobs: sha }
  }

  private async assertRootStable(): Promise<void> {
    if (this.canonicalRoot === null) throw new ArtifactStoreError('unsafe_storage', 'Artifact storage is unavailable')
    const state = await lstat(this.rootDir)
    const canonical = await realpath(this.rootDir)
    if (!state.isDirectory() || state.isSymbolicLink() || canonical !== this.canonicalRoot) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage identity changed')
    }
  }

  private async destination(checksum: string): Promise<{ key: string; path: string; parent: string }> {
    const root = await this.ensureRoot()
    const key = storageKey(checksum)
    const match = STORAGE_KEY.exec(key)
    if (!match || match[1] !== match[2]!.slice(0, 2)) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage key is invalid')
    }
    const parent = await this.ensureDirectory(join(root.blobs, match[1]!), root.root)
    const path = join(parent, match[2]!)
    if (!inside(root.root, path)) {
      throw new ArtifactStoreError('unsafe_storage', 'Artifact storage key is invalid')
    }
    return { key, path, parent }
  }

  async create(
    rawMetadata: ArtifactCreateMetadata,
    content: ArtifactBytes,
    options: ArtifactWriteOptions,
  ): Promise<Artifact> {
    const parsed = artifactCreateMetadataSchema.safeParse(rawMetadata)
    if (!parsed.success || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new ArtifactStoreError('invalid_input', 'Artifact write request is invalid')
    }
    const metadata = parsed.data
    const preexisting = this.rowByIntent(metadata.idempotencyKey)
    if (preexisting && !sameIntentMetadata(preexisting, metadata)) {
      throw new ArtifactStoreError('idempotency_conflict', 'Artifact intent conflicts with stored metadata')
    }

    let temporaryPath: string | null = null
    let temporaryFile: FileHandle | null = null
    try {
      const root = await this.ensureRoot()
      temporaryPath = join(root.temp, `${this.generatedId()}.partial`)
      temporaryFile = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      const hash = createHash('sha256')
      let byteSize = 0
      for await (const chunk of chunks(content)) {
        byteSize += chunk.byteLength
        if (!Number.isSafeInteger(byteSize) || byteSize > options.maxBytes) {
          throw new ArtifactStoreError('size_limit_exceeded', 'Artifact exceeds the write policy')
        }
        hash.update(chunk)
        await writeAll(temporaryFile, chunk)
      }
      await temporaryFile.sync()
      await this.hooks.afterTempWrite?.()
      await temporaryFile.close()
      temporaryFile = null

      const checksum = `sha256:${hash.digest('hex')}`
      const target = await this.destination(checksum)
      await this.assertRootStable()
      await relativeFileOperation({
        parent: target.parent,
        name: checksum.slice('sha256:'.length),
        action: 'publish',
        source: temporaryPath,
        byteSize,
        digest: checksum.slice('sha256:'.length),
        ready: this.hooks.beforePublish,
      })
      await this.hooks.afterPublish?.()
      this.hooks.beforeDatabase?.()

      this.db.exec('BEGIN IMMEDIATE')
      try {
        const existing = this.rowByIntent(metadata.idempotencyKey)
        if (existing) {
          if (!sameIntentMetadata(existing, metadata) || existing.blob_checksum !== checksum) {
            throw new ArtifactStoreError('idempotency_conflict', 'Artifact intent conflicts with stored content')
          }
          const artifact = toArtifact(existing)
          this.db.exec('COMMIT')
          return artifact
        }
        const createdAt = this.now().toISOString()
        this.db.prepare(
          `INSERT INTO artifact_blobs (checksum, byte_size, storage_key, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(checksum) DO NOTHING`,
        ).run(checksum, byteSize, target.key, createdAt)
        const blob = this.db.prepare(
          'SELECT byte_size, storage_key FROM artifact_blobs WHERE checksum = ?',
        ).get(checksum) as { byte_size: number; storage_key: string } | undefined
        if (!blob || blob.byte_size !== byteSize || blob.storage_key !== target.key) {
          throw new ArtifactStoreError('integrity_mismatch', 'Artifact blob metadata conflicts with content')
        }
        const id = this.generatedId()
        this.db.prepare(
          `INSERT INTO artifacts (
             id, artifact_version, write_intent_key, kind, media_type, blob_checksum,
             project_id, source_job_id, parent_artifact_id, retention_mode,
             reference_state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'keep', 'referenced', ?)`,
        ).run(
          id,
          ARTIFACT_VERSION,
          metadata.idempotencyKey,
          metadata.kind,
          metadata.mediaType,
          checksum,
          projectId(metadata),
          metadata.source.jobId,
          metadata.source.parentArtifactId,
          createdAt,
        )
        const row = this.rowByIntent(metadata.idempotencyKey)
        if (!row) throw new ArtifactStoreError('storage_failure', 'Artifact metadata was not committed')
        const artifact = toArtifact(row)
        this.db.exec('COMMIT')
        return artifact
      } catch (error) {
        this.db.exec('ROLLBACK')
        if (error instanceof ArtifactStoreError) throw error
        throw new ArtifactStoreError('invalid_reference', 'Artifact ownership or reference is invalid')
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError('storage_failure', 'Artifact storage operation failed')
    } finally {
      await temporaryFile?.close().catch(() => undefined)
      if (temporaryPath !== null) await unlink(temporaryPath).catch(() => undefined)
    }
  }

  get(id: string, rawScope: ArtifactScope): Artifact | null {
    if (!artifactIdSchema.safeParse(id).success) {
      throw new ArtifactStoreError('invalid_input', 'Artifact identifier is invalid')
    }
    const scope = artifactScopeSchema.safeParse(rawScope)
    if (!scope.success) throw new ArtifactStoreError('invalid_input', 'Artifact scope is invalid')
    const row = this.rowById(id, scope.data)
    return row ? toArtifact(row) : null
  }

  async read(
    id: string,
    rawScope: ArtifactScope,
    options: ArtifactReadOptions,
  ): Promise<{ artifact: Artifact; content: Uint8Array; headers: ArtifactDownloadHeaders }> {
    if (
      !artifactIdSchema.safeParse(id).success
      || !Number.isSafeInteger(options.maxBytes)
      || options.maxBytes < 0
    ) {
      throw new ArtifactStoreError('invalid_input', 'Artifact read policy is invalid')
    }
    const scope = artifactScopeSchema.safeParse(rawScope)
    if (!scope.success) throw new ArtifactStoreError('invalid_input', 'Artifact scope is invalid')
    const row = this.rowById(id, scope.data)
    if (!row) throw new ArtifactStoreError('not_found', 'Artifact is unavailable in this scope')
    if (row.byte_size > options.maxBytes) {
      throw new ArtifactStoreError('size_limit_exceeded', 'Artifact exceeds the read policy')
    }
    try {
      const root = await this.ensureRoot()
      await this.assertRootStable()
      const match = STORAGE_KEY.exec(row.storage_key)
      const digest = row.blob_checksum.slice('sha256:'.length)
      if (!match || match[1] !== digest.slice(0, 2) || match[2] !== digest) {
        throw new ArtifactStoreError('integrity_mismatch', 'Artifact storage metadata is invalid')
      }
      const path = join(root.blobs, match[1], match[2])
      if (!inside(root.root, path)) {
        throw new ArtifactStoreError('unsafe_storage', 'Artifact storage key is invalid')
      }
      const parent = await realpath(dirname(path))
      if (!inside(root.root, parent)) {
        throw new ArtifactStoreError('unsafe_storage', 'Artifact storage boundary is unsafe')
      }
      const content = await relativeFileOperation({
        parent: dirname(path),
        name: match[2],
        action: 'read',
        byteSize: row.byte_size,
        digest,
        ready: this.hooks.beforeRead,
      })
      if (content === null) {
        throw new ArtifactStoreError('integrity_mismatch', 'Artifact blob integrity check failed')
      }
      const artifact = toArtifact(row)
      const digestHeader = Buffer.from(digest, 'hex').toString('base64')
      return {
        artifact,
        content,
        headers: {
          contentType: artifact.mediaType,
          contentLength: String(artifact.byteSize),
          digest: `sha-256=${digestHeader}`,
          etag: `\"${artifact.checksum}\"`,
        },
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError('storage_failure', 'Artifact storage operation failed')
    }
  }

  async inspectOrphans(options: { limit: number; scanLimit: number }): Promise<ArtifactOrphanInventory> {
    if (
      !Number.isSafeInteger(options.limit)
      || options.limit < 0
      || !Number.isSafeInteger(options.scanLimit)
      || options.scanLimit < 1
      || options.limit > options.scanLimit
    ) {
      throw new ArtifactStoreError('invalid_input', 'Artifact inventory bounds are invalid')
    }
    try {
      const root = await this.ensureRoot()
      const storageKeys: string[] = []
      let scannedEntries = 0
      let unsafeEntries = 0
      let truncated = false
      let hitScanLimit = false
      const prefixes = await opendir(root.blobs)
      outer: for await (const prefix of prefixes) {
        if (scannedEntries >= options.scanLimit) {
          hitScanLimit = true
          break
        }
        scannedEntries += 1
        if (!/^[0-9a-f]{2}$/u.test(prefix.name) || !prefix.isDirectory() || prefix.isSymbolicLink()) {
          unsafeEntries += 1
          continue
        }
        const prefixPath = join(root.blobs, prefix.name)
        const canonicalPrefix = await realpath(prefixPath)
        if (!inside(root.root, canonicalPrefix)) {
          unsafeEntries += 1
          continue
        }
        const files = await opendir(prefixPath)
        for await (const file of files) {
          if (scannedEntries >= options.scanLimit) {
            hitScanLimit = true
            break outer
          }
          scannedEntries += 1
          if (
            !/^[0-9a-f]{64}$/u.test(file.name)
            || !file.isFile()
            || file.isSymbolicLink()
            || file.name.slice(0, 2) !== prefix.name
          ) {
            unsafeEntries += 1
            continue
          }
          const key = `sha256/${prefix.name}/${file.name}`
          const checksum = `sha256:${file.name}`
          const known = this.db.prepare(
            'SELECT 1 AS present FROM artifact_blobs WHERE checksum = ?',
          ).get(checksum)
          if (!known) {
            if (storageKeys.length < options.limit) storageKeys.push(key)
            else truncated = true
          }
        }
      }
      return {
        state: 'inventory_only_gc_not_implemented',
        storageKeys,
        scannedEntries,
        unsafeEntries,
        truncated,
        complete: !hitScanLimit,
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError('storage_failure', 'Artifact inventory failed')
    }
  }
}
