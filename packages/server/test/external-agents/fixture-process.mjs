// Original offline fixture. Executed only from an executable copy in a temporary directory.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'))
const tape = config.tape
const trace = []
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const record = value => { trace.push(value); writeFileSync(join(root, 'trace.json'), JSON.stringify(trace)) }
const secret = config.secret ?? ''
const replace = value => {
  const text = JSON.stringify(value).replaceAll('$SECRET_A', secret.slice(0, Math.floor(secret.length / 2))).replaceAll('$SECRET_B', secret.slice(Math.floor(secret.length / 2)))
  return JSON.parse(text)
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
      if (!authenticated || frame.params.mcpServers.length !== 0) process.exit(17)
      reply(frame, tape.newSession); return
    }
    if (frame.method === 'session/set_config_option') {
      model = frame.params.value
      const configOptions = structuredClone(tape.newSession.configOptions)
      configOptions[0].currentValue = model
      reply(frame, { configOptions }); return
    }
    if (frame.method === 'session/prompt') {
      if (model !== (config.expectedModel ?? (tape.adapter === 'opencode' ? 'openai/model-fixture' : 'model-fixture'))) process.exit(18)
      promptId = frame.id
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
    if (frame.method === 'session/cancel') return
    if (frame.method === 'turn/interrupt') { reply(frame, {}); return }
    send({ id: frame.id, error: { code: -32601, message: 'Fixture method unavailable' } })
  } catch { process.exit(23) }
})
// Stderr is intentionally sensitive, and must never be forwarded by Guanxi.
process.stderr.write(`PRIVATE_REASONING_FIXTURE ${secret}`)
