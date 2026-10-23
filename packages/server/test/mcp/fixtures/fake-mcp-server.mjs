#!/usr/bin/env node
/**
 * Tiny stdio MCP server used only by packages/server/test/mcp/client.test.ts.
 *
 * Modes: normal, noisy, wrong-protocol, malformed, oversize, loop.
 * It logs every incoming message as one JSON line when `--log <path>` is set.
 *
 * The planted stderr string is a sentinel, not a credential. It exists to
 * prove that the client never copies stderr into a result or an error.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const PLANTED_STDERR_SENTINEL = 'fixture-stderr-sentinel-not-a-real-credential-9c41'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= process.argv.length) return fallback
  return process.argv[index + 1]
}

const mode = option('mode', 'normal')
const logPath = option('log', null)
const toolName = option('tool-name', null)
const slowTimers = new Map()
let loopPage = 0

function log(message) {
  if (logPath === null) return
  try {
    appendFileSync(logPath, `${JSON.stringify(message)}\n`)
  } catch {
    // Logging is test observability only; protocol handling continues.
  }
}

function write(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The client may have killed the process after an oversize frame.
  }
}

if (mode === 'grandchild' && process.platform !== 'win32') {
  // Inherits this process's stdout, so `close` waits for the grandchild too.
  const grandchild = spawn('/bin/sleep', ['30'], { stdio: 'inherit' })
  log({ grandchildPid: grandchild.pid ?? null })
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value })
}

function failure(id, code, message, data) {
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

if (mode === 'noisy') {
  process.stderr.write(`[fake-mcp] planted token=${PLANTED_STDERR_SENTINEL}\n`)
}

const pageOne = [
  {
    name: 'echo',
    title: 'Echo arguments',
    description: 'Echo the JSON arguments back as structured content.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        delayMs: { type: 'number' },
      },
    },
  },
  {
    name: 'slow',
    description: 'Wait until the request times out or is cancelled.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const pageTwo = [
  {
    name: 'inspect',
    description: 'Report the child working directory and selected environment values.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fail',
    description: 'Return a JSON-RPC error object.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soft',
    description: 'Return an isError tool result without a JSON-RPC error.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function listTools(id, params) {
  if (mode === 'malformed') {
    process.stdout.write('{this is not json}\n')
    return
  }
  if (mode === 'oversize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { blob: 'x'.repeat(2 * 1024 * 1024) },
    })}\n`)
    return
  }
  if (mode === 'loop') {
    // Unique names keep the pagination test focused on the page limit.
    result(id, { tools: [{ ...pageOne[0], name: `loop_${loopPage++}` }], nextCursor: 'again' })
    return
  }
  if (mode === 'duplicate-tools') {
    result(id, { tools: [pageOne[0], pageOne[0]] })
    return
  }
  const cursor = params.cursor
  if (typeof cursor === 'string' && cursor.length > 0) {
    if (cursor === 'page-2') result(id, { tools: pageTwo })
    else failure(id, -32602, `unknown cursor: ${cursor}`)
    return
  }
  const tools = toolName === null
    ? pageOne
    : pageOne.map((tool, index) => index === 0 ? { ...tool, name: toolName } : tool)
  result(id, { tools, nextCursor: 'page-2' })
}

function callTool(id, params) {
  const name = params.name
  const args = params.arguments
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    failure(id, -32602, 'arguments must be an object')
    return
  }
  if (name === 'echo') {
    const delay = typeof args.delayMs === 'number' && Number.isFinite(args.delayMs)
      ? Math.max(0, Math.min(1000, args.delayMs))
      : 0
    const respond = () => result(id, {
      content: [{ type: 'text', text: JSON.stringify(args) }],
      structuredContent: args,
    })
    if (delay === 0) respond()
    else setTimeout(respond, delay)
    return
  }
  if (name === 'slow') {
    const timer = setTimeout(() => {
      slowTimers.delete(id)
      result(id, {
        content: [{ type: 'text', text: 'slow completed' }],
        structuredContent: { completed: true },
      })
    }, 10_000)
    slowTimers.set(id, timer)
    return
  }
  if (name === 'inspect') {
    result(id, {
      content: [{ type: 'text', text: 'inspect' }],
      structuredContent: {
        cwd: process.cwd(),
        leak: process.env.MCP_P1C_LEAK ?? null,
        allowed: process.env.MCP_P1C_ALLOWED ?? null,
      },
    })
    return
  }
  if (name === 'fail') {
    failure(id, -32000, 'fixture failure', { kind: 'expected' })
    return
  }
  if (name === 'soft') {
    result(id, {
      content: [{ type: 'text', text: 'soft failure' }],
      structuredContent: { ok: false },
      isError: true,
    })
    return
  }
  failure(id, -32602, `unknown tool: ${String(name)}`)
}

function handleNotification(message) {
  if (message.method !== 'notifications/cancelled') return
  const requestId = message.params?.requestId
  const timer = slowTimers.get(requestId)
  if (timer !== undefined) {
    clearTimeout(timer)
    slowTimers.delete(requestId)
  }
}

function handleRequest(message) {
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: mode === 'wrong-protocol'
        ? '2025-01-01'
        : (typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : '2026-07-28'),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake-mcp-server', version: '0.0.1' },
    })
    return
  }
  if (message.method === 'tools/list') {
    listTools(message.id, message.params ?? {})
    return
  }
  if (message.method === 'tools/call') {
    callTool(message.id, message.params ?? {})
    return
  }
  failure(message.id, -32601, `method not found: ${message.method}`)
}

function handle(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return
  log(message)
  if (typeof message.method !== 'string') return
  if (message.id === undefined || message.id === null) {
    handleNotification(message)
    return
  }
  handleRequest(message)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim().length > 0) {
      try {
        handle(JSON.parse(line))
      } catch {
        // A malformed client frame is outside the behaviours under test.
      }
    }
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdout.on('error', () => {})
