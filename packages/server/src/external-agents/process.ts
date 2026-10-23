import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import type { Stream } from '@agentclientprotocol/sdk'
import type { EgressScrubber } from '../egress/types.ts'
import { ExternalAgentError, type AgentInstallation } from './types.ts'

/** Cancellation is protocol-first: ask the agent to stop its turn, then allow a bounded
 * SIGTERM grace before forcing the process group. */
const CANCEL_GRACE_MS = 2_000
const TERM_GRACE_MS = 3_000
/** Cleanup-verification bound, not a reservation TTL. A timeout retains occupancy. */
export const GROUP_ACK_MS = 3_000
const GROUP_PROBE_MS = 25

export type ProcessCleanup =
  | { confirmed: true; reason: 'group_empty' | 'no_child' | 'spawn_failed' }
  | { confirmed: false; reason: 'group_timeout' | 'permission_denied' | 'close_error' | 'unsupported_platform' }

type Bounded<T> = { status: 'ok'; value: T } | { status: 'error'; error: unknown } | { status: 'timeout' }
function bounded<T>(promise: Promise<T>, ms: number): Promise<Bounded<T>> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, ms))
    promise.then(value => { clearTimeout(timer); resolve({ status: 'ok', value }) },
      error => { clearTimeout(timer); resolve({ status: 'error', error }) })
  })
}

/** The only confirmed boundary is the POSIX process group captured from an in-memory child.
 * `process.kill(-pgid, 0)` proves emptiness; no PID is persisted or read back from SQLite. */
export async function awaitOwnedGroupEmpty(pgid: number | undefined, closed: Promise<void>, deadlineMs = GROUP_ACK_MS): Promise<ProcessCleanup> {
  const deadline = Math.max(0, deadlineMs)
  const start = Date.now()
  const closeResult = await bounded(closed, deadline)
  if (closeResult.status === 'timeout') return { confirmed: false, reason: 'group_timeout' }
  if (closeResult.status === 'error') return { confirmed: false, reason: 'close_error' }
  if (!pgid) return { confirmed: true, reason: 'no_child' }
  if (process.platform === 'win32') return { confirmed: false, reason: 'unsupported_platform' }
  let denied = false
  for (;;) {
    try { process.kill(-pgid, 0); denied = false } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return { confirmed: true, reason: 'group_empty' }
      if (code === 'EPERM') denied = true
      else return { confirmed: false, reason: 'close_error' }
    }
    const remaining = deadline - (Date.now() - start)
    if (remaining <= 0) return { confirmed: false, reason: denied ? 'permission_denied' : 'group_timeout' }
    // A just-killed group can briefly report EPERM on macOS. Probe only; never resend signals.
    await new Promise(resolve => setTimeout(resolve, Math.min(GROUP_PROBE_MS, remaining)))
  }
}

/** Signal 0 only: false means the pid is certainly gone, true means "cannot prove dead" (alive, or not ours to signal). */
export function processMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
/** Identity evidence for a process group nobody in this process owns any more (boot reconciliation only).
 * `gone`: no process in the group. `ours`: a live process whose pid is the recorded group id AND whose start time is
 * within a few seconds of the recorded spawn: a reused pid would have a different start time. `unknown`: anything
 * else, including EPERM and an unreadable start time. Only `ours` may be signalled. */
export async function probeOrphanGroup(pgid: number, startedAtMs: number): Promise<'gone' | 'ours' | 'unknown'> {
  if (process.platform === 'win32' || !Number.isSafeInteger(pgid) || pgid <= 1) return 'unknown'
  try { process.kill(-pgid, 0) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
  const started = await new Promise<number | null>(resolve => {
    let output = ''
    let settled = false
    const done = (value: number | null) => { if (!settled) { settled = true; resolve(value) } }
    const child = spawn('/bin/ps', ['-o', 'lstart=', '-p', String(pgid)], { env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null) }, 3_000)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); done(null) })
    child.on('close', () => { clearTimeout(timer); const parsed = Date.parse(output.trim()); done(Number.isFinite(parsed) ? parsed : null) })
  })
  return started !== null && Math.abs(started - startedAtMs) <= 5_000 ? 'ours' : 'unknown'
}
/** SIGKILL a group already proven ours, then require ESRCH within the usual acknowledgement bound. */
export async function killOrphanGroup(pgid: number): Promise<boolean> {
  try { process.kill(-pgid, 'SIGKILL') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  const deadline = Date.now() + GROUP_ACK_MS
  while (Date.now() < deadline) {
    try { process.kill(-pgid, 0) } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
    await new Promise(resolve => setTimeout(resolve, GROUP_PROBE_MS))
  }
  return false
}

export async function isolatedEnvironment(root: string, install: AgentInstallation) {
  const key = createHash('sha256').update(JSON.stringify([install.nodeId, install.ownerAccountId, install.connectionId])).digest('hex')
  const base = join(root, 'external-agent-config', key)
  const dirs = [join(root, 'external-agent-config'), base, join(base, 'home'), join(base, 'config'), join(base, 'data'), join(base, 'cache'), join(base, 'tmp'), join(base, 'work')]
  for (const path of dirs) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new ExternalAgentError('unsafe_config_directory')
  }
  // Only metadata is inspected. Neither this module nor Guanxi opens files under vendor config.
  const paths = [dirname(process.execPath), dirname(install.executable), '/usr/bin', '/bin']
  if (install.claudeExecutable) paths.push(dirname(install.claudeExecutable))
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set(paths)].join(':'), HOME: join(base, 'home'),
    XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'),
    XDG_CACHE_HOME: join(base, 'cache'), TMPDIR: join(base, 'tmp'),
    CLAUDE_CONFIG_DIR: join(base, 'config'), CODEX_HOME: join(base, 'config'),
    COPILOT_HOME: join(base, 'config'), GEMINI_CLI_HOME: join(base, 'home'),
    GOOSE_PATH_ROOT: join(base, 'config'), NO_COLOR: '1',
  }
  if (install.claudeExecutable) env.CLAUDE_CODE_EXECUTABLE = install.claudeExecutable
  if (install.claudeBare) env.CLAUDE_CODE_SIMPLE = '1'
  return { env, cwd: join(base, 'work'), configDirectory: base }
}

export async function canonicalExecutable(path: string) {
  if (!isAbsolute(path)) throw new ExternalAgentError('absolute_executable_required')
  const canonical = await realpath(path)
  const stat = await lstat(canonical)
  if (!stat.isFile() || !(stat.mode & 0o111)) throw new ExternalAgentError('executable_unavailable')
  return canonical
}

/** Own bounded framing: the SDK's ndJsonStream logs malformed raw lines, including reasoning.
 * Raw stdout/stderr and parse errors are deliberately never sent to a logger. */
export class AgentProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly stream: Stream
  readonly closed: Promise<void>
  private stop = false
  private readonly scrubber: EgressScrubber
  private aborting: Promise<void> | null = null
  private cancelHandler: (() => void | Promise<void>) | null = null
  private closing: Promise<ProcessCleanup> | null = null
  constructor(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string,
    scrubber: EgressScrubber, signal: AbortSignal, frameBytes: number) {
    this.scrubber = scrubber
    signal.throwIfAborted()
    this.child = spawn(executable, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let pending = Buffer.alloc(0)
    let ended = false
    let controller!: ReadableStreamDefaultController<unknown>
    const fail = () => {
      if (ended) return
      ended = true
      controller.error(new ExternalAgentError('protocol_failed'))
      this.terminate('SIGKILL')
    }
    const readable = new ReadableStream({ start(value) { controller = value }, cancel: () => this.terminate('SIGKILL') })
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (ended) return
      pending = Buffer.concat([pending, chunk])
      try {
        for (;;) {
          const newline = pending.indexOf(10)
          if (newline < 0) { if (pending.length > frameBytes) fail(); break }
          if (newline > frameBytes) { fail(); break }
          const line = pending.subarray(0, newline).toString('utf8').trim()
          pending = pending.subarray(newline + 1)
          if (!line) continue
          const value = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(); break }
          if (!this.scrubber.isReady()) { fail(); break }
          controller.enqueue(this.scrubber.scrub(value))
        }
      } catch { fail() }
    })
    this.child.stderr.resume()
    this.child.stdin.on('error', () => { if (!this.stop) fail() })
    this.child.on('error', fail)
    this.closed = new Promise(resolve => this.child.once('close', () => {
      // A throwing stream callback must never strand the physical close observation.
      try {
        signal.removeEventListener('abort', abort)
        if (!ended) {
          ended = true
          if (pending.length && !this.stop) controller.error(new ExternalAgentError('truncated_protocol'))
          else controller.close()
        }
      } finally { resolve() }
    }))
    const abort = () => {
      if (ended) return
      ended = true
      this.aborting = this.cancelAndTerminate()
      controller.error(new ExternalAgentError('cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const writable = new WritableStream({ write: (value: unknown) => this.write(value) })
    this.stream = { readable: readable as Stream['readable'], writable: writable as Stream['writable'] }
  }
  write(value: unknown) {
    if (!this.scrubber.isReady() || this.stop || this.child.stdin.destroyed) return Promise.reject(new ExternalAgentError('agent_unavailable'))
    const bytes = JSON.stringify(this.scrubber.scrub(value)) + '\n'
    return new Promise<void>((resolve, reject) => this.child.stdin.write(bytes, error => error ? reject(new ExternalAgentError('protocol_failed')) : resolve()))
  }
  private terminate(signal: NodeJS.Signals) {
    if (!this.child.pid) return
    try {
      if (process.platform === 'win32') this.child.kill(signal)
      else process.kill(-this.child.pid, signal)
    } catch { /* Process/group already exited. */ }
  }
  /** ACP clients register `session/cancel`; Codex registers `turn/interrupt`. */
  setCancelHandler(handler: (() => void | Promise<void>) | null) { this.cancelHandler = handler }
  private waitClosed(ms: number) {
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), ms)
      void this.closed.then(() => { clearTimeout(timer); resolve(true) })
    })
  }
  private async cancelAndTerminate() {
    try { await bounded(Promise.resolve(this.cancelHandler?.()), CANCEL_GRACE_MS) } catch { /* The bounded termination below still applies. */ }
    if (await this.waitClosed(CANCEL_GRACE_MS)) return
    this.terminate('SIGTERM')
    if (await this.waitClosed(TERM_GRACE_MS)) return
    this.terminate('SIGKILL')
  }
  /** Idempotent: the cached acknowledgement is the only cleanup result for this child. */
  close(): Promise<ProcessCleanup> {
    this.closing ??= this.closeOnce()
    return this.closing
  }
  private async closeOnce(): Promise<ProcessCleanup> {
    const pgid = this.child.pid
    try {
      this.stop = true
      try { this.child.stdin.end() } catch { /* Already ended or destroyed. */ }
      if (this.aborting) {
        await this.aborting
        // The adapter may exit on stdin EOF before the grace signal, leaving same-group children.
        this.terminate('SIGKILL')
      } else {
        this.terminate('SIGTERM')
        await this.waitClosed(TERM_GRACE_MS)
        // SIGTERM targets the group too, but a descendant may ignore it while the adapter exits.
        this.terminate('SIGKILL')
      }
    } catch { return { confirmed: false, reason: 'close_error' } }
    return awaitOwnedGroupEmpty(pgid, this.closed, GROUP_ACK_MS)
  }
}

export interface ClaudeAuthStatus { loggedIn: boolean; authMethod: string | null }
export type ClaudeAuthStatusResult =
  | { ok: true; status: ClaudeAuthStatus }
  | { ok: false; error: 'auth_status_unavailable' | 'cancelled' }
export interface ClaudeAuthProbe {
  /** Discriminated union: an auth failure never loses the cleanup outcome. */
  result: Promise<ClaudeAuthStatusResult>
  close(): Promise<ProcessCleanup>
}

/** Official CLI status command, not a model call and never a credential-file read. */
export function startClaudeAuthStatus(executable: string, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, maxBytes: number): ClaudeAuthProbe {
  let child: ChildProcess | undefined
  try {
    signal.throwIfAborted()
    child = spawn(executable, ['auth', 'status'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  } catch {
    const error = signal.aborted ? 'cancelled' : 'auth_status_unavailable'
    return { result: Promise.resolve({ ok: false, error }), close: async () => ({ confirmed: true, reason: 'spawn_failed' }) }
  }
  const spawned = child
  let data = Buffer.alloc(0)
  let invalid = false
  let settled = false
  let closed = false
  let resolveResult!: (value: ClaudeAuthStatusResult) => void
  const result = new Promise<ClaudeAuthStatusResult>(resolve => { resolveResult = resolve })
  const settle = (value: ClaudeAuthStatusResult) => {
    if (settled) return
    settled = true
    data.fill(0)
    resolveResult(value)
  }
  const cleanup: { closing: Promise<ProcessCleanup> | null } = { closing: null }
  const terminate = () => {
    try {
      if (process.platform === 'win32') spawned.kill('SIGKILL')
      else if (spawned.pid) process.kill(-spawned.pid, 'SIGKILL')
    } catch { /* This status probe's process group already exited. */ }
  }
  const closedPromise = new Promise<void>(resolve => spawned.once('close', () => { closed = true; resolve() }))
  const abort = () => { invalid = true; terminate() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  spawned.stdout!.on('data', (chunk: Buffer) => {
    if (data.length + chunk.length > maxBytes) { invalid = true; terminate(); return }
    data = Buffer.concat([data, chunk])
  })
  spawned.stderr!.resume()
  spawned.on('error', () => { invalid = true })
  spawned.once('exit', terminate)
  spawned.once('close', code => {
    signal.removeEventListener('abort', abort)
    try {
      if (invalid || (code !== 0 && code !== 1)) throw new Error()
      const status = JSON.parse(data.toString('utf8'))
      // Drop emails, organization names and all unexpected fields immediately.
      settle({ ok: true, status: { loggedIn: status.loggedIn === true,
        authMethod: ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(status.authMethod) ? status.authMethod : null } })
    } catch {
      settle({ ok: false, error: signal.aborted ? 'cancelled' : 'auth_status_unavailable' })
    }
  })
  return {
    result,
    close() {
      if (cleanup.closing) return cleanup.closing
      cleanup.closing = (async () => {
        if (!settled) {
          invalid = true
          terminate()
          settle({ ok: false, error: signal.aborted ? 'cancelled' : 'auth_status_unavailable' })
        }
        signal.removeEventListener('abort', abort)
        if (!closed) terminate()
        return awaitOwnedGroupEmpty(spawned.pid, closedPromise, GROUP_ACK_MS)
      })()
      return cleanup.closing
    },
  }
}
