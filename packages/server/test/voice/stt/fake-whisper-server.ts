/**
 * In-process `whisper-server` fixture for the STT adapter tests.
 *
 * It speaks only the subset the adapter uses: `GET /health` and multipart `POST /inference`.
 * The handler records the exact form fields and files it received, so tests can assert both the
 * documented shape and the D-157 "no prompt field" case. No model, no network beyond loopback.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeWhisperFile {
  field: string
  filename: string
  contentType: string
  bytes: Uint8Array
}

export interface FakeWhisperRequest {
  method: string
  path: string
  /** Raw request target, including any query string. */
  target: string
  headers: Record<string, string>
  /** Form field names in the order the client sent them. */
  fieldOrder: string[]
  /** Text fields. A field the client omitted is absent, not an empty string. */
  fields: Record<string, string>
  files: FakeWhisperFile[]
}

export interface FakeWhisperReply {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  /** A string or byte array is sent verbatim; any other value is JSON-serialised. */
  body?: unknown
  delayMs?: number
  /** Stream the body in these chunks; Content-Length is omitted unless set explicitly. */
  chunks?: string[]
  chunkDelayMs?: number
  /** Omit Content-Length when null. Defaults to the body length, or omitted for chunks. */
  contentLength?: number | null
  /** Write half of the body and destroy the socket, producing a truncated 200 answer. */
  truncate?: boolean
}

export type FakeWhisperHandler =
  (request: FakeWhisperRequest) => FakeWhisperReply | Promise<FakeWhisperReply>

export interface FakeWhisperServer {
  readonly url: string
  readonly port: number
  readonly requests: FakeWhisperRequest[]
  setHealth(reply: FakeWhisperReply | FakeWhisperHandler): void
  setInference(reply: FakeWhisperReply | FakeWhisperHandler): void
  close(): Promise<void>
}

export interface StartFakeWhisperServerOptions {
  health?: FakeWhisperReply | FakeWhisperHandler
  inference?: FakeWhisperReply | FakeWhisperHandler
}

const HEALTH_PATH = '/health'
const INFERENCE_PATH = '/inference'

export const DEFAULT_VERBOSE_JSON = Object.freeze({
  task: 'transcribe',
  language: 'english',
  duration: 1,
  text: ' hello',
  segments: [
    {
      id: 0,
      start: 0,
      end: 1,
      text: ' hello',
      avg_logprob: -0.1,
      no_speech_prob: 0.01,
    },
  ],
})

function replyBody(reply: FakeWhisperReply): string | Uint8Array {
  if (reply.body === undefined) return ''
  if (typeof reply.body === 'string' || reply.body instanceof Uint8Array) return reply.body
  return JSON.stringify(reply.body)
}

async function parseMultipart(
  request: IncomingMessage,
): Promise<Pick<FakeWhisperRequest, 'fieldOrder' | 'fields' | 'files'>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const parsed = await new Request('http://127.0.0.1/', {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  }).formData()
  const fieldOrder: string[] = []
  const fields: Record<string, string> = {}
  const files: FakeWhisperFile[] = []
  for (const [name, value] of parsed.entries()) {
    fieldOrder.push(name)
    if (typeof value === 'string') {
      fields[name] = value
    } else {
      files.push({
        field: name,
        filename: value.name,
        contentType: value.type,
        bytes: new Uint8Array(await value.arrayBuffer()),
      })
    }
  }
  return { fieldOrder, fields, files }
}

async function writeReply(
  response: ServerResponse,
  reply: FakeWhisperReply,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  if (response.destroyed || response.writableEnded) return
  const payload = replyBody(reply)
  const headers: Record<string, string | number> = {
    'content-type': reply.contentType ?? 'application/json',
    ...reply.headers,
  }
  const declared = reply.contentLength === undefined && reply.truncate
    ? Buffer.byteLength(payload)
    : reply.contentLength
  const omitLength = declared === null || (declared === undefined && reply.chunks !== undefined)
  if (omitLength) delete headers['content-length']
  else headers['content-length'] = declared ?? Buffer.byteLength(payload)
  try {
    response.writeHead(reply.status ?? 200, headers)
    if (reply.truncate) {
      const half = Math.max(1, Math.floor(payload.length / 2))
      const prefix = typeof payload === 'string' ? payload.slice(0, half) : payload.subarray(0, half)
      response.write(prefix)
      // Let the client observe the 200 headers and start reading before cutting the socket.
      await wait(20)
      response.destroy()
      return
    }
    if (reply.chunks !== undefined) {
      for (const chunk of reply.chunks) {
        if (response.destroyed) return
        response.write(chunk)
        if (reply.chunkDelayMs !== undefined && reply.chunkDelayMs > 0) {
          await wait(reply.chunkDelayMs)
        }
      }
      if (!response.destroyed) response.end()
      return
    }
    response.end(payload)
  } catch {
    // The client may have timed out or aborted while a delayed reply was pending.
  }
}

export async function startFakeWhisperServer(
  options: StartFakeWhisperServerOptions = {},
): Promise<FakeWhisperServer> {
  const requests: FakeWhisperRequest[] = []
  let health: FakeWhisperReply | FakeWhisperHandler = options.health
    ?? { body: { status: 'ok' } }
  let inference: FakeWhisperReply | FakeWhisperHandler = options.inference
    ?? { body: DEFAULT_VERBOSE_JSON }
  const abort = new AbortController()

  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    if (abort.signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    abort.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

  const respond = async (
    response: ServerResponse,
    handler: FakeWhisperReply | FakeWhisperHandler,
    request: FakeWhisperRequest,
  ): Promise<void> => {
    const reply = typeof handler === 'function' ? await handler(request) : handler
    if (reply.delayMs !== undefined && reply.delayMs > 0) await wait(reply.delayMs)
    await writeReply(response, reply, wait)
  }

  const server: Server = createServer(async (request, response) => {
    response.on('error', () => undefined)
    const target = request.url ?? '/'
    const path = new URL(target, 'http://127.0.0.1').pathname
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    const record: FakeWhisperRequest = {
      method: request.method ?? '',
      path,
      target,
      headers,
      fieldOrder: [],
      fields: {},
      files: [],
    }
    try {
      if (request.method === 'POST' && path === INFERENCE_PATH) {
        Object.assign(record, await parseMultipart(request))
      }
    } catch {
      requests.push(record)
      await writeReply(response, { status: 400, body: { error: 'multipart' } }, wait)
      return
    }
    requests.push(record)
    if (path === HEALTH_PATH) {
      await respond(response, health, record)
      return
    }
    if (request.method === 'POST' && path === INFERENCE_PATH) {
      await respond(response, inference, record)
      return
    }
    await writeReply(response, { status: 404, body: { error: 'not found' } }, wait)
  })
  server.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  let closing: Promise<void> | undefined

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHealth(reply) { health = reply },
    setInference(reply) { inference = reply },
    close: () => closing ??= (async () => {
      abort.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })(),
  }
}
