import type { AgentProcess } from './process.ts'
import { ExternalAgentError } from './types.ts'
import { protocolObject as object } from './quota.ts'

/** Quiet RPC correlation. No SDK/raw error logger is reachable on this boundary. */
export class JsonRpcClient {
  protected readonly process: AgentProcess
  private id = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  private failure: Error | null = null
  private readonly read: Promise<void>
  private readonly acp: boolean
  constructor(process: AgentProcess, acp = false) {
    this.process = process
    this.acp = acp
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
        if (this.acp && frame.jsonrpc !== '2.0') throw new ExternalAgentError('protocol_failed')
        if (typeof frame.method === 'string') {
          if (frame.id !== undefined) {
            // No filesystem/terminal approvals, token refresh, dynamic tools or credential requests.
            await this.process.write({ ...(this.acp ? { jsonrpc: '2.0' } : {}), id: frame.id,
              ...(this.acp && frame.method === 'session/request_permission' ? { result: { outcome: { outcome: 'cancelled' } } }
                : { error: { code: -32601, message: 'Client capability unavailable' } }) })
          } else for (const listener of this.listeners) listener(frame.method, object(frame.params))
        } else if (typeof frame.id === 'number' || typeof frame.id === 'string') {
          if (typeof frame.id !== 'number') continue
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
      void this.process.write({ ...(this.acp ? { jsonrpc: '2.0' } : {}), id, method, ...(params === undefined ? {} : { params }) }).catch(() => {
        this.pending.delete(id); reject(new ExternalAgentError('protocol_failed'))
      })
    })
  }
  on(listener: (method: string, params: Record<string, unknown>) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async close() { await this.process.close(); await this.read }
}
