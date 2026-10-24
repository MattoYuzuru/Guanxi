import { readFileSync } from 'node:fs'
import { ZodError } from 'zod'
import { resolve } from 'node:path'
import { MS1_LIVE_STOP_BOUND_MS, start, type StartOptions } from '../index.ts'
import { EXTERNAL_AGENT_SERVICE, type ExternalAgentService } from '../external-agents/plugin.ts'
import { LOCAL_ACCOUNT_ID } from '../http/local-guard.ts'
import { LEAD_SERVICE, type LeadHostService } from '../leads/plugin.ts'
import { describeConfigError, type Check } from './checks.ts'
import { doctor } from './doctor.ts'
import { initNode } from './identity.ts'
import { loadMs1LiveConfig, MS1_LIVE_CONFIG_ENV, Ms1LiveError, type Ms1LiveSettings } from './config.ts'
import { preflight } from './preflight.ts'

export const USAGE = `ms1-live: pair a Guanxi home node with an executor node for the MS1 run

  ms1-live init --role home|executor --dir DIR [--account ID] [--id NODE_ID] [--port N] [--federation-port N]
                [--peer-federation-port N] [--model NAME] [--llama-url URL] [--peer-file FILE] [--json]
  ms1-live doctor    [--config FILE] [--data-dir DIR] [--json]
  ms1-live preflight [--config FILE] [--completion] [--json]
  ms1-live start     [--config FILE] [--port N] [--data-dir DIR] [--lead-prompt-file FILE --project ID] [--json]

The configuration file is --config, else $${MS1_LIVE_CONFIG_ENV}. Exit codes: 0 ok; 1 a check or the run failed (doctor also
reports an invalid configuration this way, because that is what it diagnoses); 2 usage, or a configuration file that preflight or
start cannot load. With --json, stdout is one JSON document (start: one JSON object per line). --port is the owner API port;
--federation-port is the one port to forward over ssh. No command prints a key; configuration names key files by path.`

export interface Io { out(text: string): void; err(text: string): void }
const stdio: Io = { out: text => { process.stdout.write(text + '\n') }, err: text => { process.stderr.write(text + '\n') } }

class Usage extends Error {}
interface Parsed { flags: Map<string, string | true>; positional: string[] }
const VALUE_FLAGS = new Set(['role', 'dir', 'account', 'id', 'port', 'federation-port', 'peer-federation-port', 'model', 'llama-url', 'peer-file', 'config', 'data-dir', 'lead-prompt-file', 'project'])
const BOOLEAN_FLAGS = new Set(['json', 'completion', 'help'])
function parse(args: readonly string[]): Parsed {
  const flags = new Map<string, string | true>(), positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const name = arg.slice(2)
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, true)
    else if (VALUE_FLAGS.has(name)) {
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) throw new Usage(`--${name} needs a value`)
      flags.set(name, value)
    } else throw new Usage(`unknown option --${name}`)
  }
  return { flags, positional }
}
const text = (p: Parsed, name: string): string | undefined => { const v = p.flags.get(name); return typeof v === 'string' ? v : undefined }
function port(p: Parsed, name: string): number | undefined {
  const value = text(p, name)
  if (value === undefined) return undefined
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Usage(`--${name} must be a TCP port from 1 to 65535`)
  return Number(value)
}
function configPath(p: Parsed, env: Readonly<Record<string, string | undefined>>): string {
  const path = text(p, 'config') ?? env[MS1_LIVE_CONFIG_ENV]
  if (!path) throw new Usage(`give --config FILE or set ${MS1_LIVE_CONFIG_ENV}`)
  return path
}
function lines(checks: readonly Check[]): string[] {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' } as const
  return checks.flatMap(check => [`${mark[check.status]}  ${check.id}: ${check.summary}${check.ms !== undefined && check.status !== 'skip' ? ` (${check.ms} ms)` : ''}`,
    ...(check.fix && check.status !== 'ok' ? [`      fix: ${check.fix}`] : [])])
}

function template(role: 'home' | 'executor', options: { port: number; federationPort: number; peerFederationPort: number; model: string; llama: string; peerFile: string }) {
  return {
    version: 1, role,
    node: { identityFile: 'identity.json', privateKeyFile: 'node.key' },
    peer: { identityFile: options.peerFile, url: `http://127.0.0.1:${options.peerFederationPort}` },
    listen: { federationPort: options.federationPort, port: options.port },
    model: options.model,
    link: {},
    ...(role === 'home'
      // ADR-0020 reserves, in tokens of one window; sized for a 32768-token window (preflight checks them against the observed one).
      ? { home: { alwaysOn: true, reserves: { turn: 4096, safety: 512, handoff: 3072, tool: 3072, stepMedian: 1536, effective: 24000 } } }
      : { executor: { llamaServer: { baseUrl: options.llama } } }),
  }
}

export async function main(argv: readonly string[], io: Io = stdio, env: Readonly<Record<string, string | undefined>> = process.env,
  /** Trusted extras for the node `start` boots (a test seam: the vault's keychain). The command's own environment, not the process's, names the key file. */
  startExtra: Partial<StartOptions> = {}): Promise<number> {
  const [command, ...rest] = argv
  let parsed: Parsed
  try { parsed = parse(rest) } catch (error) { io.err(`${error instanceof Error ? error.message : 'bad arguments'}\n\n${USAGE}`); return 2 }
  if (!command || command === 'help' || parsed.flags.has('help')) { io.out(USAGE); return command ? 0 : 2 }
  const json = parsed.flags.has('json')
  const report = (value: unknown, human: string[]) => io.out(json ? JSON.stringify(value) : human.join('\n'))
  const configFailure = (error: unknown): number => {
    if (error instanceof Ms1LiveError) {
      report({ ok: false, error: { code: error.code, field: error.field } }, [`FAIL  ${describeConfigError(error)} [${error.code}]`])
      return 2
    }
    throw error
  }
  try {
    switch (command) {
      case 'init': {
        const role = text(parsed, 'role'), dir = text(parsed, 'dir')
        if ((role !== 'home' && role !== 'executor') || !dir) throw new Usage('init needs --role home|executor and --dir DIR')
        const api = port(parsed, 'port') ?? (role === 'home' ? 4551 : 4552)
        const federationPort = port(parsed, 'federation-port') ?? (role === 'home' ? 4561 : 4562)
        const peerFederationPort = port(parsed, 'peer-federation-port') ?? (role === 'home' ? 4562 : 4561)
        const peerFile = text(parsed, 'peer-file') ?? 'peer.json'
        let result: ReturnType<typeof initNode>
        try {
          result = initNode(dir, { role, ...(text(parsed, 'id') ? { id: text(parsed, 'id')! } : {}), ...(text(parsed, 'account') ? { accountId: text(parsed, 'account')! } : {}), federationPort,
            config: () => template(role, { port: api, federationPort, peerFederationPort, model: text(parsed, 'model') ?? 'qwen3.8-27b-iq3s', llama: text(parsed, 'llama-url') ?? 'http://127.0.0.1:8090', peerFile }) })
        } catch (error) { if (error instanceof ZodError) throw new Usage('--id and --account must be 1-200 characters of letters, digits, . _ : -'); throw error }
        report({ ok: true, role, nodeId: result.identity.id, accountId: result.identity.accountId, dir: result.dir, configFile: result.configFile,
          peerOffer: result.peerOffer, privateKeyFile: result.privateKeyFile, apiPort: api, federationPort, peerFederationPort, peerFile },
        [`Initialised ${role} node ${result.identity.id} (account ${result.identity.accountId}) in ${result.dir}`,
          `  configuration: ${result.configFile}`, `  copy this PUBLIC file to the other node as its peer file: ${result.peerOffer}`,
          `  put the other node's peer-offer.json at: ${resolve(result.dir, peerFile)}`,
          `  the private key stays here: ${result.privateKeyFile} (mode 0600; it is never printed or copied)`,
          `  ports: owner API ${api} (never forwarded), federation ${federationPort} (the one to forward); the peer's federation port is ${peerFederationPort}`,
          `  then: ms1-live doctor --config ${result.configFile}`])
        return 0
      }
      case 'doctor': {
        const result = await doctor({ configPath: configPath(parsed, env), env, ...(text(parsed, 'data-dir') ? { dataDir: text(parsed, 'data-dir')! } : {}) })
        report(result, [...lines(result.checks), result.ok ? 'doctor: nothing is wrong that this machine can see.' : 'doctor: fix the FAIL lines first.'])
        return result.ok ? 0 : 1
      }
      case 'preflight': {
        let settings: Ms1LiveSettings
        try { settings = loadMs1LiveConfig(configPath(parsed, env)) } catch (error) { if (error instanceof Usage) throw error; return configFailure(error) }
        const result = await preflight({ settings, completion: parsed.flags.has('completion') })
        const o = result.observed
        report(result, [...lines(result.checks),
          ...(o ? ['', `model     ${o.model}`, `window    ${o.contextTokens} tokens (${o.propsSource})`, `build     ${o.runtimeVersion}`, `digest    ${o.digest}`,
            `counter   ${o.counterSource}${o.probe ? ` (probe: ${o.probe.tokens} tokens)` : ''}`, `observed  ${o.observedAt}`] : []),
          result.ok ? 'preflight: ok' : 'preflight: FAILED'])
        return result.ok ? 0 : 1
      }
      case 'start': return await startCommand(parsed, io, env, json, startExtra)
      default: throw new Usage(`unknown command ${command}`)
    }
  } catch (error) {
    if (error instanceof Usage) { io.err(`${error.message}\n\n${USAGE}`); return 2 }
    if (error instanceof Ms1LiveError) return configFailure(error)
    io.err(`${command} failed: ${error instanceof Error ? error.name : 'error'}`)
    return 1
  }
}

async function startCommand(parsed: Parsed, io: Io, env: Readonly<Record<string, string | undefined>>, json: boolean, startExtra: Partial<StartOptions>): Promise<number> {
  const settings = loadMs1LiveConfig(configPath(parsed, env))
  const promptFile = text(parsed, 'lead-prompt-file'), project = text(parsed, 'project')
  if (!!promptFile !== !!project) throw new Usage('--lead-prompt-file and --project go together')
  if (promptFile && !settings.home?.lead) throw new Usage('--lead-prompt-file needs a home.lead section in the configuration')
  let prompt: string | null = null
  if (promptFile) { try { prompt = readFileSync(resolve(promptFile), 'utf8') } catch { throw new Usage('--lead-prompt-file cannot be read') } }
  const emit = (event: Record<string, unknown>) => io.out(json ? JSON.stringify(event) : Object.entries(event).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' '))
  const dataDir = text(parsed, 'data-dir'), listen = port(parsed, 'port')
  let server: Awaited<ReturnType<typeof start>>
  // `providerKeysFile` is always given (empty: none), so `doctor` and `start` read the one source, the command's environment.
  // The forced stop is an executor contract: one JSON line on stdout even without `--json`. A home closes unbounded so its
  // relay, pins and detached Claude Code process groups can finish.
  const shutdown = settings.role === 'executor'
    ? { boundMs: MS1_LIVE_STOP_BOUND_MS, forced: (event: { event: 'stop'; forced: true }) => io.out(JSON.stringify(event)) }
    : undefined
  try { server = await start({ ms1Live: settings, providerKeysFile: env['GUANXI_PROVIDER_KEYS_FILE'] ?? '', ...(listen ? { port: listen } : {}), ...(dataDir ? { dataDir: resolve(dataDir) } : {}),
    ...(shutdown ? { shutdown } : {}), ...startExtra }) } catch (error) {
    if (error instanceof Ms1LiveError) { emit({ event: 'failed', code: error.code, field: error.field, summary: describeConfigError(error) }); return 2 }
    const code = (error as NodeJS.ErrnoException | null)?.code
    emit({ event: 'failed', code: code === 'EADDRINUSE' ? 'port_in_use' : 'start_failed' })
    return 1
  }
  const live = server.ms1Live!
  emit({ event: 'started', role: live.role, nodeId: live.identity.id, peerId: live.peer.id, url: server.url, port: server.port, federationUrl: `http://127.0.0.1:${live.federationPort}`,
    peerUrl: settings.peer.url, model: live.model, connectionId: live.connectionId, ...(live.hasLead ? { leadConnectionId: live.leadConnectionId } : {}) })
  if (live.role === 'executor') void live.startWarming().then(state => emit({ event: 'warm', state: state.state, ...(state.code ? { code: state.code } : {}) }))
  if (live.hasLead) {
    try {
      await setUpLead(server, settings, env, prompt, project, emit)
    } catch (error) {
      // A node that cannot do what it was asked to do (a lead that cannot start) must not be left running half-configured.
      emit({ event: 'failed', code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'lead_setup_failed' })
      await server.close().catch(() => undefined)
      return 1
    }
  }
  // `start()` installed the SIGINT/SIGTERM handlers that close the node cleanly; this process now lives until one arrives.
  await new Promise<never>(() => undefined)
  return 0
}

/** The lead half of `start`: announce how the lead is paid (never a credential) and, when asked, bind the role and start one lead. */
export async function setUpLead(server: Awaited<ReturnType<typeof start>>, settings: Ms1LiveSettings, env: Readonly<Record<string, string | undefined>>,
  prompt: string | null, project: string | undefined, emit: (event: Record<string, unknown>) => void): Promise<void> {
  const live = server.ms1Live!
  const external = server.kernel.node.service<ExternalAgentService>(EXTERNAL_AGENT_SERVICE)!
  const lead = settings.home!.lead!
  if (lead.auth !== 'subscription') {
    // Nothing to sign in to: the credential comes from the K3 vault at launch. Ids, policy and where the file was named, never a value.
    const source = env['GUANXI_PROVIDER_KEYS_FILE'] ? 'GUANXI_PROVIDER_KEYS_FILE' : lead.providerKeysFile ? 'home.lead.providerKeysFile' : 'vault'
    emit({ event: 'lead-auth', mode: lead.auth, billing: lead.auth === 'api_key' ? 'api_usage' : 'subscription', keySource: source, connectionId: live.leadConnectionId,
      // Guanxi's private directory for the CLI: a settings file in it (or in work/.claude) refuses the launch with claude_settings_present.
      configDirectory: external.configDirectory(LOCAL_ACCOUNT_ID, LOCAL_ACCOUNT_ID, live.leadConnectionId), ...(lead.effort ? { effort: lead.effort } : {}) })
  } else {
    // Only paths and the argv of the vendor's own sign-in: the login itself happens in the vendor CLI, in its private config directory.
    const login = await external.prepareLogin(LOCAL_ACCOUNT_ID, LOCAL_ACCOUNT_ID, live.leadConnectionId)
    emit({ event: 'lead-login', hint: 'run this once, as is, in a terminal if the lead is not signed in', executable: login.executable, args: login.args, environment: login.environment })
  }
  if (prompt && project) {
    external.setProjectRoles(LOCAL_ACCOUNT_ID, LOCAL_ACCOUNT_ID, project, { lead: { backend: 'claude-code', connectionId: live.leadConnectionId, model: settings.home!.lead!.model, params: {} } })
    const leads = server.kernel.node.service<LeadHostService>(LEAD_SERVICE)!
    // A restart asked for the same task never starts a second lead, nor does any lead that is still live (input_required waits for an explicit
    // resume). A lead whose run finished (completed, failed, canceled) does not block a new task.
    const finished = new Set(['completed', 'failed', 'canceled'])
    const task = leads.normalizeTask(prompt)
    if (leads.sessions().some(lead => lead.task === task || !finished.has(lead.state ?? ''))) emit({ event: 'lead-exists', hint: 'a live lead or a lead with the same task exists on this node; it was not started again' })
    else {
      const started = leads.startLead({ ownerAccountId: LOCAL_ACCOUNT_ID, actorAccountId: LOCAL_ACCOUNT_ID, projectId: project, prompt })
      emit({ event: 'lead-started', runId: started.runId })
      started.first.then(result => emit({ event: 'lead-first', outcome: result.outcome, code: result.code }), error => emit({ event: 'lead-first', outcome: 'failed', code: String((error as { code?: unknown })?.code ?? 'error') }))
    }
  }
}
