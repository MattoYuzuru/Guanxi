import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LEAD_DELEGATE_TOOL } from '@guanxi/contract'

export interface ToolGrantContext { runId: string; attemptId: string; wakeSeq: number | null }
/** `hold` keeps the HTTP request open and unanswered: the caller is about to be stopped, so it
 * never receives a result and consumes no further tokens. Revocation closes the socket. */
export type ToolResult = { kind: 'result'; text: string; isError?: boolean } | { kind: 'hold' }
export type ToolHandler = (input: unknown, context: ToolGrantContext) => Promise<ToolResult>
export interface ToolGrant { readonly header: { name: string; value: string }; revoke(): void }

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const ENDPOINT = '/mcp'
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = { type: 'string', minLength: 1 }
const count = { type: 'integer', minimum: 1 }
const nullableCount = { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] }
const idString = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' }
const relativePath = { type: 'string', minLength: 1 }
/** Hand-written JSON Schema of `leadDelegateInputSchema`; a test proves they agree on samples. */
export const LEAD_DELEGATE_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['objective', 'definitionOfDone', 'plan', 'caps', 'executor', 'deadlineMs'],
  properties: {
    objective: { ...text, maxLength: 4000 },
    definitionOfDone: { type: 'array', minItems: 1, maxItems: 50, items: { ...text, maxLength: 1000 } },
    plan: { type: 'object', additionalProperties: false, required: ['revision', 'base', 'goal', 'items', 'protectedPaths'], properties: {
      revision: idString, base: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, goal: text, protectedPaths: { type: 'array', items: relativePath },
      items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'dependsOn', 'acceptance', 'protectedPaths'], properties: {
        id: idString, title: text, dependsOn: { type: 'array', items: idString }, acceptance: { type: 'array', minItems: 1, items: text },
        protectedPaths: { type: 'array', items: relativePath } } } } } },
    estimatesMs: { type: 'object', additionalProperties: count },
    caps: { type: 'object', additionalProperties: false, required: ['cycles', 'tokens', 'moneyMicros', 'wallMs'],
      properties: { cycles: nullableCount, tokens: nullableCount, moneyMicros: nullableCount, wallMs: nullableCount } },
    executor: { type: 'object', additionalProperties: false, required: ['connectionId', 'model'], properties: { connectionId: text, model: text } },
    deadlineMs: count,
    onDeadline: { enum: ['wrap_up', 'detach'] },
    onCancel: { enum: ['cancel', 'detach'] },
  },
} as const
const TOOL = {
  name: LEAD_DELEGATE_TOOL,
  description: 'Hand a verified plan to an executor on the node and hibernate. This call does not return: your session is stopped at zero cost ' +
    'and resumed with a short wake packet when the work resolves, escalates or reaches its deadline.',
  inputSchema: LEAD_DELEGATE_JSON_SCHEMA,
}

interface Grant { context: ToolGrantContext; handler: ToolHandler; held: Set<ServerResponse>; revoked: boolean }
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** Loopback-only MCP endpoint (Streamable HTTP, JSON responses, no server push). A grant is one
 * lead turn: a random bearer token bound to run, attempt and wake sequence. */
export class LeadToolServer {
  private server: Server | null = null
  private starting: Promise<string> | null = null
  private port = 0
  private closed = false
  private readonly grants = new Map<string, Grant>()
  private readonly maxBodyBytes: number
  private readonly wantedPort: number
  constructor(options: { maxBodyBytes?: number; port?: number } = {}) { this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576; this.wantedPort = options.port ?? 0 }

  /** Starts listening on first use and returns the endpoint URL. */
  url(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('lead_tools_closed'))
    this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response) })
      const failed = (error: Error) => { this.starting = null; reject(error) }
      server.once('error', failed)
      server.listen(this.wantedPort, '127.0.0.1', () => {
        server.off('error', failed)
        // Accept-level errors after startup concern one connection; they must not take the node down.
        server.on('error', () => undefined)
        this.port = (server.address() as AddressInfo).port
        this.server = server
        resolve(`http://127.0.0.1:${this.port}${ENDPOINT}`)
      })
    })
    return this.starting
  }
  /** The address the listener is actually bound to; null before first use. */
  address(): { address: string; port: number } | null {
    const bound = this.server?.address()
    return bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null
  }
  grant(context: ToolGrantContext, handler: ToolHandler): ToolGrant {
    const token = randomBytes(32).toString('base64url')
    const grant: Grant = { context: { ...context }, handler, held: new Set(), revoked: false }
    this.grants.set(digest(token), grant)
    return {
      header: { name: 'Authorization', value: `Bearer ${token}` },
      revoke: () => {
        grant.revoked = true
        this.grants.delete(digest(token))
        for (const response of grant.held) response.destroy()
        grant.held.clear()
      },
    }
  }
  /** Grants that are still valid; a finished turn must leave none behind. */
  activeGrants(): number { return this.grants.size }
  async close(): Promise<void> {
    this.closed = true
    for (const grant of this.grants.values()) { grant.revoked = true; for (const response of grant.held) response.destroy() }
    this.grants.clear()
    const server = this.server ?? (this.starting ? await this.starting.then(() => this.server, () => null) : null)
    if (!server) return
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }

  private reply(response: ServerResponse, status: number, body?: unknown): void {
    if (response.destroyed || response.writableEnded) return
    const payload = body === undefined ? '' : JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' })
    response.end(payload)
  }
  private rpcError(response: ServerResponse, id: unknown, code: number, message: string): void {
    this.reply(response, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const host = request.headers.host
      // A browser page or a DNS-rebinding name can reach a loopback port; an MCP client sends neither.
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.reply(response, 403, { error: 'forbidden_host' })
      if (request.headers.origin !== undefined) return this.reply(response, 403, { error: 'forbidden_origin' })
      if (request.url !== ENDPOINT) return this.reply(response, 404, { error: 'not_found' })
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return this.reply(response, 405, { error: 'method_not_allowed' }) }
      const authorization = request.headers.authorization ?? ''
      const grant = authorization.startsWith('Bearer ') ? this.grants.get(digest(authorization.slice(7))) : undefined
      if (!grant || grant.revoked) return this.reply(response, 401, { error: 'unauthorized' })
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return this.reply(response, 415, { error: 'unsupported_media_type' })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += (chunk as Buffer).length
        if (size > this.maxBodyBytes) { this.reply(response, 413, { error: 'payload_too_large' }); request.destroy(); return }
        chunks.push(chunk as Buffer)
      }
      let message: unknown
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return this.rpcError(response, null, -32700, 'parse_error') }
      const body = object(message)
      // JSON-RPC batches are not part of the 2025-06-18 transport.
      if (Array.isArray(message) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return this.rpcError(response, body.id, -32600, 'invalid_request')
      if (body.id === undefined) return this.reply(response, 202)
      const params = object(body.params)
      switch (body.method) {
        case 'initialize': {
          const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
          return this.reply(response, 200, { jsonrpc: '2.0', id: body.id, result: {
            protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'guanxi-lead', version: '0.1.0' } } })
        }
        case 'ping': return this.reply(response, 200, { jsonrpc: '2.0', id: body.id, result: {} })
        case 'tools/list': return this.reply(response, 200, { jsonrpc: '2.0', id: body.id, result: { tools: [TOOL] } })
        case 'tools/call': {
          if (params.name !== LEAD_DELEGATE_TOOL) return this.rpcError(response, body.id, -32602, 'unknown_tool')
          let outcome: ToolResult
          try { outcome = await grant.handler(params.arguments, grant.context) } catch { outcome = { kind: 'result', text: 'lead_tool_failed', isError: true } }
          if (grant.revoked || response.destroyed) { response.destroy(); return }
          if (outcome.kind === 'hold') {
            grant.held.add(response)
            response.once('close', () => grant.held.delete(response))
            return
          }
          return this.reply(response, 200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError === true } })
        }
        default: return this.rpcError(response, body.id, -32601, 'method_not_found')
      }
    } catch {
      this.reply(response, 500, { error: 'internal_error' })
    }
  }
}
