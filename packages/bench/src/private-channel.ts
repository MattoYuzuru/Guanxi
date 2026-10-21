import { z } from 'zod'
import { BenchGatewayError, type createTrialGateway } from './k3-gateway.ts'

export class BenchChannelError extends Error {
  constructor(code: string) { super(code); this.name = 'BenchChannelError' }
}
function fail(code: string): never { throw new BenchChannelError(code) }
function frameLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) fail('channel_policy_invalid')
}
/** Four-byte unsigned big-endian UTF-8 payload length, followed by exactly one JSON value. */
export function encodePrivateFrame(value: unknown, maximumPayloadBytes: number): Buffer {
  frameLimit(maximumPayloadBytes)
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { fail('channel_frame_invalid') }
  if (serialized === undefined) fail('channel_frame_invalid')
  const length = Buffer.byteLength(serialized)
  if (length > maximumPayloadBytes) fail('channel_frame_too_large')
  const frame = Buffer.allocUnsafe(4 + length)
  frame.writeUInt32BE(length); frame.write(serialized, 4)
  return frame
}

/** Incremental decoder never allocates an announced payload above the explicit policy.
 * A transport owns read-buffer bounds, EOF, peer identity and closing this decoder. */
export class PrivateFrameDecoder {
  private readonly maximum: number
  private readonly header = Buffer.alloc(4)
  private headerUsed = 0
  private body: Buffer | undefined
  private bodyUsed = 0
  private closed = false
  constructor(maximumPayloadBytes: number) { frameLimit(maximumPayloadBytes); this.maximum = maximumPayloadBytes }
  *push(chunk: Uint8Array): Generator<unknown> {
    if (this.closed) fail('channel_closed')
    let offset = 0
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.length - offset)
          this.header.set(chunk.subarray(offset, offset + count), this.headerUsed)
          offset += count; this.headerUsed += count
          if (this.headerUsed < 4) continue
          const length = this.header.readUInt32BE()
          if (!length || length > this.maximum) fail('channel_frame_too_large')
          this.body = Buffer.allocUnsafe(length)
        }
        const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset)
        this.body.set(chunk.subarray(offset, offset + count), this.bodyUsed)
        offset += count; this.bodyUsed += count
        if (this.bodyUsed < this.body.length) continue
        let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body)) }
        catch { fail('channel_frame_invalid') }
        this.body = undefined; this.bodyUsed = 0; this.headerUsed = 0
        yield value
      }
    } catch (error) { this.closed = true; throw error }
  }
  finish(): void {
    if (this.closed) fail('channel_closed')
    this.closed = true
    if (this.headerUsed || this.bodyUsed || this.body) fail('channel_frame_truncated')
  }
}

const name = z.string().min(1)
const toolCall = z.object({ id: name, name, arguments: z.record(z.unknown()) }).strict()
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), text: z.string() }).strict(),
  z.object({ role: z.literal('user'), text: z.string() }).strict(),
  z.object({ role: z.literal('assistant'), text: z.string(), toolCalls: z.array(toolCall) }).strict(),
  z.object({ role: z.literal('toolResult'), text: z.string(), toolCallId: name, toolName: name, isError: z.boolean() }).strict(),
])
export const privateCompletionSchema = z.object({
  version: z.literal(1), id: z.number().int().nonnegative().safe(), operation: z.literal('complete'),
  context: z.object({ messages: z.array(message),
    tools: z.array(z.object({ name, description: z.string(), parameters: z.record(z.unknown()) }).strict()),
  }).strict(),
}).strict()
export type PrivateCompletion = z.infer<typeof privateCompletionSchema>
type Gateway = ReturnType<typeof createTrialGateway>
type Completion = Awaited<ReturnType<Gateway['complete']>>
type Context = Parameters<Gateway['complete']>[0]
export interface PrivateChannelPolicy { maximumPayloadBytes: number; maximumRequests: number; requestTimeoutMs: number }
export interface PrivateChannelHost {
  gateway: Pick<Gateway, 'complete'>
  /** Immutable catalog identity supplied by the coordinator, never a request selector. */
  model: { api: string; provider: string; id: string }
  /** Private K2 sink. The module never writes a log/trajectory or returns reasoning. */
  retain(requestId: string, result: Completion['result']): Promise<void>
}
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
function contextOf(input: PrivateCompletion['context'], model: PrivateChannelHost['model']): Context {
  const timestamp = Date.now()
  const messages = input.messages.map(item => {
    if (item.role === 'assistant') return { role: item.role, api: model.api, provider: model.provider, model: model.id,
      content: [...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
        ...item.toolCalls.map(call => ({ type: 'toolCall' as const, ...call }))],
      usage: emptyUsage(), timestamp, stopReason: item.toolCalls.length ? 'toolUse' as const : 'stop' as const }
    if (item.role === 'toolResult') return { role: item.role, toolCallId: item.toolCallId, toolName: item.toolName,
      content: [{ type: 'text' as const, text: item.text }], isError: item.isError, timestamp }
    return { role: item.role, content: item.text, timestamp }
  })
  // JSON schemas lost TypeBox's compile-time symbol during framing. The strict
  // wire schema above preserves the runtime JSON form consumed by pi-ai.
  return { messages, tools: input.tools } as Context
}
const gatewayCodes = new Set(['gateway_cancelled', 'gateway_connection_mismatch', 'gateway_quote_failed',
  'gateway_accounting_failed', 'gateway_model_failed', 'gateway_prepared_hook_missing', 'gateway_usage_invalid',
  'gateway_usage_unknown', 'request_quote_unknown', 'request_quote_mismatch', 'request_quote_not_current',
  'request_quote_overflow', 'request_identity_invalid', 'request_run_not_open', 'request_run_expired',
  'request_model_mismatch', 'request_trial_unknown', 'request_trial_halted', 'request_already_admitted',
  'request_in_flight_or_unreconciled', 'request_budget_exceeded', 'request_bound_violated'])

/** Pure protocol state machine, not a socket listener or executable stdio endpoint.
 * A transport must call close on EOF/disconnect and await settled before releasing
 * trial ownership. No restart/retry or credential transfer is implemented. */
export class PrivateTrialChannel {
  private readonly host: PrivateChannelHost
  private readonly policy: Readonly<PrivateChannelPolicy>
  private readonly lifetime = new AbortController()
  private readonly seen = new Set<number>()
  private pending: Promise<Buffer> | undefined
  private closed = false
  constructor(host: PrivateChannelHost, policy: PrivateChannelPolicy) {
    frameLimit(policy.maximumPayloadBytes)
    if (!Number.isSafeInteger(policy.maximumRequests) || policy.maximumRequests <= 0 ||
      !Number.isSafeInteger(policy.requestTimeoutMs) || policy.requestTimeoutMs <= 0 || policy.requestTimeoutMs > 0x7fffffff)
      fail('channel_policy_invalid')
    this.host = { gateway: host.gateway, model: Object.freeze({ ...host.model }), retain: host.retain.bind(host) }
    this.policy = Object.freeze({ ...policy })
  }
  close(): void { this.closed = true; this.lifetime.abort() }
  get isClosed(): boolean { return this.closed }
  async settled(): Promise<void> { await this.pending?.then(() => undefined, () => undefined) }
  handle(raw: unknown): Promise<Buffer> {
    if (this.closed) return Promise.reject(new BenchChannelError('channel_closed'))
    const parsed = privateCompletionSchema.safeParse(raw)
    if (this.pending || !parsed.success || this.seen.has(parsed.data.id) || this.seen.size >= this.policy.maximumRequests) {
      this.close(); return Promise.reject(new BenchChannelError('channel_request_invalid'))
    }
    // Enforce the same bound even when a trusted transport bypasses the decoder.
    try { encodePrivateFrame(parsed.data, this.policy.maximumPayloadBytes) }
    catch (error) { this.close(); return Promise.reject(error) }
    const request = parsed.data
    this.seen.add(request.id)
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.policy.requestTimeoutMs)])
    const work = async () => {
      try {
        const { requestId, result } = await this.host.gateway.complete(contextOf(request.context, this.host.model), signal)
        signal.throwIfAborted()
        await this.host.retain(requestId, result)
        signal.throwIfAborted()
        const message = { text: result.content.filter(block => block.type === 'text').map(block => block.text).join(''),
          toolCalls: result.content.filter(block => block.type === 'toolCall').map(block => ({ id: block.id, name: block.name, arguments: block.arguments })),
          stopReason: result.stopReason }
        return encodePrivateFrame({ version: 1, id: request.id, status: 'ok', requestId, message }, this.policy.maximumPayloadBytes)
      } catch (error) {
        this.close()
        const code = error instanceof BenchGatewayError && gatewayCodes.has(error.code) ? error.code : 'channel_failed'
        return encodePrivateFrame({ version: 1, id: request.id, status: 'error', code }, this.policy.maximumPayloadBytes)
      }
    }
    const pending = work()
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined }).catch(() => undefined)
    return pending
  }
}
