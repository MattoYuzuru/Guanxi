import { execFile } from 'node:child_process'
import type { ServicePaths } from './launcher.ts'
import { readManifest, removeManifest } from './launcher.ts'

/**
 * Who is behind the port. A health document proves only that something imitates Guanxi; the listener's
 * owner is a fact the operating system gives us. A listener of another user is never attached to, and a
 * service the shell started must be the very process the manifest names. (A same-user process that
 * imitates the node cannot be told apart until local authentication exists, U3.)
 */
export interface Listener {
  pid: number
  uid: number
}

export type OwnerVerdict =
  | { ok: true }
  /** Another user (or an unseen process) holds the port. */
  | { ok: false; code: 'port_owned_by_other_user' }
  /** The listener is not the process we expect (a recycled port, a squatter beside a live service). */
  | { ok: false; code: 'port_busy' }
  /** The lookup itself failed, so ownership could not be confirmed. */
  | { ok: false; code: 'port_unverified' }

/** `lsof -Fpu` prints `p<pid>` then `u<uid>` per process, then `f<fd>` lines. */
export function parseLsof(output: string): Listener[] {
  const listeners: Listener[] = []
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('u') && pid !== null && Number.isInteger(pid)) {
      const uid = Number(line.slice(1))
      if (Number.isInteger(uid)) listeners.push({ pid, uid })
      pid = null
    }
  }
  return listeners
}

type Run = (file: string, args: string[]) => Promise<{ stdout: string; code: number | string | null }>

const runFile: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ stdout, code: error === null ? 0 : ((error as NodeJS.ErrnoException).code ?? null) })
    })
  })

/** Listening sockets on a loopback port that this user can see. `null`: the tool is missing or failed. */
export async function lookupListeners(port: number, run: Run = runFile): Promise<Listener[] | null> {
  const result = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu'])
  // lsof exits 1 when nothing matches; that is an answer, not a failure.
  if (result.code === 0 || result.code === 1) return parseLsof(result.stdout)
  return null
}

export function judgeOwner(listeners: Listener[] | null, selfUid: number | null, expectedPid: number | null): OwnerVerdict {
  if (listeners === null) return { ok: false, code: 'port_unverified' }
  // `lsof` shows a non-root user only that user's own sockets: an answering port with no visible listener
  // belongs to somebody else.
  if (selfUid !== null && (listeners.length === 0 || listeners.some((listener) => listener.uid !== selfUid))) {
    return { ok: false, code: 'port_owned_by_other_user' }
  }
  if (expectedPid !== null && (listeners.length === 0 || listeners.some((listener) => listener.pid !== expectedPid))) {
    return { ok: false, code: 'port_busy' }
  }
  return { ok: true }
}

export async function commandOf(pid: number, run: Run = runFile): Promise<string | null> {
  const result = await run('ps', ['-p', String(pid), '-o', 'command='])
  const text = result.stdout.trim()
  return result.code === 0 && text.length > 0 ? text : null
}

export interface ManifestCheckDeps {
  paths: ServicePaths
  alive(pid: number): boolean
  commandOf(pid: number): Promise<string | null>
}

/**
 * The pid of the service the shell started on `port`, only while it is still that service: the pid is
 * alive and its command line names the manifest's entry. A manifest that fails the test is stale (the
 * service ended and the OS may have reused the pid): it is removed and nothing is expected.
 */
export async function liveManifestPid(port: number, deps: ManifestCheckDeps): Promise<number | null> {
  const manifest = readManifest(deps.paths)
  if (manifest === null) return null
  // A manifest for another port belongs to a service that may still run there: leave it alone.
  if (manifest.port !== port) return null
  if (deps.alive(manifest.pid)) {
    const command = await deps.commandOf(manifest.pid)
    if (command !== null && command.includes(manifest.entry)) return manifest.pid
  }
  removeManifest(deps.paths)
  return null
}
