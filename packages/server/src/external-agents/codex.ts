import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { AgentProcess } from './process.ts'
import { ExternalAgentError, type AgentOutput } from './types.ts'
import { protocolObject as object } from './quota.ts'

/** Codex's documented line-delimited app-server protocol. No OAuth implementation or token mode. */
export class CodexClient {
  private readonly process: AgentProcess
  private id = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  private failure: Error | null = null
  private readonly read: Promise<void>
  constructor(process: AgentProcess) {
    this.process = process
    this.read = this.pump()
  }
  private fail(error: Error) {
    this.failure = error
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
  private async pump() {
    const reader = this.process.stream.readable.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const frame = object(value)
        if (typeof frame.method === 'string') {
          if (frame.id !== undefined) {
            // No filesystem/terminal approvals, token refresh, dynamic tools or credential requests.
            await this.process.write({ id: frame.id, error: { code: -32601, message: 'Client capability unavailable' } })
          } else for (const listener of this.listeners) listener(frame.method, object(frame.params))
        } else if (typeof frame.id === 'number') {
          const waiter = this.pending.get(frame.id)
          if (!waiter) continue
          this.pending.delete(frame.id)
          if (frame.error) waiter.reject(new ExternalAgentError('provider_failed'))
          else waiter.resolve(frame.result)
        } else throw new ExternalAgentError('protocol_failed')
      }
    } catch { /* No raw SDK/vendor errors or frames are logged. */ }
    finally { this.fail(new ExternalAgentError('agent_disconnected')); reader.releaseLock() }
  }
  request(method: string, params?: unknown) {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.id
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.process.write({ id, method, ...(params === undefined ? {} : { params }) }).catch(() => {
        this.pending.delete(id); reject(new ExternalAgentError('protocol_failed'))
      })
    })
  }
  on(listener: (method: string, params: Record<string, unknown>) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async initialize(version: string) {
    const init = object(await this.request('initialize', { clientInfo: { name: `${PRODUCT_FILE_PREFIX}_external`, version: '0.1.0' }, capabilities: { experimentalApi: false } }))
    const reported = typeof init.userAgent === 'string' ? init.userAgent : ''
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`(^|[^0-9.])${escaped}($|[^0-9.])`).test(reported)) throw new ExternalAgentError('adapter_version_mismatch')
    await this.process.write({ method: 'initialized' })
  }
  async account() {
    const result = object(await this.request('account/read', { refreshToken: false }))
    const account = object(result.account)
    // Only the officially signed-in CLI's Plus/Pro mode is admitted. No API-key/token fallback.
    if (account.type !== 'chatgpt' || !['plus', 'pro'].includes(String(account.planType))) throw new ExternalAgentError('chatgpt_login_required')
    return { type: 'chatgpt', plan: String(account.planType) }
  }
  async login(onAuthUrl: (url: string) => void, signal: AbortSignal) {
    let complete!: (value: Record<string, unknown>) => void
    const messages: Record<string, unknown>[] = []
    const finish = new Promise<Record<string, unknown>>(resolve => { complete = resolve })
    const off = this.on((method, params) => { if (method === 'account/login/completed') { messages.push(params); complete(params) } })
    try {
      const result = object(await this.request('account/login/start', { type: 'chatgpt' }))
      const url = new URL(String(result.authUrl))
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw new ExternalAgentError('invalid_auth_url')
      onAuthUrl(url.href)
      signal.throwIfAborted()
      const notification = messages.find(m => m.loginId === result.loginId) ?? await finish
      if (notification.loginId !== result.loginId || notification.success !== true) throw new ExternalAgentError('login_failed')
      return await this.account()
    } finally { off() }
  }
  async prompt(model: string, text: string, cwd: string, reasoning?: string): Promise<AgentOutput> {
    const result = object(await this.request('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'read-only' }))
    const threadId = object(result.thread).id
    if (typeof threadId !== 'string') throw new ExternalAgentError('protocol_failed')
    let textOutput = ''
    let done!: (value: Record<string, unknown>) => void
    const completion = new Promise<Record<string, unknown>>(resolve => { done = resolve })
    // Attach before turn/start: notifications can arrive before its response.
    const off = this.on((method, params) => {
      if (params.threadId !== threadId) return
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') textOutput += params.delta
      if (method === 'turn/completed') done(object(params.turn))
    })
    try {
      const started = object(await this.request('turn/start', { threadId, input: [{ type: 'text', text }], ...(reasoning ? { effort: reasoning } : {}) }))
      const turnId = object(started.turn).id
      const turn = await Promise.race([completion, this.process.closed.then(() => { throw new ExternalAgentError('agent_disconnected') })])
      if (turn.id !== turnId || turn.status !== 'completed') throw new ExternalAgentError('provider_failed')
      return { text: textOutput, stopReason: 'end_turn' }
    } finally { off() }
  }
  async close() { await this.process.close(); await this.read }
}
