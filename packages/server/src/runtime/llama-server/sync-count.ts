import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { RelayError } from '../../relay/types.ts'
import { loopbackOrigin, LLAMA_SERVER_MAX_JSON_BYTES, LLAMA_SERVER_TEMPLATE_KWARGS } from './client.ts'

/** The relay measure is synchronous (`RelayExactCounter.count`, `budget.ts`) and is called tens of
 * times per request build, but the only exact renderer and tokenizer is the llama-server process.
 * One worker thread performs the two HTTP calls; this thread blocks on `Atomics.wait` for the
 * answer with a hard timeout. A timeout, a protocol problem or a dead worker is an error, never
 * an estimate: there is no byte-count or cached-ratio fallback. Only a successful exact answer
 * for the identical content is reused. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { buffer, origin, timeoutMs, maximum } = workerData
const control = new Int32Array(buffer, 0, 2), data = new Uint8Array(buffer, 8)
const finish = result => {
  const bytes = Buffer.from(JSON.stringify(result)), size = Math.min(bytes.length, data.length)
  data.set(bytes.subarray(0, size)); Atomics.store(control, 1, bytes.length > data.length ? -1 : size)
  Atomics.store(control, 0, 1); Atomics.notify(control, 0)
}
const post = async (path, body) => {
  const response = await fetch(origin + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
  if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > maximum) throw new Error('status')
  const text = await response.text()
  if (text.length > maximum) throw new Error('size')
  return JSON.parse(text)
}
parentPort.on('message', async ({ content, kwargs }) => {
  try {
    const rendered = await post('/apply-template', { messages: [{ role: 'user', content }], chat_template_kwargs: kwargs })
    if (typeof rendered.prompt !== 'string') throw new Error('shape')
    const tokens = await post('/tokenize', { content: rendered.prompt, add_special: true, parse_special: true })
    if (!Array.isArray(tokens.tokens)) throw new Error('shape')
    finish({ tokens: tokens.tokens.length })
  } catch { finish({ error: true }) }
})
`
const RESULT_BYTES = 256

export interface SyncTokenCounterOptions { baseUrl: string; timeoutMs?: number; cacheEntries?: number }
export class SyncTokenCounter {
  private readonly origin: string
  private readonly timeoutMs: number
  private readonly cacheEntries: number
  private readonly cache = new Map<string, number>()
  private worker?: Worker
  private buffer?: SharedArrayBuffer
  private closed = false
  constructor(options: SyncTokenCounterOptions) {
    this.origin = loopbackOrigin(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.cacheEntries = options.cacheEntries ?? 512
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isSafeInteger(this.cacheEntries) || this.cacheEntries < 0) throw new RelayError('runtime_policy_invalid')
  }
  /** Drop remembered answers after the served model identity changed. */
  clear(): void { this.cache.clear() }
  private start(): { worker: Worker; control: Int32Array; data: Uint8Array } {
    if (!this.worker || !this.buffer) {
      const buffer = new SharedArrayBuffer(8 + RESULT_BYTES)
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { buffer, origin: this.origin, timeoutMs: this.timeoutMs, maximum: LLAMA_SERVER_MAX_JSON_BYTES } })
      worker.unref()
      // A crashed worker is replaced on the next call; the pending call has its own timeout.
      const drop = () => { if (this.worker === worker) { this.worker = undefined; this.buffer = undefined } }
      worker.once('error', drop); worker.once('exit', drop)
      this.worker = worker; this.buffer = buffer
    }
    return { worker: this.worker, control: new Int32Array(this.buffer, 0, 2), data: new Uint8Array(this.buffer, 8) }
  }
  private reset(): void {
    const worker = this.worker
    this.worker = undefined; this.buffer = undefined
    void worker?.terminate().catch(() => undefined)
  }
  /** Exact token count of `content` rendered as one user message and tokenized by the server.
   * `fresh` skips the answer cache and is used by the bind-time self-test. */
  count(content: string, fresh = false): number {
    if (this.closed) throw new RelayError('runtime_count_invalid')
    const key = createHash('sha256').update(content).digest('hex')
    const known = fresh ? undefined : this.cache.get(key)
    if (known !== undefined) return known
    const { worker, control, data } = this.start()
    Atomics.store(control, 0, 0)
    worker.postMessage({ content, kwargs: LLAMA_SERVER_TEMPLATE_KWARGS })
    if (Atomics.wait(control, 0, 0, this.timeoutMs + 2_000) === 'timed-out') { this.reset(); throw new RelayError('runtime_count_invalid') }
    const size = Atomics.load(control, 1)
    let result: unknown
    try { result = size < 0 ? undefined : JSON.parse(Buffer.from(data.subarray(0, size)).toString('utf8')) } catch { result = undefined }
    const tokens = result && typeof result === 'object' ? (result as { tokens?: unknown }).tokens : undefined
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) throw new RelayError('runtime_count_invalid')
    if (this.cacheEntries > 0) {
      if (this.cache.size >= this.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, tokens)
    }
    return tokens
  }
  async close(): Promise<void> {
    this.closed = true; this.cache.clear()
    const worker = this.worker
    this.worker = undefined; this.buffer = undefined
    await worker?.terminate().catch(() => undefined)
  }
}
