import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import type { Stream } from '@agentclientprotocol/sdk'
import type { EgressScrubber } from '../egress/types.ts'
import { ExternalAgentError, type AgentInstallation } from './types.ts'

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
      signal.removeEventListener('abort', abort)
      if (!ended) {
        ended = true
        if (pending.length && !this.stop) controller.error(new ExternalAgentError('truncated_protocol'))
        else controller.close()
      }
      resolve()
    }))
    const abort = () => { fail() }
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
  async close() {
    this.stop = true
    this.child.stdin.end()
    this.terminate('SIGTERM')
    const force = setTimeout(() => this.terminate('SIGKILL'), 100)
    try { await this.closed } finally { clearTimeout(force); this.terminate('SIGKILL') }
  }
}

/** Official CLI status command, not a model call and never a credential-file read. */
export async function claudeAuthStatus(executable: string, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, maxBytes: number) {
  signal.throwIfAborted()
  return new Promise<{ loggedIn: boolean; authMethod: string | null }>((resolve, reject) => {
    const child = spawn(executable, ['auth', 'status'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let data = Buffer.alloc(0)
    let invalid = false
    const terminate = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch { /* This status probe's process group already exited. */ }
    }
    const abort = () => { invalid = true; terminate() }
    child.stdout.on('data', (chunk: Buffer) => {
      if (data.length + chunk.length > maxBytes) { abort(); return }
      data = Buffer.concat([data, chunk])
    })
    child.stderr.resume()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.on('error', () => { invalid = true })
    child.once('exit', terminate)
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      try {
        if (invalid || (code !== 0 && code !== 1)) throw new Error()
        const status = JSON.parse(data.toString('utf8'))
        // Drop emails, organization names and all unexpected fields immediately.
        resolve({ loggedIn: status.loggedIn === true, authMethod: ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(status.authMethod) ? status.authMethod : null })
      } catch { reject(new ExternalAgentError('auth_status_unavailable')) }
      finally { data.fill(0) }
    })
  })
}
