import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceCommand } from './locate.ts'

export interface ExitInfo {
  code: number | null
  signal: string | null
}

export interface SpawnedService {
  pid: number
  /** Resolves when the child exits while the shell is still alive; never rejects. */
  exited: Promise<ExitInfo>
  kill(signal?: NodeJS.Signals): void
}

/** Thrown when the executable cannot start at all (missing binary, no permission). */
export class SpawnFailedError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'SpawnFailedError'
    this.code = code
  }
}

export interface ServicePaths {
  directory: string
  manifest: string
  log: string
}

export function servicePaths(dataDir: string): ServicePaths {
  const directory = join(dataDir, 'desktop')
  return { directory, manifest: join(directory, 'service.json'), log: join(directory, 'service.log') }
}

const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Private directory for the manifest and the log; a service log is the user's, not a world-readable file. */
export function prepareServiceDirectory(paths: ServicePaths): void {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
  try {
    if (statSync(paths.log).size > MAX_LOG_BYTES) renameSync(paths.log, `${paths.log}.1`)
  } catch {
    // no log yet
  }
}

export interface ServiceManifest {
  pid: number
  port: number
  startedAt: string
  entry: string
}

export function writeManifest(paths: ServicePaths, manifest: ServiceManifest): void {
  writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
}

export function readManifest(paths: ServicePaths): ServiceManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.manifest, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const { pid, port, startedAt, entry } = record
    if (!Number.isInteger(pid) || (pid as number) <= 1 || !Number.isInteger(port) || typeof startedAt !== 'string' || typeof entry !== 'string') return null
    return { pid: pid as number, port: port as number, startedAt, entry }
  } catch {
    return null
  }
}

export function removeManifest(paths: ServicePaths): void {
  rmSync(paths.manifest, { force: true })
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Starts the service so that it outlives this process: its own process group (`detached`), output in a
 * private file (a pipe would break when the shell exits), and no reference held by the shell's event loop.
 * Nothing here ties the child to a window or to the app; closing the window, quitting the app or
 * crashing the shell never signals it.
 */
export function spawnDetachedService(command: ServiceCommand, paths: ServicePaths): Promise<SpawnedService> {
  prepareServiceDirectory(paths)
  const fd = openSync(paths.log, 'a', 0o600)
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command.command, command.args, {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: command.env,
        windowsHide: true,
      })
    } catch (error) {
      closeSync(fd)
      reject(new SpawnFailedError((error as Error).message, (error as NodeJS.ErrnoException).code))
      return
    }
    child.once('error', (error) => {
      closeSync(fd)
      reject(new SpawnFailedError(error.message, (error as NodeJS.ErrnoException).code))
    })
    child.once('spawn', () => {
      closeSync(fd)
      const pid = child.pid
      if (pid === undefined) {
        reject(new SpawnFailedError('child has no pid'))
        return
      }
      const exited = new Promise<ExitInfo>((done) => {
        child.once('exit', (code, signal) => done({ code, signal }))
      })
      child.unref()
      resolve({
        pid,
        exited,
        kill: (signal = 'SIGTERM') => {
          try {
            process.kill(pid, signal)
          } catch {
            // already gone
          }
        },
      })
    })
  })
}
