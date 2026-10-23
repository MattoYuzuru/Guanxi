import type { Connections, LocalChatTransport } from '../connections/service.ts'
import type { WindowObservation } from './types.ts'
import { invariant } from './types.ts'

export interface Reply { text: string; inputTokens: number; outputTokens: number; moneyMicros: number | null; inputTruncated: boolean; outputLimited: boolean }
/** Host adapter, never model-authored. W and token counts refer to the ACTUAL rendered
 * request and loaded context, including template tokens. Missing observations fail closed. */
export interface RuntimeMeter {
  readonly countIsExact?: boolean
  readonly localOnly?: boolean
  /** T0 wire transport of a non-Ollama local runtime; K3 keeps every admission and scrubbing check. */
  readonly transport?: LocalChatTransport
  authorizeDispatch?(signal?: AbortSignal): Promise<void>
  validatePrepared?(request: import('../ollama/types.ts').OllamaChatRequest): void
  observe(signal?: AbortSignal): Promise<WindowObservation>
  count(prompt: string): number
  /** A meter whose exact answer needs a network round trip (F2-d). `count` is then only a lookup of answers
   * already obtained for the identical string, and refuses on a miss. */
  countAsync?(prompt: string, signal?: AbortSignal): Promise<number>
  maxCostMicros?(input: number, output: number): number | null
}
export interface RelayModel extends RuntimeMeter {
  /** True only for an adapter with a real tokenizer. Byte-bounded adapters leave this false
   * so packing and the boundary share the same conservative measure. */
  readonly countIsExact?: boolean
  countAsync?(prompt: string, signal?: AbortSignal): Promise<number>
  call(prompt: string, options: { runId: string; requestId: string; maxOutput: number; maxInput: number; window: WindowObservation; signal?: AbortSignal; onStarted?: () => void }): Promise<Reply>
}
export class ConnectionRelayModel implements RelayModel {
  get countIsExact() { return this.meter.countIsExact === true }
  readonly connections: Connections; readonly connectionId: string; readonly model: string; readonly meter: RuntimeMeter; readonly background: boolean
  constructor(connections: Connections, connectionId: string, model: string, meter: RuntimeMeter, background = true) {
    this.connections = connections; this.connectionId = connectionId; this.model = model; this.meter = meter; this.background = background
  }
  observe(signal?: AbortSignal) { return this.meter.observe(signal) }
  count(prompt: string) { return this.meter.count(prompt) }
  get countAsync() { return this.meter.countAsync ? (prompt: string, signal?: AbortSignal) => this.meter.countAsync!(prompt, signal) : undefined }
  maxCostMicros(input: number, output: number) { return this.meter.maxCostMicros?.(input, output) ?? null }
  async call(prompt: string, o: Parameters<RelayModel['call']>[1]): Promise<Reply> {
    const connection = this.connections.snapshot('local').connections.find(c => c.id === this.connectionId)
    invariant(connection, 'connection_not_found')
    invariant(!this.meter.localOnly || connection.kind === 'local_runtime', 'relay_local_connection_required')
    let dispatchedTokens = -1
    const call = { runId: o.runId, requestId: o.requestId, signal: o.signal, background: this.background, onStarted: o.onStarted,
      ...(this.meter.authorizeDispatch ? { authorizeDispatch: () => this.meter.authorizeDispatch!(o.signal) } : {}),
      onPrepared: (request: import('@earendil-works/pi-ai').Context | import('../ollama/types.ts').OllamaChatRequest) => {
        invariant(request.messages.length === 1 && request.messages[0]!.role === 'user' && typeof request.messages[0]!.content === 'string', 'request_shape')
        const tokens = this.count(request.messages[0]!.content as string)
        invariant(Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= o.maxInput, 'context_ceiling')
        dispatchedTokens = tokens
        this.meter.validatePrepared?.(request as import('../ollama/types.ts').OllamaChatRequest)
      } }
    if (connection.kind === 'local_runtime') {
      const r = await this.connections.localChat('local', this.connectionId, { model: this.model, stream: false, ...(this.meter.localOnly ? { think: false } : {}),
        messages: [{ role: 'user', content: prompt }], options: { num_ctx: o.window.tokens, num_predict: o.maxOutput } },
      { ...call, ...(this.meter.transport ? { transport: this.meter.transport } : {}) })
      invariant(Number.isSafeInteger(r.prompt_eval_count) && Number.isSafeInteger(r.eval_count), 'usage_unknown')
      const inputTokens = r.prompt_eval_count!
      return { text: r.message?.content ?? '', inputTokens, outputTokens: r.eval_count!, moneyMicros: this.model.endsWith(':cloud') ? null : 0,
        // Compared with the count taken when the request was prepared: counting again here would demand a fresh runtime
        // observation after the call, and a real call may outlast the observation age (minutes on a slow executor).
        inputTruncated: inputTokens !== (dispatchedTokens < 0 ? this.count(prompt) : dispatchedTokens), outputLimited: r.done_reason === 'length' }
    }
    invariant(connection.kind === 'model_api', 'connection_not_supported')
    const r = await this.connections.complete('local', this.connectionId, { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
      { ...call, model: this.model, options: { maxTokens: o.maxOutput } })
    return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), inputTokens: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite,
      outputTokens: r.usage.output, moneyMicros: Math.ceil(r.usage.cost.total * 1e6), inputTruncated: false, outputLimited: r.stopReason === 'length' }
  }
}
