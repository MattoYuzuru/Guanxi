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

// Absolute paths (a PATH of the user's making must not decide what answers "who owns this port"), a hard kill
// when a tool hangs, and a short timeout: both tools are local and instant when they work.
export const LSOF = '/usr/sbin/lsof'
export const PS = '/bin/ps'

const runFile: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ stdout, code: error === null ? 0 : ((error as NodeJS.ErrnoException).code ?? null) })
    })
  })

/**
 * Listening sockets on a loopback port that this user can see. `null`: the tool is missing, failed or timed out.
 * `-b` keeps lsof from blocking in kernel calls that could stall on a hung mount.
 */
export async function lookupListeners(port: number, run: Run = runFile): Promise<Listener[] | null> {
  const result = await run(LSOF, ['-b', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu'])
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

/** What `ps` says about a pid. `unknown` (ps failed or timed out) is not `gone`: absence of evidence is not evidence. */
export type ProcessInfo =
  | { state: 'found'; command: string; startedAt: Date | null }
  | { state: 'gone' }
  | { state: 'unknown' }

const LSTART = /^(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}) (.*)$/s

export async function processInfo(pid: number, run: Run = runFile): Promise<ProcessInfo> {
  const result = await run(PS, ['-p', String(pid), '-o', 'lstart=,command='])
  const text = result.stdout.trim()
  if (result.code === 1 && text === '') return { state: 'gone' }
  if (result.code !== 0 || text === '') return { state: 'unknown' }
  const match = LSTART.exec(text)
  if (match === null) return { state: 'found', command: text, startedAt: null }
  const started = new Date(match[1]!)
  return { state: 'found', command: match[2]!.trim(), startedAt: Number.isNaN(started.getTime()) ? null : started }
}

export type IdentityVerdict = 'match' | 'mismatch' | 'unknown'

const START_TOLERANCE_MS = 120_000
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Is this pid still the service the manifest describes? The command line must carry the manifest's entry and
 * its `--port <port>` as whole arguments (a substring of a longer path does not count), and when `ps` reports a
 * start time it must be within two minutes of the manifest's `startedAt`.
 */
export function matchesManifest(info: ProcessInfo, manifest: { entry: string; port: number; startedAt: string }): IdentityVerdict {
  if (info.state === 'unknown') return 'unknown'
  if (info.state === 'gone') return 'mismatch'
  const argument = (value: string) => new RegExp(`(^|\\s)${escapeRegExp(value)}(\\s|$)`)
  if (!argument(manifest.entry).test(info.command) || !argument(`--port ${manifest.port}`).test(info.command)) return 'mismatch'
  const recorded = Date.parse(manifest.startedAt)
  if (info.startedAt !== null && !Number.isNaN(recorded) && Math.abs(info.startedAt.getTime() - recorded) > START_TOLERANCE_MS) return 'mismatch'
  return 'match'
}

export interface ManifestCheckDeps {
  paths: ServicePaths
  alive(pid: number): boolean
  processInfo(pid: number): Promise<ProcessInfo>
}

/**
 * The pid of the service the shell started on `port`, only while it is still that service (see
 * `matchesManifest`). A manifest that fails the test is stale (the service ended and the OS may have reused the
 * pid) and is removed. When `ps` itself fails or times out the answer is `'unverified'` and the manifest is KEPT:
 * a transient tool failure must not erase the only record of a running service.
 */
export async function liveManifestPid(port: number, deps: ManifestCheckDeps): Promise<number | null | 'unverified'> {
  const manifest = readManifest(deps.paths)
  if (manifest === null) return null
  // A manifest for another port belongs to a service that may still run there: leave it alone.
  if (manifest.port !== port) return null
  if (deps.alive(manifest.pid)) {
    const verdict = matchesManifest(await deps.processInfo(manifest.pid), manifest)
    if (verdict === 'match') return manifest.pid
    if (verdict === 'unknown') return 'unverified'
  }
  removeManifest(deps.paths)
  return null
}
