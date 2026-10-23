import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PRODUCT_NAME } from '@guanxi/contract'
import {
  McpClient,
  McpClientManager,
  spawnMcpProcess,
  type McpClientManagerOptions,
} from '../../src/mcp/client.ts'
import {
  DEFAULT_MCP_MAX_MESSAGE_BYTES,
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpErrorCode,
  type McpServerConfig,
  type McpSpawn,
  type McpTransport,
  type McpTransportSpec,
} from '../../src/mcp/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures/fake-mcp-server.mjs')
// A sentinel, not a credential: the fixture writes it to stderr only.
const PLANTED_STDERR_SENTINEL = 'fixture-stderr-sentinel-not-a-real-credential-9c41'

type TestContext = { after(callback: () => unknown): void }

interface HarnessOptions {
  mode?: string
  manager?: Partial<Omit<McpClientManagerOptions, 'projectPolicy' | 'spawn'>>
  server?: Partial<McpServerConfig>
}

interface Harness {
  root: string
  log: string
  manager: McpClientManager
  calls: McpTransportSpec[]
  transports: McpTransport[]
}

async function createHarness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p1c-mcp-')))
  const log = join(root, 'server.log')
  const mode = options.mode ?? 'normal'
  const calls: McpTransportSpec[] = []
  const transports: McpTransport[] = []
  const spawnPort: McpSpawn = (spec) => {
    calls.push(spec)
    const transport = spawnMcpProcess(spec)
    transports.push(transport)
    return transport
  }
  const server: McpServerConfig = {
    id: 'fake',
    command: process.execPath,
    cwd: root,
    args: [FIXTURE, '--mode', mode, '--log', log],
    ...options.server,
  }
  const manager = new McpClientManager({
    projectPolicy: { mcp: { enabled: true, servers: [server] } },
    spawn: spawnPort,
    requestTimeoutMs: 5_000,
    ...options.manager,
  })
  t.after(async () => {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, log, manager, calls, transports }
}

async function messages(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, 'utf8')
    return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitForMessages(
  path: string,
  predicate: (list: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 3_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = await messages(path)
    if (predicate(list)) return list
    if (Date.now() >= deadline) throw new Error('timed out waiting for fake MCP server log')
    await delay(10)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await delay(10)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
    timer.unref()
    promise.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function expectCode(promise: Promise<unknown>, code: McpErrorCode): Promise<McpError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof McpError, `expected McpError ${code}, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected rejection with ${code}`)
}

function paramsOf(message: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(message, 'missing log message')
  const params = message.params
  assert.ok(typeof params === 'object' && params !== null && !Array.isArray(params), 'missing params')
  return params as Record<string, unknown>
}

it('completes the pinned handshake before listing every tool page', async (t) => {
  const harness = await createHarness(t)
  const tools = await harness.manager.listTools('fake')
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['echo', 'slow', 'inspect', 'fail', 'soft'],
  )

  const log = await messages(harness.log)
  assert.deepEqual(
    log.map(message => message.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'],
  )
  const initialize = log[0]
  const initParams = paramsOf(initialize)
  assert.equal(initParams.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.deepEqual(initParams.capabilities, {})
  const clientInfo = initParams.clientInfo
  assert.ok(typeof clientInfo === 'object' && clientInfo !== null)
  assert.equal((clientInfo as Record<string, unknown>).name, PRODUCT_NAME)

  const pages = log.filter(message => message.method === 'tools/list')
  assert.equal(pages.length, 2)
  assert.deepEqual(paramsOf(pages[0]), {})
  assert.equal(paramsOf(pages[1]).cursor, 'page-2')
  assert.equal(harness.calls.length, 1)
})

it('returns structured tool results and JSON-RPC errors without interpretation', async (t) => {
  const harness = await createHarness(t)
  const echo = await harness.manager.callTool('fake', 'echo', { message: 'hello', nested: { ok: true } })
  assert.deepEqual(echo.structuredContent, { message: 'hello', nested: { ok: true } })
  assert.equal(echo.isError, undefined)

  const soft = await harness.manager.callTool('fake', 'soft')
  assert.equal(soft.isError, true)
  assert.deepEqual(soft.structuredContent, { ok: false })

  const rpcError = await expectCode(harness.manager.callTool('fake', 'fail'), 'mcp_rpc_error')
  assert.equal(rpcError.rpcCode, -32000)
  assert.deepEqual(rpcError.data, { kind: 'expected' })
  assert.match(rpcError.message, /fixture failure/)

  const callsBefore = (await messages(harness.log)).filter(message => message.method === 'tools/call').length
  await expectCode(
    harness.manager.callTool('fake', 'echo', [] as unknown as Record<string, unknown>),
    'mcp_invalid_arguments',
  )
  await expectCode(harness.manager.callTool('fake', '', {}), 'mcp_invalid_tool')
  const callsAfter = (await messages(harness.log)).filter(message => message.method === 'tools/call').length
  assert.equal(callsAfter, callsBefore, 'invalid arguments must not reach the server')

  const [first, second] = await Promise.all([
    harness.manager.callTool('fake', 'echo', { message: 'first', delayMs: 120 }),
    harness.manager.callTool('fake', 'echo', { message: 'second', delayMs: 10 }),
  ])
  assert.deepEqual(first.structuredContent, { message: 'first', delayMs: 120 })
  assert.deepEqual(second.structuredContent, { message: 'second', delayMs: 10 })
})

it('sends notifications/cancelled and rejects mcp_timeout on a per-request timeout', async (t) => {
  const harness = await createHarness(t)
  const error = await expectCode(
    harness.manager.callTool('fake', 'slow', {}, { timeoutMs: 150 }),
    'mcp_timeout',
  )
  assert.match(error.message, /timed out/)
  const log = await waitForMessages(
    harness.log,
    list => list.some(message => message.method === 'notifications/cancelled'),
  )
  const cancelled = log.find(message => message.method === 'notifications/cancelled')
  const params = paramsOf(cancelled)
  const call = log.find(message => message.method === 'tools/call')
  assert.ok(call, 'expected the timed-out call in the log')
  assert.equal(params.requestId, call.id)
  assert.equal(params.reason, 'timeout')
  assert.equal(typeof params.requestId, 'number')

  const after = await harness.manager.callTool('fake', 'echo', { message: 'still alive' })
  assert.deepEqual(after.structuredContent, { message: 'still alive' })
})

it('sends notifications/cancelled and rejects mcp_aborted on abort', async (t) => {
  const harness = await createHarness(t)
  const controller = new AbortController()
  const pending = harness.manager.callTool('fake', 'slow', {}, {
    signal: controller.signal,
    timeoutMs: 5_000,
  })
  await waitForMessages(harness.log, list => list.some(message => message.method === 'tools/call'))
  controller.abort()
  await expectCode(pending, 'mcp_aborted')

  const log = await waitForMessages(
    harness.log,
    list => list.some(message => message.method === 'notifications/cancelled'),
  )
  const cancelled = log.find(message => message.method === 'notifications/cancelled')
  const call = log.find(message => message.method === 'tools/call')
  assert.ok(call, 'expected the aborted call in the log')
  assert.equal(paramsOf(cancelled).requestId, call.id)
  assert.equal(paramsOf(cancelled).reason, 'aborted')
})

it('fails malformed JSON with mcp_protocol and kills the server', async (t) => {
  const harness = await createHarness(t, { mode: 'malformed' })
  await expectCode(harness.manager.listTools('fake'), 'mcp_protocol')
  const transport = harness.transports[0]
  assert.ok(transport, 'expected one transport')
  await withTimeout(transport.exited, 2_000, 'malformed server exit')
})

it('kills an oversize message and fails mcp_message_too_large', async (t) => {
  const harness = await createHarness(t, {
    mode: 'oversize',
    manager: { maxMessageBytes: 1024 },
  })
  await expectCode(harness.manager.listTools('fake'), 'mcp_message_too_large')
  const transport = harness.transports[0]
  assert.ok(transport, 'expected one transport')
  await withTimeout(transport.exited, 2_000, 'oversize server exit')
  assert.equal(DEFAULT_MCP_MAX_MESSAGE_BYTES, 4 * 1024 * 1024)
})

it('refuses a different protocol version unless it is explicitly allowlisted', async (t) => {
  const denied = await createHarness(t, { mode: 'wrong-protocol' })
  await expectCode(denied.manager.listTools('fake'), 'mcp_version_mismatch')
  const deniedLog = await messages(denied.log)
  assert.equal(deniedLog.some(message => message.method === 'notifications/initialized'), false)
  const deniedTransport = denied.transports[0]
  assert.ok(deniedTransport, 'expected one transport')
  await withTimeout(deniedTransport.exited, 2_000, 'mismatch server exit')

  const allowed = await createHarness(t, {
    mode: 'wrong-protocol',
    manager: { allowedProtocolVersions: ['2025-01-01'] },
  })
  const tools = await allowed.manager.listTools('fake')
  assert.equal(tools.length, 5)
  const allowedLog = await waitForMessages(
    allowed.log,
    list => list.some(message => message.method === 'notifications/initialized'),
  )
  assert.equal(allowedLog[0]?.method, 'initialize')
})

it('never surfaces stderr noise containing the planted sentinel', async (t) => {
  const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'p1c-mcp-probe-')))
  const probe = spawn(process.execPath, [FIXTURE, '--mode', 'noisy'], {
    cwd: probeRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(async () => {
    try {
      probe.kill('SIGKILL')
    } catch {
      // Already exited.
    }
    await rm(probeRoot, { recursive: true, force: true })
  })
  const stderr = probe.stderr
  assert.ok(stderr, 'expected a piped stderr for the fixture probe')
  stderr.setEncoding('utf8')
  let captured = ''
  stderr.on('data', (chunk: string) => { captured += chunk })
  const closed = once(probe, 'close')
  await waitFor(() => captured.includes(PLANTED_STDERR_SENTINEL))
  assert.ok(captured.includes(PLANTED_STDERR_SENTINEL))
  probe.kill('SIGKILL')
  await withTimeout(closed.then(() => undefined), 2_000, 'fixture probe exit')

  const harness = await createHarness(t, { mode: 'noisy' })
  const tools = await harness.manager.listTools('fake')
  const echo = await harness.manager.callTool('fake', 'echo', { message: 'stderr check' })
  const timeout = await expectCode(
    harness.manager.callTool('fake', 'slow', {}, { timeoutMs: 120 }),
    'mcp_timeout',
  )
  const surfaces = [
    JSON.stringify(tools),
    JSON.stringify(echo),
    timeout.message,
    String(timeout.stack ?? ''),
    JSON.stringify(timeout.data ?? null),
  ].join('\n')
  assert.equal(surfaces.includes(PLANTED_STDERR_SENTINEL), false)
})

it('starts no process and refuses every tool operation when disabled', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p1c-mcp-disabled-')))
  const calls: McpTransportSpec[] = []
  const spawnPort: McpSpawn = (spec) => {
    calls.push(spec)
    return spawnMcpProcess(spec)
  }
  const server: McpServerConfig = {
    id: 'fake',
    command: process.execPath,
    cwd: root,
    args: [FIXTURE],
  }
  const disabled = new McpClientManager({
    projectPolicy: { mcp: { enabled: false, servers: [server] } },
    spawn: spawnPort,
  })
  const defaulted = new McpClientManager({
    projectPolicy: { mcp: { servers: [server] } },
    spawn: spawnPort,
  })
  const noPolicy = new McpClientManager({ spawn: spawnPort })
  t.after(async () => {
    await disabled.close()
    await defaulted.close()
    await noPolicy.close()
    await rm(root, { recursive: true, force: true })
  })

  await disabled.start()
  await defaulted.start()
  await noPolicy.start()
  assert.equal(disabled.enabled, false)
  assert.equal(defaulted.enabled, false)
  assert.equal(noPolicy.enabled, false)
  assert.equal(calls.length, 0)
  await expectCode(disabled.listTools('fake'), 'mcp_disabled')
  await expectCode(disabled.listAllTools(), 'mcp_disabled')
  await expectCode(disabled.callTool('fake', 'echo', {}), 'mcp_disabled')
  await expectCode(defaulted.listAllTools(), 'mcp_disabled')
  await expectCode(noPolicy.listAllTools(), 'mcp_disabled')
  assert.equal(calls.length, 0)
})

it('rejects invalid client limits before spawning', () => {
  let calls = 0
  const spawnPort: McpSpawn = () => {
    calls++
    throw new Error('must not spawn')
  }
  const server: McpServerConfig = { id: 'limits', command: process.execPath, cwd: process.cwd() }
  assert.throws(() => new McpClient({ server, spawn: spawnPort, maxMessageBytes: 0 }), TypeError)
  assert.throws(() => new McpClient({ server, spawn: spawnPort, requestTimeoutMs: Number.NaN }), TypeError)
  assert.throws(() => new McpClient({ server, spawn: spawnPort, maxToolPages: 1.5 }), TypeError)
  assert.equal(calls, 0)
})

it('requires an absolute command and an explicit minimal environment', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p1c-mcp-env-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  let invalidSpawns = 0
  const invalid = new McpClient({
    server: { id: 'bad', command: 'node', cwd: root },
    spawn: () => {
      invalidSpawns++
      throw new Error('must not spawn')
    },
  })
  t.after(() => invalid.close())
  await expectCode(invalid.connect(), 'mcp_config')
  assert.equal(invalidSpawns, 0)

  const harness = await createHarness(t, { server: { env: { MCP_P1C_ALLOWED: 'visible' } } })
  process.env.MCP_P1C_LEAK = 'must-not-leak'
  t.after(() => { delete process.env.MCP_P1C_LEAK })
  const inspected = await harness.manager.callTool('fake', 'inspect')
  assert.deepEqual(inspected.structuredContent, {
    cwd: harness.root,
    leak: null,
    allowed: 'visible',
  })
  const spec = harness.calls[0]
  assert.ok(spec, 'expected one spawn spec')
  assert.equal(spec.command, process.execPath)
  assert.equal(spec.env.MCP_P1C_LEAK, undefined)
  assert.equal(spec.env.MCP_P1C_ALLOWED, 'visible')
  assert.equal(typeof spec.env.PATH, 'string')
})

it('bounds tools/list pagination', async (t) => {
  const harness = await createHarness(t, { mode: 'loop', manager: { maxToolPages: 2 } })
  await expectCode(harness.manager.listTools('fake'), 'mcp_pagination_limit')
  const log = await waitForMessages(
    harness.log,
    list => list.filter(message => message.method === 'tools/list').length === 2,
  )
  assert.equal(log.filter(message => message.method === 'tools/list').length, 2)
})

it('close kills the child and waits for its exited promise', async (t) => {
  const harness = await createHarness(t)
  await harness.manager.listTools('fake')
  const transport = harness.transports[0]
  assert.ok(transport, 'expected one transport')
  await harness.manager.close()
  const status = await withTimeout(transport.exited, 2_000, 'server exit')
  assert.ok(status.signal === 'SIGKILL' || status.code !== null)
  await harness.manager.close()
  assert.equal(harness.calls.length, 1)
})
