/**
 * Shared MCP client types.
 *
 * MCP servers are T2 trust (ADR-0022 §9): they must not run in-process or
 * without the K4 sandbox. This module only defines the transport and wire
 * shapes; it makes no sandbox claim.
 */
import type { Readable, Writable } from 'node:stream'

/** Pinned MCP specification version (ADR-0022 §9). */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

/** Client implementation version reported in `initialize`. */
export const MCP_CLIENT_VERSION = '0.1.0'

/** Default cap for one newline-delimited JSON-RPC message. */
export const DEFAULT_MCP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/** Default per-request timeout. */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000

/** Default bound on `tools/list` pages. */
export const DEFAULT_MCP_MAX_TOOL_PAGES = 100

/**
 * Stable machine-readable failure codes. Callers should branch on `code`,
 * never on the human-readable message.
 */
export type McpErrorCode =
  | 'mcp_disabled'
  | 'mcp_config'
  | 'mcp_protocol'
  | 'mcp_message_too_large'
  | 'mcp_timeout'
  | 'mcp_aborted'
  | 'mcp_version_mismatch'
  | 'mcp_rpc_error'
  | 'mcp_transport'
  | 'mcp_closed'
  | 'mcp_invalid_arguments'
  | 'mcp_invalid_tool'
  | 'mcp_pagination_limit'
  | 'mcp_unknown_server'

export interface McpErrorOptions {
  /** JSON-RPC error code returned by the server, if any. */
  rpcCode?: number
}

/**
 * Error type for every MCP client failure. Never carries stderr or raw
 * server error data.
 *
 * SECURITY: `message` can contain a truncated, untrusted string supplied by
 * an MCP server. Do not render it as trusted text or execute it.
 */
export class McpError extends Error {
  readonly code: McpErrorCode
  readonly rpcCode: number | undefined

  constructor(code: McpErrorCode, message: string, options: McpErrorOptions = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.rpcCode = options.rpcCode
  }
}

export function isMcpError(error: unknown, code?: McpErrorCode): error is McpError {
  return error instanceof McpError && (code === undefined || error.code === code)
}

export interface McpProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * Transport port. The default implementation wraps `child_process.spawn`;
 * K4 will replace it with a sandboxed wrapper that exposes the same shape.
 * stdout is newline-delimited JSON-RPC. stderr is deliberately absent: the
 * client cannot log it, and the default transport discards it.
 */
export interface McpTransport {
  stdin: Writable
  stdout: Readable
  kill(signal?: NodeJS.Signals): void
  exited: Promise<McpProcessExit>
}

export interface McpTransportSpec {
  /** Absolute executable path. No shell is involved. */
  command: string
  args: string[]
  /** Absolute working directory supplied by project policy. */
  cwd: string
  /** Explicit environment; never the whole parent environment. */
  env: Record<string, string>
}

export type McpSpawn = (spec: McpTransportSpec) => McpTransport

export interface McpServerConfig {
  id: string
  command: string
  args?: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
  /** Protocol versions this server may negotiate in addition to the pinned one. */
  allowedProtocolVersions?: readonly string[]
  /** Individual switch inside an enabled project policy. */
  enabled?: boolean
}

export interface McpProjectPolicy {
  mcp?: {
    /** Off unless explicitly true. */
    enabled?: boolean
    servers?: readonly McpServerConfig[]
  }
}

export interface McpServerInfo {
  name?: string
  version?: string
}

export interface McpInitializeResult {
  protocolVersion: string
  capabilities: Record<string, unknown>
  serverInfo?: McpServerInfo
  instructions?: string
}

/**
 * Tool shape kept from `tools/list`. Unknown server fields are dropped, so a
 * server cannot smuggle arbitrary data past the context budget.
 */
export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

/**
 * `tools/call` result. The client returns it untouched: `isError`, content
 * blocks and `structuredContent` are the server's data, not client state.
 */
export interface McpToolCallResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
  [key: string]: unknown
}

export interface McpRequestOptions {
  /** Overrides the client default; must be a finite positive number. */
  timeoutMs?: number
  signal?: AbortSignal
}
