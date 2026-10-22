/**
 * Canonical integrity of a local plugin source directory.
 *
 * A plugin source is copied byte-for-byte, so its identity is the sorted list of
 * every regular file plus that file's SHA-256. Directories, modes and timestamps
 * are not part of the identity; a symbolic link is refused rather than followed,
 * because it could otherwise smuggle a host file into an installed plugin.
 *
 * The canonical listing is the UTF-8 JSON array `[["<relative path>", "<hex
 * sha256>"], ...]`, sorted by the UTF-8 bytes of the relative path. The
 * published integrity string is `sha256-<hex sha256 of that JSON>`. Paths use
 * `/` separators on every platform.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export type SourceIntegrityErrorCode =
  | 'source_not_found'
  | 'source_not_directory'
  | 'source_symlink'
  | 'source_outside_root'
  | 'source_not_regular'
  | 'source_hardlink'
  | 'source_unreadable'

export class SourceIntegrityError extends Error {
  readonly code: SourceIntegrityErrorCode
  readonly path: string

  constructor(code: SourceIntegrityErrorCode, path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'SourceIntegrityError'
    this.code = code
    this.path = path
  }
}

export interface IntegrityEntry {
  /** Relative path with `/` separators. */
  readonly path: string
  /** Lower-case hex SHA-256 of the file bytes. */
  readonly sha256: string
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

async function readStat(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new SourceIntegrityError('source_not_found', path, 'plugin source does not exist')
    }
    throw new SourceIntegrityError('source_unreadable', path, `cannot inspect the plugin source (${String(error)})`)
  }
}

/** True when `candidate` is `root` or below it; both paths must be absolute. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function hashFile(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new SourceIntegrityError('source_not_regular', path, 'only regular files can be installed')
    }
    if (stat.nlink > 1) {
      throw new SourceIntegrityError('source_hardlink', path, 'hard-linked files are not allowed in a plugin source')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } catch (error) {
    if (error instanceof SourceIntegrityError) throw error
    if (errorCode(error) === 'ELOOP') {
      throw new SourceIntegrityError('source_symlink', path, 'symbolic links are not allowed in a plugin source')
    }
    throw new SourceIntegrityError('source_unreadable', path, `cannot read the plugin source file (${String(error)})`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Every regular file below `sourceDir`, with its relative path and SHA-256.
 * Symbolic links, non-regular entries and paths resolving outside the source
 * are refused. The caller gets no partial listing on failure.
 */
export async function listSourceFiles(sourceDir: string): Promise<IntegrityEntry[]> {
  const requested = resolve(sourceDir)
  const rootStat = await readStat(requested)
  if (rootStat.isSymbolicLink()) {
    throw new SourceIntegrityError('source_symlink', requested, 'the plugin source itself must not be a symbolic link')
  }
  if (!rootStat.isDirectory()) {
    throw new SourceIntegrityError('source_not_directory', requested, 'the plugin source must be a directory')
  }
  const root = await realpath(requested)
  const entries: IntegrityEntry[] = []

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      throw new SourceIntegrityError('source_unreadable', directory, `cannot list the plugin source (${String(error)})`)
    }
    names.sort(comparePaths)
    for (const name of names) {
      const absolute = join(directory, name)
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`
      const stat = await readStat(absolute)
      if (stat.isSymbolicLink()) {
        throw new SourceIntegrityError('source_symlink', absolute, 'symbolic links are not allowed in a plugin source')
      }
      let real: string
      try {
        real = await realpath(absolute)
      } catch (error) {
        throw new SourceIntegrityError('source_unreadable', absolute, `cannot resolve the plugin source entry (${String(error)})`)
      }
      if (!isInside(root, real)) {
        throw new SourceIntegrityError('source_outside_root', absolute, 'the plugin source entry resolves outside the source directory')
      }
      if (stat.isDirectory()) {
        await walk(absolute, path)
      } else {
        if (stat.isFile() && stat.nlink > 1) {
          throw new SourceIntegrityError('source_hardlink', absolute, 'hard-linked files are not allowed in a plugin source')
        }
        // Opening with O_NONBLOCK and checking the handle refuses FIFOs,
        // sockets and devices without ever blocking on them.
        entries.push({ path, sha256: await hashFile(absolute) })
      }
    }
  }

  await walk(root, '')
  entries.sort((left, right) => comparePaths(left.path, right.path))
  return entries
}

/** The canonical JSON text that the integrity digest covers. */
export function canonicalListing(entries: readonly IntegrityEntry[]): string {
  return JSON.stringify(
    [...entries]
      .sort((left, right) => comparePaths(left.path, right.path))
      .map(entry => [entry.path, entry.sha256]),
  )
}

/** `sha256-<hex>` over `canonicalListing(entries)`. */
export function integrityFromEntries(entries: readonly IntegrityEntry[]): string {
  const digest = createHash('sha256').update(canonicalListing(entries), 'utf8').digest('hex')
  return `sha256-${digest}`
}

/** Compute the integrity string for a directory without writing anything. */
export async function computeDirectoryIntegrity(sourceDir: string): Promise<string> {
  return integrityFromEntries(await listSourceFiles(sourceDir))
}

function readStatSync(path: string): Stats {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new SourceIntegrityError('source_not_found', path, 'plugin source does not exist')
    }
    throw new SourceIntegrityError('source_unreadable', path, `cannot inspect the plugin source (${String(error)})`)
  }
}

function hashFileSync(path: string): string {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new SourceIntegrityError('source_not_regular', path, 'only regular files can be installed')
    }
    if (stat.nlink > 1) {
      throw new SourceIntegrityError('source_hardlink', path, 'hard-linked files are not allowed in a plugin source')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } catch (error) {
    if (error instanceof SourceIntegrityError) throw error
    if (errorCode(error) === 'ELOOP') {
      throw new SourceIntegrityError('source_symlink', path, 'symbolic links are not allowed in a plugin source')
    }
    throw new SourceIntegrityError('source_unreadable', path, `cannot read the plugin source file (${String(error)})`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Synchronous counterpart of `listSourceFiles` for boot-time checks. */
export function listSourceFilesSync(sourceDir: string): IntegrityEntry[] {
  const requested = resolve(sourceDir)
  const rootStat = readStatSync(requested)
  if (rootStat.isSymbolicLink()) {
    throw new SourceIntegrityError('source_symlink', requested, 'the plugin source itself must not be a symbolic link')
  }
  if (!rootStat.isDirectory()) {
    throw new SourceIntegrityError('source_not_directory', requested, 'the plugin source must be a directory')
  }
  const root = realpathSync(requested)
  const entries: IntegrityEntry[] = []

  const walk = (directory: string, relativeDirectory: string): void => {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch (error) {
      throw new SourceIntegrityError('source_unreadable', directory, `cannot list the plugin source (${String(error)})`)
    }
    names.sort(comparePaths)
    for (const name of names) {
      const absolute = join(directory, name)
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`
      const stat = readStatSync(absolute)
      if (stat.isSymbolicLink()) {
        throw new SourceIntegrityError('source_symlink', absolute, 'symbolic links are not allowed in a plugin source')
      }
      let real: string
      try {
        real = realpathSync(absolute)
      } catch (error) {
        throw new SourceIntegrityError('source_unreadable', absolute, `cannot resolve the plugin source entry (${String(error)})`)
      }
      if (!isInside(root, real)) {
        throw new SourceIntegrityError('source_outside_root', absolute, 'the plugin source entry resolves outside the source directory')
      }
      if (stat.isDirectory()) {
        walk(absolute, path)
      } else {
        if (stat.isFile() && stat.nlink > 1) {
          throw new SourceIntegrityError('source_hardlink', absolute, 'hard-linked files are not allowed in a plugin source')
        }
        entries.push({ path, sha256: hashFileSync(absolute) })
      }
    }
  }

  walk(root, '')
  entries.sort((left, right) => comparePaths(left.path, right.path))
  return entries
}

/** Synchronous `computeDirectoryIntegrity` for `bootSet` integrity checks. */
export function computeDirectoryIntegritySync(sourceDir: string): string {
  return integrityFromEntries(listSourceFilesSync(sourceDir))
}
