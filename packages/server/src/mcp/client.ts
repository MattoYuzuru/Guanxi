/**
 * MCP client core: stdio transport, JSON-RPC handshake and manager policy.
 *
 * SECURITY: this slice is not sandboxed. The default spawn port runs a server
 * as the current user with an explicit minimal environment and an absolute
 * command path, but with no filesystem or network confinement. Do not enable
 * an untrusted MCP server until the K4 sandbox wrapper is wired here. The
 * manager is off unless project policy explicitly sets `mcp.enabled: true`.
 */
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { PRODUCT_NAME } from '@guanxi/contract'
import { MCP_LOAD_TOOL_NAME, MCP_SEARCH_TOOL_NAME } from './budget.ts'
import { JsonRpcConnection } from './jsonrpc.ts'
import {
  DEFAULT_MCP_MAX_MESSAGE_BYTES,
  DEFAULT_MCP_MAX_TOOL_PAGES,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpInitializeResult,
  type McpProcessExit,
  type McpProjectPolicy,
  type McpRequestOptions,
  type McpServerConfig,
  type McpSpawn,
  type McpTool,
  type McpToolCallResult,
  type McpTransport,
  type McpTransportSpec,
} from './types.ts'

/** Explicit allowlist; the whole parent environment is never inherited. */
const BASE_ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'en_US.UTF-8',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True only when the value survives a JSON round-trip without losing type or data. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  try {
    const roundTripped: unknown = JSON.parse(JSON.stringify(value))
    return isRecord(roundTripped) && isDeepStrictEqual(roundTripped, value)
  } catch {
    return false
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a finite positive number`)
  return value
}

/** Validates the port contract before a spawn implementation sees it. */
export function validateTransportSpec(spec: McpTransportSpec): void {
  if (typeof spec.command !== 'string' || !isAbsolute(spec.command)) {
    throw new McpError('mcp_config', 'MCP command must be an absolute path')
  }
  if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd)) {
    throw new McpError('mcp_config', 'MCP working directory must be an absolute path')
  }
  if (!Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) {
    throw new McpError('mcp_config', 'MCP arguments must be strings')
  }
  if (!isRecord(spec.env)) {
    throw new McpError('mcp_config', 'MCP environment must be an explicit string map')
  }
  for (const [name, value] of Object.entries(spec.env)) {
    if (name.length === 0 || typeof value !== 'string') {
      throw new McpError('mcp_config', 'MCP environment must contain string names and values')
    }
  }
}

/**
 * Default transport port. Starts an absolute executable without a shell and
 * discards stderr, which may contain credentials. This is not a sandbox.
 */
export function spawnMcpProcess(spec: McpTransportSpec): McpTransport {
  validateTransportSpec(spec)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      // A POSIX process group lets close() reap helpers that inherit stdio.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  } catch {
    throw new McpError('mcp_config', 'MCP server could not be started')
  }
  if (child.stdin === null || child.stdout === null) {
    child.kill('SIGKILL')
    throw new McpError('mcp_config', 'MCP transport did not expose stdin and stdout')
  }
  const stdin = child.stdin
  const stdout = child.stdout

  const exited = new Promise<McpProcessExit>((resolve) => {
    let settled = false
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    }
    // `exit` settles even when a grandchild keeps the stdio pipes open.
    child.once('exit', settle)
    // A spawn error may not be followed by `exit` on every platform.
    child.once('error', () => settle(null, null))
  })

  const pid = child.pid
  return {
    stdin,
    stdout,
    kill(signal: NodeJS.Signals = 'SIGKILL') {
      if (process.platform !== 'win32' && pid !== undefined) {
        try {
          process.kill(-pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            try {
              child.kill(signal)
            } catch {
              // Already exited or reaped elsewhere.
            }
          }
        }
      } else {
        try {
          child.kill(signal)
        } catch {
          // Already exited or reaped elsewhere.
        }
      }
      // A helper may still hold the pipes; do not wait on its descriptors.
      stdin.destroy()
      stdout.destroy()
    },
    exited,
  }
}

export interface McpClientOptions {
  server: McpServerConfig
  spawn?: McpSpawn
  requestTimeoutMs?: number
  maxMessageBytes?: number
  maxToolPages?: number
  /** Protocol versions accepted in addition to the pinned version. */
  allowedProtocolVersions?: readonly string[]
}

function parseInitializeResult(value: unknown): McpInitializeResult {
  if (!isRecord(value)) throw new McpError('mcp_protocol', 'MCP initialize result is not an object')
  if (typeof value.protocolVersion !== 'string' || value.protocolVersion.length === 0) {
    throw new McpError('mcp_protocol', 'MCP initialize result has no protocolVersion')
  }
  const capabilities = value.capabilities === undefined ? {} : value.capabilities
  if (!isRecord(capabilities)) throw new McpError('mcp_protocol', 'MCP initialize capabilities are not an object')
  const result: McpInitializeResult = {
    protocolVersion: value.protocolVersion,
    capabilities: { ...capabilities },
  }
  if (isRecord(value.serverInfo)) {
    const serverInfo: { name?: string; version?: string } = {}
    if (typeof value.serverInfo.name === 'string') serverInfo.name = value.serverInfo.name
    if (typeof value.serverInfo.version === 'string') serverInfo.version = value.serverInfo.version
    result.serverInfo = serverInfo
  }
  if (typeof value.instructions === 'string') result.instructions = value.instructions
  return result
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([MCP_SEARCH_TOOL_NAME, MCP_LOAD_TOOL_NAME])

function assertToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new McpError('mcp_protocol', 'MCP tools/list returned an invalid tool name')
  }
  if (RESERVED_TOOL_NAMES.has(name)) {
    throw new McpError('mcp_protocol', 'MCP tools/list returned a reserved tool name')
  }
}

function parseToolPage(value: unknown): { tools: McpTool[]; nextCursor: string | undefined } {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new McpError('mcp_protocol', 'MCP tools/list result has no tools array')
  }
  const tools: McpTool[] = []
  for (const raw of value.tools) {
    if (!isRecord(raw) || typeof raw.name !== 'string') {
      throw new McpError('mcp_protocol', 'MCP tools/list returned a tool without a name')
    }
    assertToolName(raw.name)
    const tool: McpTool = { name: raw.name }
    if (typeof raw.title === 'string') tool.title = raw.title
    if (typeof raw.description === 'string') tool.description = raw.description
    if (raw.inputSchema !== undefined) tool.inputSchema = raw.inputSchema
    tools.push(tool)
  }
  const cursor = value.nextCursor
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new McpError('mcp_protocol', 'MCP tools/list returned a non-string cursor')
  }
  return {
    tools,
    nextCursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined,
  }
}

/**
 * One MCP server connection. The client is single-use: a failed handshake
 * kills the transport and leaves subsequent calls with `mcp_closed`.
 */
export class McpClient {
  private readonly server: McpServerConfig
  private readonly spawnPort: McpSpawn
  private readonly requestTimeoutMs: number
  private readonly maxMessageBytes: number
  private readonly maxToolPages: number
  private readonly allowedProtocolVersions: readonly string[]

  private transport: McpTransport | undefined
  private rpc: JsonRpcConnection | undefined
  private initializeResult: McpInitializeResult | undefined
  private connecting: Promise<McpInitializeResult> | undefined
  private closing: Promise<void> | undefined
  private closed = false

  constructor(options: McpClientOptions) {
    this.server = {
      ...options.server,
      args: [...(options.server.args ?? [])],
      env: { ...(options.server.env ?? {}) },
    }
    this.spawnPort = options.spawn ?? spawnMcpProcess
    this.requestTimeoutMs = positiveNumber(
      options.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.maxMessageBytes = positiveInteger(
      options.maxMessageBytes ?? DEFAULT_MCP_MAX_MESSAGE_BYTES,
      'maxMessageBytes',
    )
    this.maxToolPages = positiveInteger(options.maxToolPages ?? DEFAULT_MCP_MAX_TOOL_PAGES, 'maxToolPages')
    this.allowedProtocolVersions = [...(options.allowedProtocolVersions ?? [])]
  }

  get serverId(): string {
    return this.server.id
  }

  get negotiated(): McpInitializeResult | undefined {
    return this.initializeResult
  }

  async connect(): Promise<McpInitializeResult> {
    if (this.initializeResult !== undefined) return this.initializeResult
    if (this.closed) throw new McpError('mcp_closed', 'MCP client is closed')
    if (this.connecting !== undefined) return this.connecting
    this.connecting = this.start()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /** Fetches every page of `tools/list`, bounded by `maxToolPages`. */
  async listTools(): Promise<McpTool[]> {
    await this.connect()
    const rpc = this.requireRpc()
    const tools: McpTool[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < this.maxToolPages; page++) {
      const raw = await rpc.request('tools/list', cursor === undefined ? {} : { cursor })
      const parsed = parseToolPage(raw)
      for (const tool of parsed.tools) {
        if (seen.has(tool.name)) {
          throw new McpError('mcp_protocol', 'MCP tools/list returned a duplicate tool name')
        }
        seen.add(tool.name)
        tools.push(tool)
      }
      if (parsed.nextCursor === undefined) return tools
      cursor = parsed.nextCursor
    }
    throw new McpError(
      'mcp_pagination_limit',
      `MCP tools/list exceeded the ${this.maxToolPages}-page limit`,
    )
  }

  /**
   * Calls a tool with a JSON object of arguments. The result is returned
   * untouched, including `isError`; interpreting it is the caller's job.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: McpRequestOptions = {},
  ): Promise<McpToolCallResult> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new McpError('mcp_invalid_tool', 'MCP tool name must be a non-empty string')
    }
    if (!isPlainJsonObject(args)) {
      throw new McpError('mcp_invalid_arguments', 'MCP tool arguments must be a plain JSON object')
    }
    await this.connect()
    const raw = await this.requireRpc().request('tools/call', { name, arguments: args }, options)
    if (!isRecord(raw)) throw new McpError('mcp_protocol', 'MCP tools/call result is not an object')
    return raw
  }

  /** Fails closed when the connection was killed or never established. */
  private requireRpc(): JsonRpcConnection {
    if (this.rpc === undefined) throw new McpError('mcp_closed', 'MCP client is not connected')
    return this.rpc
  }

  /** Kills the process group and resolves only after the port's `exited` settles. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const rpc = this.rpc
    const transport = this.transport
    this.closed = true
    this.rpc = undefined
    this.transport = undefined
    this.initializeResult = undefined
    this.closing = (async () => {
      rpc?.close()
      if (transport === undefined) return
      try {
        transport.kill('SIGKILL')
      } catch {
        // The wrapper may already report exit.
      }
      try {
        await transport.exited
      } catch {
        // Cleanup must not surface a transport-specific error.
      }
    })()
    return this.closing
  }

  private buildTransportSpec(): McpTransportSpec {
    const server = this.server
    if (typeof server.id !== 'string' || server.id.length === 0) {
      throw new McpError('mcp_config', 'MCP server id must be a non-empty string')
    }
    return {
      command: server.command,
      args: [...(server.args ?? [])],
      cwd: server.cwd,
      env: { ...BASE_ENVIRONMENT, ...(server.env ?? {}) },
    }
  }

  private async start(): Promise<McpInitializeResult> {
    let transport: McpTransport
    try {
      const spec = this.buildTransportSpec()
      validateTransportSpec(spec)
      transport = this.spawnPort(spec)
    } catch (error) {
      throw error instanceof McpError
        ? error
        : new McpError('mcp_config', 'MCP server could not be started')
    }
    this.transport = transport
    const rpc = new JsonRpcConnection({
      stdin: transport.stdin,
      stdout: transport.stdout,
      maxMessageBytes: this.maxMessageBytes,
      requestTimeoutMs: this.requestTimeoutMs,
      kill: () => transport.kill('SIGKILL'),
    })
    this.rpc = rpc
    void transport.exited.then((status) => {
      const detail = status.signal !== null
        ? `signal ${status.signal}`
        : status.code !== null
          ? `code ${status.code}`
          : 'unknown status'
      rpc.transportClosed(`MCP server exited (${detail})`)
    }, () => {
      rpc.transportClosed('MCP server exit could not be observed')
    })

    try {
      const raw = await rpc.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: PRODUCT_NAME, version: MCP_CLIENT_VERSION },
      })
      const result = parseInitializeResult(raw)
      if (result.protocolVersion !== MCP_PROTOCOL_VERSION &&
          !this.allowedProtocolVersions.includes(result.protocolVersion)) {
        throw new McpError(
          'mcp_version_mismatch',
          `MCP server negotiated ${result.protocolVersion}; expected ${MCP_PROTOCOL_VERSION}`,
        )
      }
      rpc.notify('notifications/initialized')
      this.initializeResult = result
      return result
    } catch (error) {
      await this.close()
      throw error
    }
  }
}

export interface McpClientManagerOptions {
  /** Omitted policy means MCP is off. */
  projectPolicy?: McpProjectPolicy
  spawn?: McpSpawn
  requestTimeoutMs?: number
  maxMessageBytes?: number
  maxToolPages?: number
}

export interface McpServerTool extends McpTool {
  serverId: string
}

/**
 * Project-scoped MCP manager. `start()` is a no-op when the policy is off;
 * every tool operation then rejects with `mcp_disabled` before a spawn.
 */
export class McpClientManager {
  private readonly policyEnabled: boolean
  private readonly configs: readonly McpServerConfig[]
  private readonly spawnPort: McpSpawn
  private readonly requestTimeoutMs: number | undefined
  private readonly maxMessageBytes: number | undefined
  private readonly maxToolPages: number | undefined
  private readonly clients = new Map<string, McpClient>()

  private started = false
  private closed = false
  private startTask: Promise<void> | undefined
  private startError: McpError | undefined

  constructor(options: McpClientManagerOptions = {}) {
    const mcp = options.projectPolicy?.mcp
    this.policyEnabled = mcp?.enabled === true
    this.configs = [...(mcp?.servers ?? [])]
    this.spawnPort = options.spawn ?? spawnMcpProcess
    this.requestTimeoutMs = options.requestTimeoutMs
    this.maxMessageBytes = options.maxMessageBytes
    this.maxToolPages = options.maxToolPages
  }

  get enabled(): boolean {
    return this.policyEnabled
  }

  async start(): Promise<void> {
    if (!this.policyEnabled) return
    if (this.closed) throw new McpError('mcp_closed', 'MCP manager is closed')
    if (this.started) return
    if (this.startError !== undefined) throw this.startError
    if (this.startTask !== undefined) return this.startTask
    const task = this.startEnabled().catch((error: unknown) => {
      const failure = error instanceof McpError
        ? error
        : new McpError('mcp_config', 'MCP server could not be started')
      this.startError = failure
      throw failure
    })
    this.startTask = task
    try {
      await task
    } finally {
      this.startTask = undefined
    }
  }

  /**
   * Clears a cached start failure and tries every configured server again.
   * This is the only recovery path before `close()`.
   */
  async retry(): Promise<void> {
    if (!this.policyEnabled) return
    if (this.closed) throw new McpError('mcp_closed', 'MCP manager is closed')
    const starting = this.startTask
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // The failed start is cleared and retried below.
      }
    }
    this.startError = undefined
    await this.start()
  }

  async listTools(serverId: string): Promise<McpTool[]> {
    await this.ensureStarted()
    return this.clientFor(serverId).listTools()
  }

  /** Lists every enabled server's tools, tagging each with its server id. */
  async listAllTools(): Promise<McpServerTool[]> {
    await this.ensureStarted()
    const tools: McpServerTool[] = []
    for (const [serverId, client] of this.clients) {
      for (const tool of await client.listTools()) tools.push({ ...tool, serverId })
    }
    return tools
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown> = {},
    options: McpRequestOptions = {},
  ): Promise<McpToolCallResult> {
    await this.ensureStarted()
    return this.clientFor(serverId).callTool(name, args, options)
  }

  private async ensureStarted(): Promise<void> {
    if (!this.policyEnabled) throw new McpError('mcp_disabled', 'MCP is disabled by project policy')
    if (this.closed) throw new McpError('mcp_closed', 'MCP manager is closed')
    await this.start()
  }

  private clientFor(serverId: string): McpClient {
    const client = this.clients.get(serverId)
    if (client === undefined) throw new McpError('mcp_unknown_server', `Unknown MCP server: ${serverId}`)
    return client
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const starting = this.startTask
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // A failed start already closed its clients.
      }
    }
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.started = false
    this.startError = undefined
    await Promise.allSettled(clients.map(client => client.close()))
  }

  private async startEnabled(): Promise<void> {
    const seen = new Set<string>()
    const started: McpClient[] = []
    try {
      for (const config of this.configs) {
        if (config.enabled === false) continue
        if (this.closed) throw new McpError('mcp_closed', 'MCP manager is closed')
        if (typeof config.id !== 'string' || config.id.length === 0) {
          throw new McpError('mcp_config', 'MCP server id must be a non-empty string')
        }
        if (seen.has(config.id)) throw new McpError('mcp_config', `Duplicate MCP server id: ${config.id}`)
        seen.add(config.id)
        const client = new McpClient({
          server: config,
          spawn: this.spawnPort,
          requestTimeoutMs: this.requestTimeoutMs,
          maxMessageBytes: this.maxMessageBytes,
          maxToolPages: this.maxToolPages,
          allowedProtocolVersions: config.allowedProtocolVersions,
        })
        this.clients.set(config.id, client)
        started.push(client)
        await client.connect()
      }
      this.started = true
    } catch (error) {
      for (const client of started) {
        this.clients.delete(client.serverId)
        await client.close()
      }
      throw error
    }
  }
}
