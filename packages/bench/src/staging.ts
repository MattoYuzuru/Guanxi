import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import type { Task } from './protocol.ts'

export interface TaskManifest {
  version: 1
  revision: string
  files: { path: string; sha256: string; bytes: number }[]
}

type ManifestFile = TaskManifest['files'][number]
type OpenedDirectory = { handle: FileHandle; stat: BigIntStats }

const READ_CHUNK = 1024 * 1024
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW
const NAME_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function refuse(code: string): never {
  throw new Error(code)
}

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function lstatChecked(path: string, fallback: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true })
  } catch {
    refuse(fallback)
  }
}

function decodeName(raw: Buffer): string {
  let name: string
  try {
    name = NAME_DECODER.decode(raw)
  } catch {
    refuse('invalid_path')
  }
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) refuse('invalid_path')
  return name
}

function comparePath(left: ManifestFile, right: ManifestFile): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
}

/** Sorted relative path UTF-8 + NUL + the raw 32-byte file digest, streamed into SHA-256. */
function revisionOf(files: ManifestFile[]): string {
  const revision = createHash('sha256')
  for (const file of files) {
    revision.update(file.path, 'utf8')
    revision.update(Buffer.from([0]))
    revision.update(Buffer.from(file.sha256, 'hex'))
  }
  return revision.digest('hex')
}

function sameFiles(left: ManifestFile[], right: ManifestFile[]): boolean {
  if (left.length !== right.length) return false
  return left.every((file, index) => {
    const other = right[index]!
    return file.path === other.path && file.sha256 === other.sha256 && file.bytes === other.bytes
  })
}

async function openedDirectory(path: string, before: BigIntStats): Promise<OpenedDirectory> {
  if (before.isSymbolicLink()) refuse('symlink_refused')
  if (!before.isDirectory()) refuse('not_a_directory')
  let handle: FileHandle
  try {
    handle = await open(path, DIRECTORY_FLAGS)
  } catch {
    refuse('source_changed')
  }
  let current: BigIntStats
  try {
    current = await handle.stat({ bigint: true })
  } catch {
    await handle.close().catch(() => {})
    refuse('source_changed')
  }
  if (!current.isDirectory() || !sameIdentity(before, current) || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs) {
    await handle.close().catch(() => {})
    refuse('source_changed')
  }
  return { handle, stat: current }
}

async function verifyDirectory(path: string, opened: OpenedDirectory): Promise<void> {
  const after = await lstatChecked(path, 'source_changed')
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(after, opened.stat) || after.mtimeNs !== opened.stat.mtimeNs || after.ctimeNs !== opened.stat.ctimeNs) refuse('source_changed')
}

async function hashFile(path: string, relativePath: string, before: BigIntStats): Promise<ManifestFile> {
  if (!before.isFile()) refuse('nonregular_refused')
  if (before.size > MAX_SAFE_INTEGER) refuse('invalid_length')
  let handle: FileHandle
  try {
    handle = await open(path, FILE_FLAGS)
  } catch {
    refuse('source_changed')
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) refuse('source_changed')
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_CHUNK)
    let bytes = 0
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null).then(result => result.bytesRead).catch(() => refuse('source_changed'))
      if (read === 0) break
      digest.update(buffer.subarray(0, read))
      bytes += read
      if (!Number.isSafeInteger(bytes)) refuse('invalid_length')
    }
    const after = await handle.stat({ bigint: true }).catch(() => refuse('source_changed'))
    if (!sameIdentity(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || BigInt(bytes) !== opened.size) refuse('source_changed')
    const atPath = await lstatChecked(path, 'source_changed')
    if (!atPath.isFile() || !sameIdentity(opened, atPath)) refuse('source_changed')
    return { path: relativePath, sha256: digest.digest('hex'), bytes }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function walk(directory: string, prefix: string, opened: OpenedDirectory, files: ManifestFile[], seen: Set<string>): Promise<void> {
  let names: Buffer[]
  try {
    names = await readdir(directory, { encoding: 'buffer' })
  } catch {
    refuse('source_changed')
  }
  names.sort(Buffer.compare)
  for (const raw of names) {
    const name = decodeName(raw)
    const relativePath = prefix ? `${prefix}/${name}` : name
    if (seen.has(relativePath)) refuse('duplicate_path')
    seen.add(relativePath)
    const absolute = join(directory, name)
    const before = await lstatChecked(absolute, 'source_changed')
    if (before.isSymbolicLink()) refuse('symlink_refused')
    if (before.isDirectory()) {
      const child = await openedDirectory(absolute, before)
      try {
        await walk(absolute, relativePath, child, files, seen)
      } finally {
        await child.handle.close().catch(() => {})
      }
    } else if (before.isFile()) {
      files.push(await hashFile(absolute, relativePath, before))
    } else {
      refuse('nonregular_refused')
    }
  }
  await verifyDirectory(directory, opened)
}

function sourceRootPath(value: string): string {
  const root = parse(value).root
  let end = value.length
  while (end > root.length && value[end - 1] === sep) end--
  const stripped = value.slice(0, end)
  const final = basename(stripped)
  if (final === '.' || final === '..') refuse('invalid_path')
  return stripped
}

/** Read only ordinary, non-symlinked entries whose opened identity still matches the path. */
export async function inspectTaskDirectory(directory: string): Promise<TaskManifest> {
  const rootPath = sourceRootPath(directory)
  const before = await lstatChecked(rootPath, 'source_unavailable')
  const root = await openedDirectory(rootPath, before)
  const files: ManifestFile[] = []
  const seen = new Set<string>()
  try {
    await walk(rootPath, '', root, files, seen)
  } finally {
    await root.handle.close().catch(() => {})
  }
  files.sort(comparePath)
  return { version: 1, revision: revisionOf(files), files }
}

function assertRevision(revision: string): void {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) refuse('invalid_revision')
}

export async function verifyTaskDirectory(task: Pick<Task, 'path' | 'revision'>): Promise<TaskManifest> {
  assertRevision(task.revision)
  const manifest = await inspectTaskDirectory(task.path)
  if (manifest.revision !== task.revision) refuse('revision_mismatch')
  return manifest
}

async function canonicalSource(source: string): Promise<string> {
  try {
    return await realpath(source)
  } catch {
    refuse('source_changed')
  }
}

async function canonicalDestination(destinationRoot: string): Promise<string> {
  let probe = isAbsolute(destinationRoot) ? destinationRoot : `${process.cwd()}${sep}${destinationRoot}`
  const suffix: string[] = []
  for (;;) {
    try {
      const found = await realpath(probe)
      return suffix.length ? join(found, ...suffix.reverse()) : found
    } catch (error) {
      if (!errno(error, 'ENOENT')) refuse('destination_unavailable')
      const parent = dirname(probe)
      if (parent === probe) refuse('destination_unavailable')
      suffix.push(basename(probe))
      probe = parent
    }
  }
}

async function assertDestinationOutsideSource(source: string, destinationRoot: string): Promise<void> {
  const sourcePath = await canonicalSource(source)
  const destinationPath = await canonicalDestination(destinationRoot)
  const inside = relative(sourcePath, destinationPath)
  if (inside === '' || (!isAbsolute(inside) && inside.split(sep)[0] !== '..')) refuse('destination_inside_source')
  // join() below is lexical. A parent component after a symlink would make the published
  // location differ from the path just verified, so require an unambiguous destination root.
  const separatorPattern = process.platform === 'win32' ? /[\\/]/ : sep
  if (destinationRoot.split(separatorPattern).includes('..')) refuse('destination_path_ambiguous')
}

async function exactExisting(destination: string, expected: TaskManifest): Promise<TaskManifest | null> {
  try {
    await lstat(destination, { bigint: true })
  } catch (error) {
    if (errno(error, 'ENOENT')) return null
    refuse('destination_conflict')
  }
  let manifest: TaskManifest
  try {
    manifest = await inspectTaskDirectory(destination)
  } catch {
    refuse('destination_conflict')
  }
  if (manifest.revision !== expected.revision || !sameFiles(manifest.files, expected.files)) refuse('destination_conflict')
  return manifest
}

async function applyModes(target: string): Promise<void> {
  let info: Stats
  try {
    info = await lstat(target)
  } catch {
    refuse('publish_failed')
  }
  if (info.isSymbolicLink()) refuse('publish_failed')
  if (info.isDirectory()) {
    try {
      await chmod(target, 0o700)
    } catch {
      refuse('publish_failed')
    }
    let entries: string[]
    try {
      entries = await readdir(target)
    } catch {
      refuse('publish_failed')
    }
    for (const entry of entries) await applyModes(join(target, entry))
    return
  }
  if (!info.isFile()) refuse('publish_failed')
  try {
    await chmod(target, 0o600)
  } catch {
    refuse('publish_failed')
  }
}

async function copyFile(source: string, destination: string, expected: ManifestFile): Promise<void> {
  const before = await lstatChecked(source, 'source_changed')
  if (before.isSymbolicLink()) refuse('symlink_refused')
  if (!before.isFile()) refuse('nonregular_refused')
  if (before.size > MAX_SAFE_INTEGER || BigInt(expected.bytes) !== before.size) refuse('source_changed')
  let sourceHandle: FileHandle
  try {
    sourceHandle = await open(source, FILE_FLAGS)
  } catch {
    refuse('source_changed')
  }
  let destinationHandle: FileHandle | undefined
  try {
    const opened = await sourceHandle.stat({ bigint: true })
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) refuse('source_changed')
    try {
      destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch {
      refuse('publish_failed')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_CHUNK)
    let bytes = 0
    for (;;) {
      const read = await sourceHandle.read(buffer, 0, buffer.length, null).then(result => result.bytesRead).catch(() => refuse('source_changed'))
      if (read === 0) break
      digest.update(buffer.subarray(0, read))
      bytes += read
      if (!Number.isSafeInteger(bytes)) refuse('invalid_length')
      let written = 0
      while (written < read) {
        const count = await destinationHandle.write(buffer, written, read - written, null).then(result => result.bytesWritten).catch(() => refuse('publish_failed'))
        if (count <= 0) refuse('publish_failed')
        written += count
      }
    }
    const after = await sourceHandle.stat({ bigint: true }).catch(() => refuse('source_changed'))
    if (!sameIdentity(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || BigInt(bytes) !== opened.size) refuse('source_changed')
    const atPath = await lstatChecked(source, 'source_changed')
    if (!atPath.isFile() || !sameIdentity(opened, atPath)) refuse('source_changed')
    if (digest.digest('hex') !== expected.sha256 || bytes !== expected.bytes) refuse('source_changed')
  } finally {
    if (destinationHandle) await destinationHandle.close().catch(() => {})
    await sourceHandle.close().catch(() => {})
  }
}

async function copyTree(source: string, destination: string, manifest: TaskManifest): Promise<void> {
  for (const file of manifest.files) {
    const components = file.path.split('/')
    if (components.some(component => !component || component === '.' || component === '..' || component.includes('\0'))) refuse('invalid_path')
    const target = join(destination, ...components)
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    } catch {
      refuse('publish_failed')
    }
    await copyFile(join(source, ...components), target, file)
  }
  await applyModes(destination)
}

// The per-revision lock makes identical concurrent publishers deterministic and prevents
// one from replacing another's already-published content.
async function publish(temporary: string, destination: string, expected: TaskManifest): Promise<{ manifest: TaskManifest; created: boolean }> {
  const lock = join(dirname(destination), `.publish-${expected.revision}.lock`)
  let lockHandle: FileHandle
  try {
    lockHandle = await open(lock, 'wx', 0o600)
  } catch (error) {
    if (errno(error, 'EEXIST')) refuse('publish_busy')
    refuse('publish_failed')
  }
  try {
    const existing = await exactExisting(destination, expected)
    if (existing) return { manifest: existing, created: false }
    try {
      await rename(temporary, destination)
    } catch {
      refuse('publish_failed')
    }
    return { manifest: expected, created: true }
  } finally {
    await lockHandle.close().catch(() => {})
    await unlink(lock).catch(() => {})
  }
}

// Copy into a same-parent private directory, re-inspect that copy, and only then rename it.
export async function stageTaskDirectory(source: string, destinationRoot: string, expectedRevision: string): Promise<{ path: string; manifest: TaskManifest }> {
  assertRevision(expectedRevision)
  const sourceManifest = await inspectTaskDirectory(source)
  if (sourceManifest.revision !== expectedRevision) refuse('expected_revision_mismatch')
  await assertDestinationOutsideSource(source, destinationRoot)

  let createdRoot: string | undefined
  try {
    createdRoot = await mkdir(destinationRoot, { recursive: true, mode: 0o700 })
  } catch {
    refuse('publish_failed')
  }
  if (createdRoot !== undefined) {
    try {
      await chmod(destinationRoot, 0o700)
    } catch {
      refuse('publish_failed')
    }
  }

  const destination = join(destinationRoot, expectedRevision)
  const existing = await exactExisting(destination, sourceManifest)
  if (existing) return { path: destination, manifest: existing }

  let temporary: string
  try {
    temporary = await mkdtemp(join(destinationRoot, '.staging-'))
  } catch {
    refuse('publish_failed')
  }
  let published = false
  try {
    try {
      await chmod(temporary, 0o700)
    } catch {
      refuse('publish_failed')
    }
    await copyTree(source, temporary, sourceManifest)
    const copied = await inspectTaskDirectory(temporary)
    if (copied.revision !== expectedRevision || !sameFiles(copied.files, sourceManifest.files)) refuse('expected_revision_mismatch')
    const result = await publish(temporary, destination, sourceManifest)
    published = result.created
    return { path: destination, manifest: result.manifest }
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}
