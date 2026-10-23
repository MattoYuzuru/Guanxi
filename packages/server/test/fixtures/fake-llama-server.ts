import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

/** A deterministic stand-in for llama.cpp `llama-server`. It mimics only the endpoints Guanxi calls
 * and none of the model. Tokens are words, newlines and `<|...|>` markers (plus one BOS when
 * `add_special` is true), so every count is reproducible by hand.
 *
 * The server runs in its own thread. The relay's synchronous counter blocks the calling thread while a
 * worker talks to the server, so an in-process server on the same event loop could never answer. */
export interface FakeLlamaState {
  alias: string | null
  modelPath: string
  nCtx: number
  buildInfo: string
  loading: boolean
  /** `raw` renders the message unchanged: a template that adds no framing. */
  template: 'chat' | 'raw'
  /** Added to `tokens_evaluated` only: a dispatcher that disagrees with its own tokenizer. */
  evaluatedSkew: number
  /** Add one to every `/tokenize` answer after this many calls (counter instability). */
  tokenizeSkewAfter: number | null
  truncated: boolean
  stopType: string
  tokenizeDelayMs: number
  completionDelayMs: number
  /** Replies for successive `/completion` calls; the last repeats. A `{ js }` entry is a
   * self-contained function source `(prompt, call, body) => string`, evaluated inside the server thread; `body` is the parsed
   * request body, so a reply can depend on whether a `json_schema` arrived. */
  replies: Array<string | { js: string }>
  /** Respond with this body on `/props` (malformed answer fixtures). */
  propsOverride: unknown
  argv: string[]
  /** Process mode only: what the child inherited. */
  env: string[]
  pid: number
  cwd: string
}
export interface FakeLlamaRequest { method: string; path: string; body: any }
export interface FakeLlama {
  readonly url: string
  readonly port: number
  configure(patch: Partial<FakeLlamaState>): Promise<void>
  requests(path?: string): Promise<FakeLlamaRequest[]>
  count(path: string): Promise<number>
  /** Responses that were cut off by the client before they finished. */
  aborted(): Promise<number>
  close(): Promise<void>
}
/** Serialise a function as a `replies` entry. It must not capture variables. */
export const reply = (fn: (prompt: string, call: number, body: any) => string): { js: string } => ({ js: fn.toString() })

export const BOS = 1
export function fakeTokens(text: string, addSpecial = true): number {
  return (text.match(/<\|[a-z_]+\|>|<\/?think>|\n|[^\s<]+|</g) ?? []).length + (addSpecial ? BOS : 0)
}
export function fakeRender(content: string, state: Pick<FakeLlamaState, 'template'>, thinking: boolean): string {
  if (state.template === 'raw') return content
  return `<|user|>\n${content}<|end|>\n<|assistant|>\n${thinking ? '' : '<think>\n\n</think>\n\n'}`
}

async function serve(initial: Partial<FakeLlamaState>, port: number, control?: (message: any) => void) {
  const state: FakeLlamaState = { alias: 'fixture', modelPath: '/nonexistent.gguf', nCtx: 16000, buildInfo: 'b0-fixture', loading: false,
    template: 'chat', evaluatedSkew: 0, tokenizeSkewAfter: null, truncated: false, stopType: 'eos', tokenizeDelayMs: 0, completionDelayMs: 0,
    replies: ['{}'], propsOverride: undefined, argv: [], env: [], pid: 0, cwd: '', ...initial }
  const requests: FakeLlamaRequest[] = []
  let completions = 0, tokenizes = 0, aborted = 0
  const read = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : undefined }
  const send = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const server: Server = createServer(async (request, response) => {
    response.on('close', () => { if (!response.writableEnded) aborted++ })
    const path = new URL(request.url!, 'http://x').pathname
    const body = request.method === 'POST' ? await read(request) : undefined
    requests.push({ method: request.method!, path, body })
    if (path === '/health') return state.loading ? send(response, 503, { error: { code: 503, message: 'Loading model' } }) : send(response, 200, { status: 'ok' })
    if (path === '/props') return send(response, 200, state.propsOverride !== undefined ? state.propsOverride : { default_generation_settings: { id: 0, n_ctx: state.nCtx },
      total_slots: 1, model_alias: state.alias, model_path: state.modelPath, build_info: state.buildInfo, chat_template: '{{ messages }}', __argv: state.argv, __env: state.env, __pid: state.pid, __cwd: state.cwd })
    if (path === '/apply-template') {
      const thinking = body.chat_template_kwargs?.enable_thinking !== false
      return send(response, 200, { prompt: fakeRender(body.messages[0].content, state, thinking) })
    }
    if (path === '/tokenize') {
      const n = ++tokenizes
      if (state.tokenizeDelayMs) await wait(state.tokenizeDelayMs)
      const skew = state.tokenizeSkewAfter !== null && n > state.tokenizeSkewAfter ? 1 : 0
      return send(response, 200, { tokens: Array.from({ length: fakeTokens(body.content, body.add_special === true) + skew }, (_, i) => i) })
    }
    if (path === '/completion') {
      const n = completions++
      if (state.completionDelayMs) await wait(state.completionDelayMs)
      const entry = state.replies[Math.min(n, state.replies.length - 1)]!
      const content = typeof entry === 'string' ? entry : (0, eval)(`(${entry.js})`)(body.prompt, n, body) as string
      return send(response, 200, { content, tokens_evaluated: fakeTokens(body.prompt, true) + state.evaluatedSkew, tokens_predicted: fakeTokens(content, false),
        stop_type: state.stopType, truncated: state.truncated, stopped_limit: false, tokens_cached: 0 })
    }
    send(response, 404, { error: { code: 404, message: 'not found' } })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  control?.({ listening: (server.address() as AddressInfo).port })
  return { state, requests, aborted: () => aborted,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

export async function startFakeLlama(initial: Partial<FakeLlamaState> = {}, listen: { port?: number } = {}): Promise<FakeLlama> {
  const worker = new Worker(new URL(import.meta.url), { workerData: { initial, port: listen.port ?? 0 } })
  const pending = new Map<number, (value: any) => void>()
  let next = 0, closing: Promise<void> | undefined
  const port = await new Promise<number>((resolve, reject) => {
    worker.once('error', reject)
    worker.on('message', (message: any) => { if (message.listening) resolve(message.listening); else pending.get(message.id)?.(message.value) })
  })
  const ask = <T>(op: string, payload?: unknown) => new Promise<T>(resolve => { const id = ++next; pending.set(id, resolve); worker.postMessage({ id, op, payload }) })
  return { url: `http://127.0.0.1:${port}`, port, configure: patch => ask('configure', patch), requests: path => ask('requests', path),
    count: async path => (await ask<FakeLlamaRequest[]>('requests', path)).length, aborted: () => ask('aborted'),
    close: () => closing ??= (async () => { await ask('close'); await worker.terminate() })() }
}

if (!isMainThread && parentPort && workerData?.initial !== undefined) {
  const port = parentPort
  const running = await serve(workerData.initial, workerData.port, message => port.postMessage(message))
  port.on('message', async (message: { id: number; op: string; payload: any }) => {
    let value: unknown
    if (message.op === 'configure') Object.assign(running.state, message.payload)
    else if (message.op === 'requests') value = message.payload ? running.requests.filter(r => r.path === message.payload) : running.requests
    else if (message.op === 'aborted') value = running.aborted()
    else if (message.op === 'close') await running.close()
    port.postMessage({ id: message.id, value })
  })
}

// Run as a process, this file is a stand-in `llama-server` binary: it honours the argument subset
// Guanxi passes and reports the full argv on `/props` so a test can assert it.
if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), value = (flag: string) => argv[argv.indexOf(flag) + 1]
  const behaviour = value('--fixture-behaviour') ?? 'serve'
  if (behaviour === 'exit') process.exit(3)
  const running = await serve({ alias: value('--alias') ?? null, modelPath: value('-m') ?? '', nCtx: Number(value('-c') ?? 0), argv, env: Object.keys(process.env), pid: process.pid, cwd: process.cwd(),
    loading: behaviour === 'never-ready' }, Number(value('--port')))
  const stop = () => { void running.close().then(() => process.exit(0)) }
  process.on('SIGTERM', behaviour === 'ignore-term' ? () => undefined : stop)
}
