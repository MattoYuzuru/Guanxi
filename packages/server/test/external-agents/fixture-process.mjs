// Original offline fixture. Executed only from an executable copy in a temporary directory.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

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
}))
let initialized = false
let authenticated = tape.adapter !== 'gemini-cli'
let model = 'default'
let promptId
const reply = (frame, result) => send({ ...(tape.protocol === 'acp-v1' ? { jsonrpc: '2.0' } : {}), id: frame.id, result })
const promptDone = () => reply({ id: promptId }, tape.promptResult)
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  try {
    const frame = JSON.parse(line)
    record(frame)
    if (!frame.method) {
      if (frame.id === 'fixture-permission') {
        if (frame.result?.outcome?.outcome !== 'cancelled') process.exit(12)
        promptDone()
      }
      return
    }
    if (frame.method === 'initialize') {
      if (tape.protocol === 'acp-v1' && (frame.params.clientCapabilities.fs.readTextFile || frame.params.clientCapabilities.fs.writeTextFile || frame.params.clientCapabilities.terminal)) process.exit(13)
      if (tape.protocol === 'codex-app-server' && frame.params.capabilities.experimentalApi !== false) process.exit(14)
      initialized = true
      if (config.scenario === 'malformed') { process.stdout.write(`PRIVATE_REASONING_FIXTURE ${secret}\n`); return }
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
      if (model !== (config.expectedModel ?? 'model-fixture')) process.exit(18)
      promptId = frame.id
      if (config.scenario === 'hang') return
      if (config.scenario === 'crash') process.exit(19)
      for (const notification of tape.notifications) send(replace(notification))
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
      send({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true, error: null } })
      return
    }
    if (frame.method === 'thread/start') {
      if (frame.params.sandbox !== 'read-only' || frame.params.approvalPolicy !== 'never') process.exit(21)
      reply(frame, { thread: { id: 'fixture-thread' } }); return
    }
    if (frame.method === 'turn/start') {
      if (config.scenario === 'hang') return
      if (config.scenario === 'crash') process.exit(22)
      for (const notification of tape.notifications) send(replace(notification))
      reply(frame, { turn: { id: 'fixture-turn', status: 'inProgress' } }); return
    }
    send({ id: frame.id, error: { code: -32601, message: 'Fixture method unavailable' } })
  } catch { process.exit(23) }
})
// Stderr is intentionally sensitive, and must never be forwarded by Guanxi.
process.stderr.write(`PRIVATE_REASONING_FIXTURE ${secret}`)
