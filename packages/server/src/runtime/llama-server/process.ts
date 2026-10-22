import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute } from 'node:path'
import { RelayError } from '../../relay/types.ts'
import { normalizeOllamaModelReference } from '../observation-key.ts'
import { LlamaServerClient, loopbackOrigin } from './client.ts'
import { LlamaServerRuntime } from './runtime.ts'

/** Immutable boot description of the one llama-server instance the relay may use. It never comes
 * from HTTP. `spawn` lets Guanxi own a child process; `attach` uses a server the owner already
 * runs (for example a service on a Fedora host) and never signals it. */
export type LlamaServerBoot =
  | { kind: 'spawn'; binary: string; modelPath: string; model: string; contextTokens: number; port?: number; startupTimeoutMs?: number; stopGraceMs?: number }
  | { kind: 'attach'; baseUrl: string; model: string }
export type LlamaServerState =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'unavailable'; reason: LlamaServerUnavailable }
export type LlamaServerUnavailable = 'llama_server_binary_missing' | 'llama_server_model_missing' | 'llama_server_spawn_failed' |
  'llama_server_start_timeout' | 'llama_server_exited' | 'llama_server_closed'

/** Only these variables reach the child. In particular no `LLAMA_ARG_*` (which could rebind the
 * listener) and no credential in the server's own environment. */
const CHILD_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES']
export const LLAMA_SERVER_STARTUP_TIMEOUT_MS = 10 * 60_000
export const LLAMA_SERVER_STOP_GRACE_MS = 10_000

function executable(path: string): string | null {
  try {
    if (!isAbsolute(path)) return null
    const real = realpathSync(path)
    accessSync(real, constants.X_OK)
    return statSync(real).isFile() ? real : null
  } catch { return null }
}
function readable(path: string): string | null {
  try {
    if (!isAbsolute(path)) return null
    const real = realpathSync(path)
    accessSync(real, constants.R_OK)
    return statSync(real).isFile() ? real : null
  } catch { return null }
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port'))) })
  })
}

/** Owns the lifecycle of the llama-server child (spawn mode) and exposes the runtime once the
 * server reports healthy. Construction never throws for an absent binary or model: that is the
 * ordinary "not configured here" state and the relay keeps its stock refusal. */
export class LlamaServerHost {
  private served: LlamaServerRuntime | null = null
  private current: LlamaServerState = { state: 'starting' }
  private child?: ChildProcess
  private closing = false
  private graceMs = LLAMA_SERVER_STOP_GRACE_MS
  private exited?: Promise<void>
  private readonly lifetime = new AbortController()
  private startup: Promise<void> = Promise.resolve()
  private constructor() {}
  /** Null while the binary or model file is absent. */
  get runtime(): LlamaServerRuntime | null { return this.served }
  state(): LlamaServerState { return this.current }
  /** Resolves when the host reached `ready` or `unavailable`; never rejects. */
  settled(): Promise<void> { return this.startup }
  ready(): void {
    if (this.current.state !== 'ready') throw new RelayError('runtime_meter_unavailable')
  }
  private fail(reason: LlamaServerUnavailable): void {
    if (this.current.state !== 'unavailable') this.current = { state: 'unavailable', reason }
  }
  static create(boot: LlamaServerBoot): LlamaServerHost {
    const model = normalizeOllamaModelReference(boot.model)
    if (!model || /:cloud$/i.test(boot.model)) throw new RelayError('relay_local_model_required')
    const host = new LlamaServerHost()
    if (boot.kind === 'attach') {
      host.served = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: loopbackOrigin(boot.baseUrl) }), model })
      host.current = { state: 'ready' }
      return host
    }
    if (!Number.isSafeInteger(boot.contextTokens) || boot.contextTokens <= 0) throw new RelayError('relay_policy_invalid')
    if (boot.port !== undefined && !(Number.isSafeInteger(boot.port) && boot.port >= 1 && boot.port <= 65535)) throw new RelayError('relay_policy_invalid')
    const binary = executable(boot.binary), modelPath = readable(boot.modelPath)
    if (!binary) host.fail('llama_server_binary_missing')
    else if (!modelPath) host.fail('llama_server_model_missing')
    else { host.graceMs = boot.stopGraceMs ?? LLAMA_SERVER_STOP_GRACE_MS; host.startup = host.launch(boot, binary, modelPath, model) }
    return host
  }
  private async launch(boot: Extract<LlamaServerBoot, { kind: 'spawn' }>, binary: string, modelPath: string, model: string): Promise<void> {
    try {
      const port = boot.port ?? await freePort()
      if (this.closing) return
      const client = new LlamaServerClient({ baseUrl: `http://127.0.0.1:${port}` })
      this.served = new LlamaServerRuntime({ client, model, expectedModelPath: modelPath, ready: () => this.ready() })
      const args = ['-m', modelPath, '--alias', model, '--host', '127.0.0.1', '--port', String(port), '-c', String(boot.contextTokens),
        '-np', '1', '--jinja', '--no-context-shift', '--no-webui']
      const env: Record<string, string> = {}
      for (const name of CHILD_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]!
      // Output can contain prompts at verbose levels: it is not captured and never logged.
      const child = spawn(binary, args, { stdio: 'ignore', env, detached: false })
      this.child = child
      this.exited = new Promise<void>(resolve => child.once('close', () => { this.child = undefined; resolve() }))
      child.once('error', () => this.fail('llama_server_spawn_failed'))
      child.once('exit', () => this.fail(this.closing ? 'llama_server_closed' : 'llama_server_exited'))
      const deadline = Date.now() + (boot.startupTimeoutMs ?? LLAMA_SERVER_STARTUP_TIMEOUT_MS)
      while (this.current.state === 'starting') {
        if (this.lifetime.signal.aborted) return
        if (Date.now() >= deadline) { this.fail('llama_server_start_timeout'); await this.stopChild(); return }
        try { if (await client.health(this.lifetime.signal) === 'ok' && this.current.state === 'starting') { this.current = { state: 'ready' }; return } } catch { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } catch { this.fail('llama_server_spawn_failed') }
  }
  private async stopChild(): Promise<void> {
    const graceMs = this.graceMs, child = this.child, exited = this.exited
    if (!child || !exited) return
    // Only the pid this host started, and only while that handle is still alive.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs) })])
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  }
  async close(): Promise<void> {
    if (this.closing) { await this.exited; return }
    this.closing = true
    this.lifetime.abort()
    this.fail('llama_server_closed')
    await this.startup
    await this.stopChild()
    await this.served?.close()
  }
}
