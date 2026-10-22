// Original offline fixture. Executed only from an executable copy in a temporary directory.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'))
writeFileSync(join(root, 'adapter.pid'), String(process.pid))
const tape = config.tape
const trace = []
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const record = value => { trace.push(value); writeFileSync(join(root, 'trace.json'), JSON.stringify(trace)) }
const secret = config.secret ?? ''
const replace = value => {
  const text = JSON.stringify(value).replaceAll('$SECRET_A', secret.slice(0, Math.floor(secret.length / 2))).replaceAll('$SECRET_B', secret.slice(Math.floor(secret.length / 2)))
  return JSON.parse(text)
}
// A same-process-group descendant with no pipes of its own. The adapter exits on stdin EOF,
// so only a group signal can reach this child after the adapter process is gone.
const orphan = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(join(root, 'orphan.pid'), String(child.pid))
  process.stdin.on('end', () => process.exit(0))
}
if (process.argv.slice(2).join(' ') === 'auth status') {
  if (config.scenario === 'auth-descendant') {
    const marker = join(root, 'auth-descendant-write')
    const descendant = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'auth-ready'))},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1000);setInterval(()=>{},1000)`], { stdio: ['ignore', 'inherit', 'inherit'] })
    writeFileSync(join(root, 'auth-pids.json'), JSON.stringify({ parent: process.pid, descendant: descendant.pid }))
    setInterval(() => {}, 1000)
    await new Promise(() => {})
  }
  send(config.claudeAuth ?? { loggedIn: true, authMethod: 'claude.ai' })
  process.exit(0)
}
let vendorRead = false
if (config.readVendor) {
  // The dummy CLI may read its own throwaway login. The parent is forbidden to read it.
  vendorRead = readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8').length > 0
}
writeFileSync(join(root, 'environment.json'), JSON.stringify({
  names: Object.keys(process.env), vendorRead, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
  hasGeminiKey: !!process.env.GEMINI_API_KEY,
  openCodeConfig: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null,
  gooseProvider: process.env.GOOSE_PROVIDER, gooseModel: process.env.GOOSE_MODEL, gooseDisableKeyring: process.env.GOOSE_DISABLE_KEYRING,
  gooseMode: process.env.GOOSE_MODE,
}))
// LW lead scenarios (`config.lead`): an ACP agent that calls the node's HTTP MCP tool, can load a
// saved session and logs every protocol-visible fact to an append-only JSONL shared by all processes.
const lead = config.lead
const leadLog = (event, extra = {}) => lead && appendFileSync(join(root, 'lead-events.jsonl'), JSON.stringify({ pid: process.pid, event, ...extra }) + '\n')
const leadEvents = () => existsSync(join(root, 'lead-events.jsonl')) ? readFileSync(join(root, 'lead-events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
let mcp = null
let toolAbort = null
let leadFinish = null
const sessionUpdate = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
const usageFile = sessionId => join(root, `usage-${sessionId}.json`)
const leadUsage = sessionId => {
  // `usageByTurn[n]` is the CUMULATIVE usage reported by the n-th prompt this agent ever received (any process).
  const turn = leadEvents().filter(e => e.event === 'prompt').length - 1
  const scripted = (lead.usageByTurn ?? [])[turn]
  if (scripted) return { currency: 'USD', ...scripted }
  const base = existsSync(usageFile(sessionId)) ? JSON.parse(readFileSync(usageFile(sessionId), 'utf8')) : { inputTokens: 0, outputTokens: 0, amount: 0 }
  const per = lead.usagePerTurn ?? { inputTokens: 0, outputTokens: 0, amount: 0 }
  const next = { inputTokens: base.inputTokens + per.inputTokens, outputTokens: base.outputTokens + per.outputTokens, amount: base.amount + (per.amount ?? 0), currency: 'USD' }
  writeFileSync(usageFile(sessionId), JSON.stringify(next))
  return next
}
const reportUsage = sessionId => {
  const total = leadUsage(sessionId)
  if (lead.usagePerTurn?.amount !== undefined || lead.usageByTurn) sessionUpdate(sessionId, { sessionUpdate: 'usage_update', used: 1, size: 100, cost: { amount: total.amount, currency: total.currency } })
  return lead.usageOmitted ? undefined : { totalTokens: total.inputTokens + total.outputTokens, inputTokens: total.inputTokens, outputTokens: total.outputTokens }
}
async function mcpCall(body, signal) {
  const response = await fetch(mcp.url, { method: 'POST', signal, body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...Object.fromEntries(mcp.headers.map(h => [h.name, h.value])) } })
  return { status: response.status, body: response.status === 202 ? null : await response.json() }
}
async function leadPrompt(frame) {
  const sessionId = frame.params.sessionId
  const text = frame.params.prompt[0].text
  promptId = frame.id
  leadLog('prompt', { sessionId, text })
  const finish = (stopReason, extra = {}) => {
    leadFinish = null
    const usage = reportUsage(sessionId)
    reply({ id: promptId }, { stopReason, ...(usage ? { usage } : {}) })
    leadLog('turn_end', { sessionId, stopReason, ...extra })
  }
  leadFinish = finish
  if (lead.hang) return
  const calls = leadEvents().filter(e => e.event === 'tool_call').length
  const resumed = text.includes('guanxi.wake/v1')
  const brief = (lead.briefs ?? [])[calls]
  if (resumed && lead.noiseFirst) {
    // Bookkeeping updates are not model work and must not acknowledge the wake.
    sessionUpdate(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] })
    leadLog('noise_sent')
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  if (!(lead.silentTool && brief)) {
    sessionUpdate(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_REASONING_FIXTURE' } })
    sessionUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: resumed ? 'resumed lead turn' : 'planning delegation' } })
  }
  if (resumed && lead.crashOnResume) { leadLog('crash', { sessionId }); process.exit(31) }
  if (resumed && lead.resumeDelayMs) await new Promise(resolve => setTimeout(resolve, lead.resumeDelayMs))
  if (!brief || (resumed && !lead.redelegate)) { finish('end_turn', { resumed }); return }
  toolAbort = new AbortController()
  try {
    await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-lead', version: '1' } } }, toolAbort.signal)
    await mcpCall({ jsonrpc: '2.0', method: 'notifications/initialized' }, toolAbort.signal)
    const listed = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, toolAbort.signal)
    leadLog('tool_list', { tools: listed.body.result.tools.map(t => t.name) })
    leadLog('tool_call', { sessionId })
    const firstCall = mcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'guanxi_delegate', arguments: brief } }, toolAbort.signal)
    firstCall.catch(() => undefined)
    if (lead.doubleCall) {
      // Not tied to the cancel signal: the answer must arrive even while the first call is held.
      const second = await mcpCall({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'guanxi_delegate', arguments: brief } }, new AbortController().signal)
      leadLog('tool_second', { isError: second.body.result.isError === true, text: second.body.result.content[0].text })
    }
    const called = await firstCall
    // Only reached when the node answers: either a tool error or (unexpectedly) a result.
    leadLog('tool_answer', { status: called.status, isError: called.body?.result?.isError === true, text: called.body?.result?.content?.[0]?.text ?? null })
    sessionUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tool answered' } })
    finish('end_turn', { resumed })
  } catch (error) {
    if (!toolAbort.signal.aborted) { leadLog('tool_failed', { name: error?.name }); finish('end_turn') }
  }
}
let initialized = false
let authenticated = tape.adapter !== 'gemini-cli'
let model = 'default'
let promptId
let denials = 0
const reply = (frame, result) => send({ ...(tape.protocol === 'acp-v1' ? { jsonrpc: '2.0' } : {}), id: frame.id, result })
const promptDone = () => reply({ id: promptId }, tape.promptResult)
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  try {
    const frame = JSON.parse(line)
    record(frame)
    if (!frame.method) {
      if (typeof frame.id === 'string' && frame.id.startsWith('fixture-denial-')) {
        denials--
        if (!denials) promptDone()
      }
      if (frame.id === 'fixture-permission') {
        promptDone()
      }
      return
    }
    if (frame.method === 'initialize') {
      if (tape.protocol === 'acp-v1' && (frame.params.clientCapabilities.fs.readTextFile || frame.params.clientCapabilities.fs.writeTextFile || frame.params.clientCapabilities.terminal)) process.exit(13)
      if (tape.protocol === 'codex-app-server' && frame.params.capabilities.experimentalApi !== false) process.exit(14)
      initialized = true
      if (config.scenario === 'malformed') { process.stdout.write(`PRIVATE_REASONING_FIXTURE ${secret}\n`); return }
      if (config.scenario === 'invalid-object') { send({ privateReasoning: 'PRIVATE_REASONING_FIXTURE' }); return }
      if (config.scenario === 'unknown-response') send({ jsonrpc: '2.0', id: 'PRIVATE_REASONING_FIXTURE', result: {} })
      if (config.scenario === 'oversize') { process.stdout.write(JSON.stringify({ x: 'x'.repeat(16384) }) + '\n'); return }
      const init = structuredClone(tape.initialize)
      if (lead) init.agentCapabilities = { loadSession: lead.loadSession === true, mcpCapabilities: { http: lead.mcpHttp !== false } }
      leadLog('initialize', { loadSession: lead?.loadSession === true })
      if (config.scenario === 'wrong-version') {
        if (init.agentInfo) init.agentInfo.version = '999.0.0'
        else init.userAgent = 'codex_cli_rs/999.0.0'
      }
      reply(frame, init)
      return
    }
    if (!initialized) process.exit(15)
    if (frame.method === 'initialized') return
    if (frame.method === 'authenticate') {
      if (frame.params.methodId !== 'gemini-api-key' || !process.env.GEMINI_API_KEY) process.exit(16)
      authenticated = true; reply(frame, {}); return
    }
    if (frame.method === 'session/new') {
      if (lead) {
        mcp = frame.params.mcpServers.find(server => server.type === 'http') ?? null
        const sessionId = `lead-session-${leadEvents().filter(e => e.event === 'session_new').length + 1}`
        leadLog('session_new', { sessionId, servers: frame.params.mcpServers.length, authorized: !!mcp?.headers.some(h => h.name === 'Authorization' && /^Bearer [A-Za-z0-9_-]{32,}$/.test(h.value)) })
        reply(frame, { ...structuredClone(tape.newSession), sessionId }); return
      }
      if (!authenticated || frame.params.mcpServers.length !== 0) process.exit(17)
      reply(frame, tape.newSession); return
    }
    if (frame.method === 'session/load') {
      leadLog('session_load_requested', { sessionId: frame.params.sessionId })
      if (!lead || lead.loadSession !== true || lead.loadFails) { send({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'unknown session' } }); return }
      mcp = frame.params.mcpServers.find(server => server.type === 'http') ?? null
      leadLog('session_load', { sessionId: frame.params.sessionId, servers: frame.params.mcpServers.length })
      // History replay arrives before the response and must never become output of the new turn.
      sessionUpdate(frame.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'HISTORY-REPLAY-USER' } })
      sessionUpdate(frame.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HISTORY-REPLAY-ASSISTANT' } })
      reply(frame, { configOptions: structuredClone(tape.newSession.configOptions) }); return
    }
    if (frame.method === 'session/set_config_option') {
      model = frame.params.value
      const configOptions = structuredClone(tape.newSession.configOptions)
      configOptions[0].currentValue = model
      reply(frame, { configOptions }); return
    }
    if (frame.method === 'session/prompt' && lead) { void leadPrompt(frame); return }
    if (frame.method === 'session/prompt') {
      if (model !== (config.expectedModel ?? (tape.adapter === 'opencode' ? 'openai/model-fixture' : 'model-fixture'))) process.exit(18)
      promptId = frame.id
      if (config.scenario === 'orphan') { orphan(); return }
      if (config.scenario === 'hang') return
      if (config.scenario === 'crash') process.exit(19)
      for (const notification of tape.notifications) send(replace(notification))
      if (config.scenario === 'invalid-thought') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: { privateReasoning: 'PRIVATE_REASONING_FIXTURE' } } } } })
      if (config.scenario === 'capability-requests') {
        const methods = ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']
        denials = methods.length
        for (const [index, method] of methods.entries()) send({ jsonrpc: '2.0', id: `fixture-denial-${index}`, method, params: { sessionId: 'fixture-session', path: '/unavailable', content: 'no write', terminalId: 'no-terminal' } })
        return
      }
      if (config.scenario === 'permission') send({ jsonrpc: '2.0', id: 'fixture-permission', method: 'session/request_permission', params: {
        sessionId: 'fixture-session', toolCall: { toolCallId: 'fixture-tool', title: 'Denied shell', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      } })
      else promptDone()
      return
    }
    if (frame.method === 'account/read') { reply(frame, config.account ?? tape.account); return }
    if (frame.method === 'account/rateLimits/read') { reply(frame, tape.rateLimits); return }
    if (frame.method === 'account/login/start') {
      if (frame.params.type !== 'chatgpt') process.exit(20)
      reply(frame, { type: 'chatgpt', loginId: 'fixture-login', authUrl: config.authUrl ?? 'https://auth.openai.com/authorize?fixture=true' })
      if (config.scenario === 'login-hang') return
      send({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true, error: null } })
      return
    }
    if (frame.method === 'thread/start') {
      if (frame.params.sandbox !== 'read-only' || frame.params.approvalPolicy !== 'on-request') process.exit(21)
      reply(frame, { thread: { id: 'fixture-thread' } }); return
    }
    if (frame.method === 'turn/start') {
      if (config.scenario === 'orphan') { orphan(); return }
      if (config.scenario === 'hang') return
      if (config.scenario === 'hang-after-start') { reply(frame, { turn: { id: 'fixture-turn', status: 'inProgress' } }); return }
      if (config.scenario === 'crash') process.exit(22)
      if (config.scenario === 'after-start-response') {
        reply(frame, { turn: { id: 'fixture-turn', status: 'inProgress' } })
        setTimeout(() => { for (const notification of tape.notifications) send(replace(notification)) }, 10)
        return
      }
      for (const notification of tape.notifications) send(replace(notification))
      reply(frame, { turn: { id: 'fixture-turn', status: 'inProgress' } }); return
    }
    if (frame.method === 'session/cancel') {
      if (lead) { leadLog('cancel', { sessionId: frame.params.sessionId }); toolAbort?.abort(); leadFinish?.('cancelled'); leadFinish = null }
      return
    }
    if (frame.method === 'turn/interrupt') { reply(frame, {}); return }
    send({ id: frame.id, error: { code: -32601, message: 'Fixture method unavailable' } })
  } catch { process.exit(23) }
})
// Stderr is intentionally sensitive, and must never be forwarded by Guanxi.
process.stderr.write(`PRIVATE_REASONING_FIXTURE ${secret}`)
