/**
 * Minimal JSON-RPC 2.0 client over newline-delimited stdio.
 *
 * Deliberately does not depend on an MCP SDK. It implements only the client
 * half needed by this slice: requests, responses, notifications, error
 * objects, cancellation and a bounded frame size. Server stderr is never
 * accepted by this module, so it cannot leak into an error or a log.
 */
import type { Readable, Writable } from 'node:stream'
import {
  DEFAULT_MCP_MAX_MESSAGE_BYTES,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  McpError,
} from './types.ts'

export interface JsonRpcRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface JsonRpcConnectionOptions {
  stdin: Writable
  stdout: Readable
  maxMessageBytes?: number
  requestTimeoutMs?: number
  /** Called after a fatal framing/protocol fault; K4 wrappers may reap here. */
  kill?: () => void
  onNotification?: (method: string, params: unknown) => void
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
  signal: AbortSignal | undefined
  abortListener: (() => void) | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a finite positive number`)
  return value
}

const MAX_SERVER_ERROR_MESSAGE_CHARS = 200

/** Keeps a hostile server message bounded without splitting a code point. */
function truncateServerMessage(message: string): string {
  const characters = Array.from(message)
  if (characters.length <= MAX_SERVER_ERROR_MESSAGE_CHARS) return message
  return `${characters.slice(0, MAX_SERVER_ERROR_MESSAGE_CHARS - 1).join('')}…`
}

export class JsonRpcConnection {
  private readonly stdin: Writable
  private readonly stdout: Readable
  private readonly maxMessageBytes: number
  private readonly requestTimeoutMs: number
  private readonly kill: (() => void) | undefined
  private readonly onNotification: ((method: string, params: unknown) => void) | undefined

  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private chunks: Buffer[] = []
  private bufferedBytes = 0
  /** Absolute offset into `chunks` that has already been searched for a newline. */
  private scannedBytes = 0
  private closed = false

  constructor(options: JsonRpcConnectionOptions) {
    this.stdin = options.stdin
    this.stdout = options.stdout
    this.maxMessageBytes = positiveInteger(
      options.maxMessageBytes ?? DEFAULT_MCP_MAX_MESSAGE_BYTES,
      'maxMessageBytes',
    )
    this.requestTimeoutMs = positiveTimeout(
      options.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.kill = options.kill
    this.onNotification = options.onNotification

    this.stdout.on('data', this.handleData)
    this.stdout.on('end', this.handleEnd)
    this.stdout.on('close', this.handleEnd)
    this.stdout.on('error', this.handleStreamError)
    this.stdin.on('error', this.handleStreamError)
  }

  get isClosed(): boolean {
    return this.closed
  }

  request(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (typeof method !== 'string' || method.length === 0) throw new TypeError('method must be a non-empty string')
    if (this.closed) return Promise.reject(new McpError('mcp_closed', 'MCP connection is closed'))
    const signal = options.signal
    if (signal?.aborted) return Promise.reject(new McpError('mcp_aborted', `MCP request ${method} was aborted`))
    const timeoutMs = positiveTimeout(options.timeoutMs ?? this.requestTimeoutMs, 'timeoutMs')
    const id = this.nextId++

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer: undefined,
        signal,
        abortListener: undefined,
      }
      this.pending.set(id, pending)

      if (signal !== undefined) {
        const abortListener = () => {
          this.cancel(id, new McpError('mcp_aborted', `MCP request ${method} was aborted`), 'aborted')
        }
        pending.abortListener = abortListener
        signal.addEventListener('abort', abortListener, { once: true })
      }

      pending.timer = setTimeout(() => {
        this.cancel(id, new McpError('mcp_timeout', `MCP request ${method} timed out after ${timeoutMs} ms`), 'timeout')
      }, timeoutMs)

      try {
        this.write({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        })
      } catch (error) {
        this.settleReject(
          id,
          error instanceof McpError ? error : new McpError('mcp_transport', 'MCP request could not be written'),
        )
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (typeof method !== 'string' || method.length === 0) throw new TypeError('method must be a non-empty string')
    this.write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  /** Rejects every in-flight request; the caller still owns the process. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(new McpError('mcp_closed', 'MCP connection closed'))
    this.discardBuffer()
  }

  /** Called when the transport reports process exit. Never includes stderr. */
  transportClosed(message = 'MCP server exited'): void {
    this.fail(new McpError('mcp_transport', message), false)
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (bytes.length > 0) {
      this.chunks.push(bytes)
      this.bufferedBytes += bytes.length
    }

    for (;;) {
      const newline = this.findNewline()
      if (newline === -1) break
      const framed = this.takeBuffered(newline + 1)
      let line = framed.subarray(0, framed.length - 1)
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length > this.maxMessageBytes) {
        this.fail(new McpError(
          'mcp_message_too_large',
          `MCP message exceeded the ${this.maxMessageBytes}-byte limit`,
        ), true)
        return
      }
      if (line.length > 0) this.handleLine(line.toString('utf8'))
      if (this.closed) return
    }

    if (this.bufferedBytes > this.maxMessageBytes) {
      this.fail(new McpError(
        'mcp_message_too_large',
        `MCP message exceeded the ${this.maxMessageBytes}-byte limit`,
      ), true)
    }
  }

  /** Finds a newline without re-concatenating every buffered chunk. */
  private findNewline(): number {
    let base = 0
    for (const chunk of this.chunks) {
      const start = Math.max(0, this.scannedBytes - base)
      if (start < chunk.length) {
        const index = chunk.indexOf(0x0a, start)
        if (index !== -1) return base + index
      }
      base += chunk.length
    }
    this.scannedBytes = this.bufferedBytes
    return -1
  }

  /** Removes the leading `count` bytes, copying only when a frame spans chunks. */
  private takeBuffered(count: number): Buffer {
    let remaining = count
    let wholeChunks = 0
    while (wholeChunks < this.chunks.length && this.chunks[wholeChunks]!.length <= remaining) {
      remaining -= this.chunks[wholeChunks]!.length
      wholeChunks++
    }
    const parts = this.chunks.slice(0, wholeChunks)
    if (remaining > 0) {
      const head = this.chunks[wholeChunks]
      if (head !== undefined) {
        parts.push(head.subarray(0, remaining))
        this.chunks[wholeChunks] = head.subarray(remaining)
      }
    }
    this.chunks.splice(0, wholeChunks)
    this.bufferedBytes -= count
    this.scannedBytes = 0
    if (parts.length === 1) return parts[0]!
    return Buffer.concat(parts, count)
  }

  private discardBuffer(): void {
    this.chunks = []
    this.bufferedBytes = 0
    this.scannedBytes = 0
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(new McpError('mcp_protocol', 'MCP server sent malformed JSON'), true)
      return
    }

    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      this.fail(new McpError('mcp_protocol', 'MCP server sent a non-JSON-RPC 2.0 message'), true)
      return
    }

    if (typeof message.method === 'string') {
      if (message.method.length === 0) {
        this.fail(new McpError('mcp_protocol', 'MCP server sent an empty method'), true)
        return
      }
      if (message.id !== undefined && message.id !== null) {
        if (typeof message.id !== 'number' && typeof message.id !== 'string') {
          this.fail(new McpError('mcp_protocol', 'MCP server sent an invalid request id'), true)
          return
        }
        try {
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          })
        } catch {
          // A write failure is reported by the write callback, not here.
        }
        return
      }
      if (this.onNotification !== undefined) {
        try {
          this.onNotification(message.method, message.params)
        } catch {
          // A consumer callback must not corrupt the framing loop.
        }
      }
      return
    }

    if (!('id' in message)) {
      this.fail(new McpError('mcp_protocol', 'MCP server sent a message without a method or id'), true)
      return
    }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
      this.fail(new McpError('mcp_protocol', 'MCP server sent an invalid response id'), true)
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return

    if ('error' in message) {
      const error = message.error
      if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
        this.fail(new McpError('mcp_protocol', 'MCP server sent an invalid error object'), true)
        return
      }
      this.settleReject(message.id, new McpError(
        'mcp_rpc_error',
        `${pending.method} failed: ${truncateServerMessage(error.message)}`,
        { rpcCode: error.code },
      ))
      return
    }

    if (!('result' in message)) {
      this.fail(new McpError('mcp_protocol', 'MCP server response has neither result nor error'), true)
      return
    }
    this.settleResolve(message.id, message.result)
  }

  private write(message: unknown): void {
    if (this.closed) throw new McpError('mcp_closed', 'MCP connection is closed')
    let payload: string
    try {
      payload = JSON.stringify(message)
    } catch {
      throw new McpError('mcp_protocol', 'MCP message is not JSON-serializable')
    }
    this.stdin.write(`${payload}\n`, error => {
      if (error !== null && error !== undefined && !this.closed) {
        this.fail(new McpError('mcp_transport', 'MCP request could not be written'), false)
      }
    })
  }

  private cancel(id: number, error: McpError, reason: 'timeout' | 'aborted'): void {
    if (!this.pending.has(id)) return
    try {
      this.notify('notifications/cancelled', { requestId: id, reason })
    } catch {
      // The connection may already be closing; the request still rejects.
    }
    this.settleReject(id, error)
  }

  private settleResolve(id: number, value: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    this.detach(pending)
    pending.resolve(value)
  }

  private settleReject(id: number, error: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    this.detach(pending)
    pending.reject(error)
  }

  private detach(pending: PendingRequest): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
  }

  private rejectPending(error: McpError): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id)
      this.detach(pending)
      pending.reject(error)
    }
  }

  private readonly handleEnd = (): void => {
    this.fail(new McpError('mcp_transport', 'MCP server closed its output'), false)
  }

  private readonly handleStreamError = (): void => {
    this.fail(new McpError('mcp_transport', 'MCP transport failed'), false)
  }

  private fail(error: McpError, kill: boolean): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(error)
    this.discardBuffer()
    if (kill) {
      try {
        this.kill?.()
      } catch {
        // Killing is best effort; the caller still awaits `exited`.
      }
    }
  }
}
