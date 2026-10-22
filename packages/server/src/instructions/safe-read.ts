import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

export type ReadFailure = 'not_regular_file' | 'unreadable'

/** A refusal to read that the callers surface as a warning or an error code. */
export class ReadFailureError extends Error {
  readonly code: ReadFailure

  constructor(code: ReadFailure) {
    super(code)
    this.code = code
    this.name = 'ReadFailureError'
  }
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)

/** Rejects negative, non-finite or non-numeric budgets before any comparison. */
export function assertBudget(value: unknown, code: string): number {
  if (typeof value !== 'number' || !(value >= 0) || !Number.isFinite(value)) throw new TypeError(code)
  return value
}

/**
 * Opens a regular file without blocking on FIFOs or following a swapped-in
 * symlink. The handle is fstat'ed before any read so devices and FIFOs are
 * refused with `not_regular_file`.
 */
export async function openRegularFile(path: string): Promise<FileHandle> {
  let handle: FileHandle
  try {
    handle = await open(path, READ_FLAGS)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw new ReadFailureError('unreadable')
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new ReadFailureError('not_regular_file')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Maps a read/open error to a stable instruction warning code. */
export function readFailureCode(error: unknown): ReadFailure | null {
  if (error instanceof ReadFailureError) return error.code
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' ? 'unreadable' : null
}

/**
 * Reads from `offset` to EOF or `cap + 1` bytes. `overflow` means the file is
 * larger than `cap`; the extra byte makes growth detectable instead of silently
 * truncating the result.
 */
export async function readToEnd(
  handle: FileHandle,
  offset: number,
  cap: number,
): Promise<{ bytes: Buffer; overflow: boolean }> {
  const limit = cap + 1
  const chunks: Buffer[] = []
  let total = 0
  while (total < limit) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset + total)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
  }
  const bytes = Buffer.concat(chunks)
  return { bytes, overflow: bytes.length > cap }
}
