import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { apiPortFromEnv, dataDirFromEnv } from '../config/listen-env.ts'
import { LlamaServerClient } from '../runtime/llama-server/client.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import { explainProbe, fail, ok, probeFederation, skip, step, warn, type Check } from './checks.ts'
import { loadMs1LiveConfig, MS1_LIVE_CONFIG_ENV, type Ms1LiveSettings } from './config.ts'
import { MS1_SCOPES, readPeerFileFull, readPrivateKey } from './identity.ts'

const exec = promisify(execFile)
export interface DoctorReport { ok: boolean; config: string | null; role: string | null; checks: Check[] }
export interface DoctorOptions {
  /** Path of the configuration file; falls back to `GUANXI_MS1_LIVE_CONFIG`. */
  configPath?: string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  transport?: typeof fetch
}
const executable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false } }
const writableDir = (path: string): boolean => { try { accessSync(path, constants.W_OK); return statSync(path).isDirectory() } catch { return false } }

/** Explains, from the files on this machine and loopback probes only, what is missing for this node to take part. Starts
 * nothing, writes nothing, and prints no key material. A warning means "not yet" or "worth knowing"; only a failure is a fault. */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform
  const checks: Check[] = []
  const path = options.configPath ?? env[MS1_LIVE_CONFIG_ENV]
  if (!path) {
    checks.push(fail('config', 'config_not_given', 'No configuration file was given.', `Pass --config <file> or set ${MS1_LIVE_CONFIG_ENV}. Create one with: ms1-live init --role home|executor --dir <dir>.`))
    return { ok: false, config: null, role: null, checks }
  }
  let settings: Ms1LiveSettings | undefined
  const loaded = await step('config', async () => { settings = loadMs1LiveConfig(path); return ok('config', `Configuration for the ${settings.role} node is valid.`, { file: settings.file, role: settings.role, model: settings.model }) })
  checks.push(loaded)
  if (!settings) return { ok: false, config: path, role: null, checks }
  const s = settings
  let identityId = '', accountId = '', peerId = '', peerAccount = ''
  let identityKey = '', peerKey = ''
  let scopes: string[] = [], peerScopes: string[] = [], trust = '', peerTrust = ''
  let peerPort: number | null = null

  checks.push(await step('identity', async () => {
    const { identity } = readPeerFileFull(s.node.identityFile, 'identity_unreadable', 'identity_invalid')
    identityId = identity.id; accountId = identity.accountId; identityKey = identity.publicKey; scopes = identity.scopes; trust = identity.trust
    return ok('identity', `This node is ${identity.id} (account ${identity.accountId}).`, { nodeId: identity.id, accountId: identity.accountId })
  }))
  checks.push(!identityId ? skip('private_key', 'Skipped: no usable identity.') : await step('private_key', async () => {
    readPrivateKey(s.node.privateKeyFile, { id: identityId, accountId, publicKey: identityKey, trust: trust as 'owner_device', admin: false, scopes: scopes as typeof MS1_SCOPES })
    return ok('private_key', 'The private key is a private file and belongs to the identity.')
  }))
  checks.push(await step('peer_file', async () => {
    const { identity, port } = readPeerFileFull(s.peer.identityFile)
    peerId = identity.id; peerAccount = identity.accountId; peerKey = identity.publicKey; peerScopes = identity.scopes; peerTrust = identity.trust; peerPort = port
    return ok('peer_file', `The peer is ${identity.id} (account ${identity.accountId}).`, { peerId: identity.id, accountId: identity.accountId })
  }, error => {
    const found = (error as { code?: string }).code
    return { code: found ?? 'peer_invalid', summary: found === 'peer_unreadable' ? 'The peer file is missing.' : 'The peer file is not a valid peer-offer.json.',
      fix: `Copy the other node's peer-offer.json to ${s.peer.identityFile}.` }
  }))
  if (identityId && peerId) {
    const problems: string[] = []
    if (peerId === identityId || peerKey === identityKey) problems.push('the peer file is this node\'s own identity')
    if (peerAccount !== accountId) problems.push(`the accounts differ (${accountId} here, ${peerAccount} there)`)
    if (peerTrust !== 'owner_device' || trust !== 'owner_device') problems.push('both nodes must be owner_device')
    if (![peerScopes, scopes].every(have => MS1_SCOPES.every(scope => have.includes(scope)))) problems.push('both identities need the attempts and replicas scopes')
    checks.push(problems.length ? fail('pairing', 'pairing_invalid', `The two identities do not pair: ${problems.join('; ')}.`,
      'Initialise both nodes with the same --account and exchange the peer-offer.json files; do not edit an identity by hand.')
      : ok('pairing', 'The identities pair (same account, owner devices, attempts and replicas scopes).'))
  } else checks.push(skip('pairing', 'Skipped: an identity is missing.'))

  // Ports: the peer checks the Host header against its own listening port, so a forward must keep the number.
  const own = options.env ? apiPortFromEnv(options.env, s.listen?.port ?? 4310) : apiPortFromEnv(env, s.listen?.port ?? 4310)
  const peerUrlPort = Number(new URL(s.peer.url).port)
  if (!s.listen && !env['GUANXI_API_PORT']) checks.push(warn('listen', 'listen_port_unset', `listen.port is not set: the node would listen on ${own}, and the peer must forward exactly that number.`, 'Set "listen": {"port": N} in the configuration.'))
  else checks.push(ok('listen', `This node listens on 127.0.0.1:${own}; the peer must reach it through a forward of the same port number.`, { port: own }))
  if (peerPort !== null && peerPort !== peerUrlPort) {
    checks.push(fail('forward_port', 'forward_port_mismatch', `peer.url uses port ${peerUrlPort}, but the peer file says that node listens on ${peerPort}.`,
      `Forward the same number on both ends (ssh -L ${peerPort}:127.0.0.1:${peerPort}) and set peer.url to http://127.0.0.1:${peerPort}.`))
  } else checks.push(ok('forward_port', `peer.url port ${peerUrlPort}${peerPort === null ? ' (the peer file does not state its port)' : ' matches the peer file'}.`))
  const ownProbe = await probeFederation(`http://127.0.0.1:${own}`, 2_000, options.transport)
  checks.push(ownProbe.kind === 'refused' ? ok('own_port', `Port ${own} is free: this node is not running.`)
    : ownProbe.kind === 'status' && ownProbe.status === 401 ? ok('own_port', `A Guanxi node already listens on port ${own} (this node, if it was started with this configuration).`)
    : warn('own_port', 'own_port_in_use', `Something other than a Guanxi federation endpoint answers on port ${own}.`, 'Choose another listen.port, or stop that process.'))
  const peerProbe = explainProbe('peer_reachable', await probeFederation(s.peer.url, 3_000, options.transport), s.peer.url)
  checks.push(peerProbe.status === 'fail' && ['peer_unreachable', 'peer_timeout'].includes(peerProbe.code ?? '')
    ? warn('peer_reachable', peerProbe.code!, `${peerProbe.summary} (fine before the peer and the ssh forward are up)`, peerProbe.fix) : peerProbe)

  if (s.role === 'executor') {
    const base = s.executor!.llamaServer.baseUrl
    const client = new LlamaServerClient({ baseUrl: base, requestTimeoutMs: 5_000 })
    const health = await step('llama_health', async () => {
      const state = await client.health(AbortSignal.timeout(6_000))
      return state === 'ok' ? ok('llama_health', `The llama-server at ${base} is healthy.`) : warn('llama_health', 'llama_server_loading', 'The llama-server is still loading the model.', 'Wait for /health to answer ok, then rerun.')
    })
    checks.push(health)
    if (health.status === 'ok') {
      checks.push(await step('llama_alias', async () => {
        const props = await client.props(AbortSignal.timeout(6_000))
        const alias = normalizeOllamaModelReference(props.alias ?? '')
        if (alias !== normalizeOllamaModelReference(s.model)) {
          return fail('llama_alias', 'alias_mismatch', `The llama-server serves the alias "${props.alias ?? '(none)'}", but "model" is "${s.model}".`, 'Start llama-server with --alias <model> --jinja, or fix "model" in the configuration.')
        }
        return ok('llama_alias', `The alias matches; the window is ${props.contextTokens} tokens; build ${props.buildInfo}.`, { window: props.contextTokens, build: props.buildInfo, slots: props.slots })
      }))
    } else checks.push(skip('llama_alias', 'Skipped: the llama-server is not healthy yet.'))
    checks.push(skip('gates', 'Acceptance gates run on the home node; nothing to check here.'))
  } else {
    const home = s.home!
    checks.push(executable('/usr/bin/git') ? ok('git', '/usr/bin/git is present (owned checkouts use it).') : fail('git', 'git_missing', '/usr/bin/git is missing.', 'Install git; owned checkouts and the target repository clone need it.'))
    const root = home.checkoutRoot ?? join(dataDirFromEnv(env), 'relay-checkouts')
    const parent = (() => { let p = root; while (p !== dirname(p)) { try { if (statSync(p).isDirectory()) return p } catch { /* walk up */ } p = dirname(p) } return p })()
    checks.push(writableDir(parent) ? ok('checkout_root', `Owned checkouts go under ${root}.`) : fail('checkout_root', 'checkout_root_unwritable', `${root} cannot be created.`, 'Set home.checkoutRoot to a writable directory.'))
    if (platform === 'darwin' && !root.startsWith(homedir() + '/')) {
      checks.push(warn('checkout_share', 'checkout_outside_home', 'The Colima VM shares your home directory; a checkout root elsewhere is invisible to the gate sandbox.', 'Keep home.checkoutRoot (and the data directory) under your home directory.'))
    }
    checks.push(await step('container_runtime', async () => {
      const path = `/opt/homebrew/bin:/usr/local/bin:${process.env['PATH'] ?? ''}`
      const { stdout } = await exec('docker', ['info', '--format', '{{.OSType}}'], { timeout: 15_000, env: { ...process.env, PATH: path } })
      return ok('container_runtime', `The container runtime for acceptance gates answers (${stdout.trim() || 'unknown OS'}).`)
    }, () => ({ code: 'container_runtime_unavailable', summary: 'No container runtime answers; acceptance gates run in the K4 sandbox.',
      fix: platform === 'darwin' ? 'Start Colima (`colima start`); this tool never starts or resets it.' : 'Start the Docker daemon.' })).then(check => check.status === 'fail' ? { ...check, status: 'warn' as const } : check))
    checks.push(platform === 'darwin' ? warn('awake', 'keep_awake', 'home.alwaysOn asserts this Mac stays awake while remote calls and a sleeping lead are in flight; nothing here arranges it.', 'Start the node under `caffeinate -dimsu` and keep it on power.')
      : ok('awake', 'home.alwaysOn is asserted by the configuration.'))
    const lead = home.lead
    if (lead) {
      for (const [id, value, what] of [['lead_bridge', lead.bridge, 'the ACP bridge (@agentclientprotocol/claude-agent-acp)'], ['lead_claude', lead.claudeExecutable, 'the Claude Code CLI']] as const) {
        checks.push(!isAbsolute(value) ? fail(id, 'path_not_absolute', `${what} must be an absolute path.`) : executable(value) ? ok(id, `${what} is executable at ${value}.`)
          : fail(id, 'executable_missing', `${what} is not an executable file at ${value}.`, id === 'lead_bridge' ? 'Install the bridge (see the runbook), then set lead.bridge to its absolute path.' : 'Set lead.claudeExecutable to the installed Claude Code CLI.'))
      }
    } else checks.push(skip('lead', 'No lead section: relay starts come from the public relay route.'))
  }
  return { ok: checks.every(check => check.status !== 'fail'), config: s.file, role: s.role, checks }
}
