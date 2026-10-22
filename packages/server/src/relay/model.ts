import type { Connections } from '../connections/service.ts'
import type { WindowObservation } from './types.ts'
import { invariant } from './types.ts'

export interface Reply { text: string; inputTokens: number; outputTokens: number; moneyMicros: number | null; inputTruncated: boolean; outputLimited: boolean }
/** Host adapter, never model-authored. W and token counts refer to the ACTUAL rendered
 * request and loaded context, including template tokens. Missing observations fail closed. */
export interface RuntimeMeter {
  readonly countIsExact?: boolean
  readonly localOnly?: boolean
  authorizeDispatch?(signal?: AbortSignal): Promise<void>
  validatePrepared?(request: import('../ollama/types.ts').OllamaChatRequest): void
  observe(signal?: AbortSignal): Promise<WindowObservation>
  count(prompt: string): number
  maxCostMicros?(input: number, output: number): number | null
}
export interface RelayModel extends RuntimeMeter {
  /** True only for an adapter with a real tokenizer. Byte-bounded adapters leave this false
   * so packing and the boundary share the same conservative measure. */
  readonly countIsExact?: boolean
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
  maxCostMicros(input: number, output: number) { return this.meter.maxCostMicros?.(input, output) ?? null }
  async call(prompt: string, o: Parameters<RelayModel['call']>[1]): Promise<Reply> {
    const connection = this.connections.snapshot('local').connections.find(c => c.id === this.connectionId)
    invariant(connection, 'connection_not_found')
    invariant(!this.meter.localOnly || connection.kind === 'local_runtime', 'relay_local_connection_required')
    let dispatchedPrompt = prompt
    const call = { runId: o.runId, requestId: o.requestId, signal: o.signal, background: this.background, onStarted: o.onStarted,
      ...(this.meter.authorizeDispatch ? { authorizeDispatch: () => this.meter.authorizeDispatch!(o.signal) } : {}),
      onPrepared: (request: import('@earendil-works/pi-ai').Context | import('../ollama/types.ts').OllamaChatRequest) => {
        invariant(request.messages.length === 1 && request.messages[0]!.role === 'user' && typeof request.messages[0]!.content === 'string', 'request_shape')
        dispatchedPrompt = request.messages[0]!.content as string
        const tokens = this.count(dispatchedPrompt)
        invariant(Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= o.maxInput, 'context_ceiling')
        this.meter.validatePrepared?.(request as import('../ollama/types.ts').OllamaChatRequest)
      } }
    if (connection.kind === 'local_runtime') {
      const r = await this.connections.localChat('local', this.connectionId, { model: this.model, stream: false, ...(this.meter.localOnly ? { think: false } : {}),
        messages: [{ role: 'user', content: prompt }], options: { num_ctx: o.window.tokens, num_predict: o.maxOutput } }, call)
      invariant(Number.isSafeInteger(r.prompt_eval_count) && Number.isSafeInteger(r.eval_count), 'usage_unknown')
      const inputTokens = r.prompt_eval_count!
      return { text: r.message?.content ?? '', inputTokens, outputTokens: r.eval_count!, moneyMicros: this.model.endsWith(':cloud') ? null : 0,
        inputTruncated: inputTokens !== this.count(dispatchedPrompt), outputLimited: r.done_reason === 'length' }
    }
    invariant(connection.kind === 'model_api', 'connection_not_supported')
    const r = await this.connections.complete('local', this.connectionId, { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
      { ...call, model: this.model, options: { maxTokens: o.maxOutput } })
    return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), inputTokens: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite,
      outputTokens: r.usage.output, moneyMicros: Math.ceil(r.usage.cost.total * 1e6), inputTruncated: false, outputLimited: r.stopReason === 'length' }
  }
}
