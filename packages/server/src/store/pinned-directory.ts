/**
 * Repository-owned pinned-directory primitive.
 *
 * The parent validates a directory identity, starts a short-lived helper with
 * that directory as its `cwd`, and compares the helper-reported `cwd`/`dev`/
 * `ino` before any content operation. Every helper `open`, `link`, `fsync` and
 * `unlink` is relative to `.`, so a later ancestor replacement cannot retarget
 * the operation: the process `cwd` is a reference, not a path lookup.
 *
 * The payload action transfers scrubbed bytes only over the private stdio
 * pipe. Content never appears in argv, the environment, logs, stderr or error
 * details; the helper creates its random temporary basename itself, writes,
 * hashes, `fsync`s, publishes by relative link, verifies the published digest
 * and unlinks only that temporary file. A published digest is never removed by
 * a failing writer.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { createInterface } from 'node:readline'

export type PinnedDirectoryErrorCode =
  | 'invalid_input'
  | 'unsafe_storage'
  | 'integrity_mismatch'
  | 'storage_failure'
  | 'aborted'

export class PinnedDirectoryError extends Error {
  readonly code: PinnedDirectoryErrorCode

  constructor(code: PinnedDirectoryErrorCode, message: string) {
    super(message)
    this.name = 'PinnedDirectoryError'
    this.code = code
  }
}

export interface RelativeDirectoryIdentity {
  canonicalPath: string
  dev: string
  ino: string
}

export type RelativeContent = Uint8Array | AsyncIterable<Uint8Array>

const DIGEST = /^[0-9a-f]{64}$/u

export const RELATIVE_DIRECTORY_HELPER = String.raw`
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, stat, unlink } from 'node:fs/promises'

const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const directory = await stat('.')
send({ state: 'ready', cwd: process.cwd(), dev: String(directory.dev), ino: String(directory.ino) })

let file = null
let temp = null
let hash = createHash('sha256')
let total = 0
let header = null
let headerBuffer = Buffer.alloc(0)

const closeQuietly = async () => { try { await file?.close() } catch {} file = null }

async function begin(command) {
  if (typeof command?.name !== 'string' || !/^[0-9a-f]{64}$/u.test(command.name)) throw new Error('invalid_name')
  if (!Number.isSafeInteger(command.byteSize) || command.byteSize < 0) throw new Error('invalid_size')
  if (typeof command.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(command.digest)) throw new Error('invalid_digest')
  if (command.action === 'write') {
    temp = '.partial-' + randomUUID()
    file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  } else if (command.action === 'publish') {
    if (typeof command.source !== 'string' || command.source.length === 0) throw new Error('invalid_source')
  } else if (command.action !== 'read') {
    throw new Error('invalid_action')
  }
}

async function writeChunk(chunk) {
  if (header.action !== 'write') throw new Error('unexpected_payload')
  if (total + chunk.byteLength > header.byteSize) throw new Error('oversized_payload')
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('write_failed')
    offset += bytesWritten
  }
  total += chunk.byteLength
  hash.update(chunk)
}

async function verify(name) {
  const published = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await published.stat()
    if (!opened.isFile() || opened.size !== header.byteSize) throw new Error('integrity')
    const check = createHash('sha256')
    let read = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await published.read(buffer, 0, buffer.byteLength)
      if (bytesRead === 0) break
      read += bytesRead
      if (!Number.isSafeInteger(read) || read > header.byteSize) throw new Error('integrity')
      check.update(buffer.subarray(0, bytesRead))
    }
    if (read !== header.byteSize || check.digest('hex') !== header.digest) throw new Error('integrity')
  } finally {
    await published.close()
  }
}

async function finish() {
  if (header === null) throw new Error('missing_command')
  if (header.action === 'write') {
    if (total !== header.byteSize) throw new Error('short_payload')
    await file.sync()
    await closeQuietly()
    if (hash.digest('hex') !== header.digest) throw new Error('integrity')
    try {
      await link(temp, header.name)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    await verify(header.name)
    const parent = await open('.', constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
    await unlink(temp)
    temp = null
    send({ state: 'verified', content: null })
    return
  }
  if (header.action === 'publish') {
    try {
      await link(header.source, header.name)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    await verify(header.name)
    const parent = await open('.', constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
    send({ state: 'verified', content: null })
    return
  }
  const published = await open(header.name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await published.stat()
    if (!opened.isFile() || opened.size !== header.byteSize) throw new Error('integrity')
    const check = createHash('sha256')
    const buffers = []
    let read = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await published.read(buffer, 0, buffer.byteLength)
      if (bytesRead === 0) break
      read += bytesRead
      if (!Number.isSafeInteger(read) || read > header.byteSize) throw new Error('integrity')
      const value = Buffer.from(buffer.subarray(0, bytesRead))
      check.update(value)
      buffers.push(value)
    }
    if (read !== header.byteSize || check.digest('hex') !== header.digest) throw new Error('integrity')
    send({ state: 'verified', content: Buffer.concat(buffers, read).toString('base64') })
  } finally {
    await published.close()
  }
}

try {
  for await (const chunk of process.stdin) {
    if (header === null) {
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      const newline = headerBuffer.indexOf(10)
      if (newline < 0) continue
      header = JSON.parse(headerBuffer.subarray(0, newline).toString('utf8'))
      const rest = headerBuffer.subarray(newline + 1)
      headerBuffer = Buffer.alloc(0)
      await begin(header)
      if (rest.byteLength > 0) await writeChunk(rest)
    } else {
      await writeChunk(chunk)
    }
  }
  await finish()
} catch (error) {
  await closeQuietly()
  if (temp !== null) await unlink(temp).catch(() => undefined)
  send({
    state: 'failed',
    code: ['ELOOP', 'ENOTDIR', 'EISDIR'].includes(error?.code) ? 'unsafe' : 'invalid',
  })
  process.exitCode = 1
}
`

export async function directoryIdentity(path: string): Promise<RelativeDirectoryIdentity> {
  const state = await lstat(path)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new PinnedDirectoryError('unsafe_storage', 'Storage boundary is unsafe')
  }
  return {
    canonicalPath: await realpath(path),
    dev: String(state.dev),
    ino: String(state.ino),
  }
}

function inside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}

async function writeStdin(
  child: ReturnType<typeof spawn>,
  chunk: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new PinnedDirectoryError('aborted', 'Storage operation was cancelled')
  const stdin = child.stdin
  if (!stdin || stdin.destroyed) throw new PinnedDirectoryError('storage_failure', 'Storage helper failed')
  if (!stdin.write(chunk)) {
    await once(stdin, 'drain')
  }
}

export interface RelativeDirectoryOperationInput {
  parent: string
  name: string
  action: 'publish' | 'read' | 'write'
  source?: string
  content?: RelativeContent
  byteSize: number
  digest: string
  /** Called after the trusted identity is captured and before the helper starts. */
  beforeSpawn?(): void | Promise<void>
  /** Called after the helper handshake is validated and before any command byte. */
  ready?(): void | Promise<void>
  signal?: AbortSignal
  timeoutMs: number
}

/**
 * One relative content operation in a pinned directory. Returns the verified
 * bytes for `read`, `null` otherwise. A post-operation identity mismatch fails
 * closed after the bytes reached the original pinned directory.
 */
export async function relativeDirectoryOperation(
  input: RelativeDirectoryOperationInput,
): Promise<Uint8Array | null> {
  if (!DIGEST.test(input.name) || !DIGEST.test(input.digest)) {
    throw new PinnedDirectoryError('invalid_input', 'Storage name is invalid')
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
    throw new PinnedDirectoryError('invalid_input', 'Storage size is invalid')
  }
  if (input.action === 'write' && input.content === undefined) {
    throw new PinnedDirectoryError('invalid_input', 'Storage write content is missing')
  }
  let expected: RelativeDirectoryIdentity
  try {
    expected = await directoryIdentity(input.parent)
  } catch {
    throw new PinnedDirectoryError('unsafe_storage', 'Storage identity is unavailable')
  }
  await input.beforeSpawn?.()
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', RELATIVE_DIRECTORY_HELPER],
    { cwd: input.parent, stdio: ['pipe', 'pipe', 'ignore'] },
  )
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', () => resolveExit({ code: null, signal: null }))
  })
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  let timeout: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new PinnedDirectoryError('aborted', 'Storage operation was cancelled'))
    input.signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(
      () => reject(new PinnedDirectoryError('storage_failure', 'Storage helper timed out')),
      input.timeoutMs,
    )
  })
  const operation = async (): Promise<Uint8Array | null> => {
    if (input.signal?.aborted) {
      throw new PinnedDirectoryError('aborted', 'Storage operation was cancelled')
    }
    const ready = await lines.next()
    if (ready.done) throw new PinnedDirectoryError('unsafe_storage', 'Storage helper failed')
    const identity = JSON.parse(ready.value) as Record<string, unknown>
    if (
      identity['state'] !== 'ready'
      || identity['cwd'] !== expected.canonicalPath
      || identity['dev'] !== expected.dev
      || identity['ino'] !== expected.ino
    ) {
      throw new PinnedDirectoryError('unsafe_storage', 'Storage identity changed')
    }
    await input.ready?.()
    const command = input.action === 'publish'
      ? { action: 'publish', source: input.source, name: input.name, byteSize: input.byteSize, digest: input.digest }
      : { action: input.action, name: input.name, byteSize: input.byteSize, digest: input.digest }
    await writeStdin(child, Buffer.from(`${JSON.stringify(command)}\n`, 'utf8'), input.signal)
    if (input.action === 'write') {
      const content = input.content!
      if (content instanceof Uint8Array) {
        for (let offset = 0; offset < content.byteLength; offset += 64 * 1024) {
          await writeStdin(child, content.subarray(offset, Math.min(offset + 64 * 1024, content.byteLength)), input.signal)
        }
      } else {
        for await (const chunk of content) {
          if (!(chunk instanceof Uint8Array)) {
            throw new PinnedDirectoryError('invalid_input', 'Storage content must contain bytes')
          }
          await writeStdin(child, chunk, input.signal)
        }
      }
    }
    child.stdin!.end()
    const response = await lines.next()
    const outcome = response.done ? null : JSON.parse(response.value) as Record<string, unknown>
    const exit = await exited
    if (outcome?.['state'] !== 'verified' || exit.code !== 0 || exit.signal !== null) {
      throw new PinnedDirectoryError(
        outcome?.['code'] === 'unsafe'
          ? 'unsafe_storage'
          : outcome?.['code'] === 'invalid'
            ? 'integrity_mismatch'
            : 'storage_failure',
        'Storage blob integrity check failed',
      )
    }
    let current: RelativeDirectoryIdentity
    try {
      current = await directoryIdentity(input.parent)
    } catch {
      throw new PinnedDirectoryError('unsafe_storage', 'Storage identity changed')
    }
    if (
      current.canonicalPath !== expected.canonicalPath
      || current.dev !== expected.dev
      || current.ino !== expected.ino
    ) {
      throw new PinnedDirectoryError('unsafe_storage', 'Storage identity changed')
    }
    if (input.action !== 'read') return null
    if (typeof outcome['content'] !== 'string') {
      throw new PinnedDirectoryError('integrity_mismatch', 'Storage blob integrity check failed')
    }
    const content = Buffer.from(outcome['content'], 'base64')
    if (content.byteLength !== input.byteSize) {
      throw new PinnedDirectoryError('integrity_mismatch', 'Storage blob integrity check failed')
    }
    return content
  }
  try {
    return await Promise.race([operation(), interrupted])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    if (onAbort !== null) input.signal?.removeEventListener('abort', onAbort)
    child.stdin?.destroy()
    child.stdout?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
}

/** True when `candidate` is the same path or below `parent` (both canonical). */
export function insideDirectory(parent: string, candidate: string): boolean {
  return inside(parent, candidate)
}
