import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { apiPortFromEnv, dataDirFromEnv } from '../config/listen-env.ts'
import { inspectProviderKeysFile } from '../connections/dotenv.ts'
import { LlamaServerClient } from '../runtime/llama-server/client.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import { explainProbe, fail, ok, probeFederation, skip, step, warn, type Check } from './checks.ts'
import { loadMs1LiveConfig, MS1_LIVE_CONFIG_ENV, type Ms1LiveSettings } from './config.ts'
import { MS1_SCOPES, readPeerFileFull, readPrivateKey, sameScopes } from './identity.ts'

const exec = promisify(execFile)
export interface DoctorReport { ok: boolean; config: string | null; role: string | null; checks: Check[] }
export interface DoctorOptions {
  /** Path of the configuration file; falls back to `GUANXI_MS1_LIVE_CONFIG`. */
  configPath?: string
  /** The data directory `start` will use; default as `start` computes it (GUANXI_DATA_DIR, else beside the configuration). */
  dataDir?: string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  transport?: typeof fetch
}
const executable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false } }
const writableDir = (path: string): boolean => { try { accessSync(path, constants.W_OK); return statSync(path).isDirectory() } catch { return false } }

/** The key file the lead's API-key mode imports at boot, judged without printing a value: where it comes from (the same order `start`
 * uses: `GUANXI_PROVIDER_KEYS_FILE`, then the configuration), whether it parses, and whether `ANTHROPIC_API_KEY` is an API key (an OAuth
 * token of the subscription family is refused). The vault is not opened here, so a connection named by `home.lead.connection` is judged at start. */
function leadKeyChecks(lead: NonNullable<NonNullable<Ms1LiveSettings['home']>['lead']>, env: Readonly<Record<string, string | undefined>>): Check[] {
  const fromEnv = env['GUANXI_PROVIDER_KEYS_FILE'] || undefined, file = fromEnv || lead.providerKeysFile
  if (!file) return [warn('lead_key', 'lead_key_file_not_given', 'No key file is named for the API-key lead: its key must already be in this node\'s vault from an earlier import.',
    'Set home.lead.providerKeysFile to your dotenv file (with ANTHROPIC_API_KEY=), or GUANXI_PROVIDER_KEYS_FILE, or run `guanxi connections import --file` first.')]
  const where = fromEnv ? 'GUANXI_PROVIDER_KEYS_FILE' : 'home.lead.providerKeysFile'
  if (!isAbsolute(file)) return [fail('lead_key', 'path_not_absolute', `${where} must be an absolute path.`)]
  const found = inspectProviderKeysFile(file)
  if (found.kind === 'unreadable') return [fail('lead_key', 'lead_key_file_unreadable', `The key file named by ${where} cannot be read.`, 'Check the path and that this user can read the file.')]
  if (found.kind === 'invalid') return [fail('lead_key', 'lead_key_file_invalid', 'The key file does not parse: it is malformed (duplicate name, unterminated quote, unquoted #) or holds no supported key.',
    'See docs/operations/ms1-live-run.md section 7 and the connections README (D-208).')]
  const checks: Check[] = found.mode & 0o077 ? [warn('lead_key_mode', 'lead_key_file_mode', `The key file (${where}) is readable by other users.`, 'chmod 600 the file; it holds a live key.')] : []
  const verdict = ((): Check => {
    if (found.invalid.includes('ANTHROPIC_API_KEY')) return fail('lead_key', 'lead_key_invalid', 'ANTHROPIC_API_KEY in the key file is not an Anthropic API key (it must start with sk-ant-api).',
      'An OAuth or subscription token (sk-ant-oat...) is refused as an API key: create an API key in the Anthropic Console.')
    if (!found.providers.includes('anthropic')) return fail('lead_key', 'lead_key_missing', 'The key file has no ANTHROPIC_API_KEY (`start` does not fall back to an older key in the vault when a file is named).', 'Add ANTHROPIC_API_KEY=... to the file (quote a value that contains #).')
    if (found.invalid.length) return fail('lead_key', 'lead_key_import_failed', `The boot import would fail as a whole: ${found.invalid.join(', ')} in the key file is invalid, and an API-key lead does not start on a half-imported vault.`,
      'Fix or remove those lines.')
    return ok('lead_key', `An Anthropic API key (sk-ant-api...) is present in the key file named by ${where}; its value is not shown, and \`start\` imports it into this node's vault.`)
  })()
  return [...checks, verdict]
}

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
  const dataDir = options.dataDir ? resolve(options.dataDir) : env['GUANXI_DATA_DIR'] ? dataDirFromEnv(env) : join(dirname(s.file), 'data')
  const defaultHome = [join(env['HOME'] ?? homedir(), '.guanxi'), join(homedir(), '.guanxi')].includes(dataDir)
  checks.push(defaultHome ? fail('data_dir', 'data_dir_default', `The data directory would be ${dataDir}, the default of an everyday node.`, 'Live mode refuses it: pass --data-dir to start, or set GUANXI_DATA_DIR, to a directory of its own.')
    : ok('data_dir', `Data directory: ${dataDir}.`, { dataDir }))
  let identityId = '', accountId = '', peerId = '', peerAccount = ''
  let identityKey = '', peerKey = ''
  let scopes: string[] = [], peerScopes: string[] = [], trust = '', peerTrust = '', admin = false, peerAdmin = false
  let peerFederationPort: number | null = null

  checks.push(await step('identity', async () => {
    const { identity } = readPeerFileFull(s.node.identityFile, 'identity_unreadable', 'identity_invalid')
    identityId = identity.id; accountId = identity.accountId; identityKey = identity.publicKey; scopes = identity.scopes; trust = identity.trust; admin = identity.admin
    return ok('identity', `This node is ${identity.id} (account ${identity.accountId}).`, { nodeId: identity.id, accountId: identity.accountId })
  }))
  checks.push(!identityId ? skip('private_key', 'Skipped: no usable identity.') : await step('private_key', async () => {
    readPrivateKey(s.node.privateKeyFile, { id: identityId, accountId, publicKey: identityKey, trust: trust as 'owner_device', admin, scopes: scopes as typeof MS1_SCOPES })
    return ok('private_key', 'The private key is a private file and belongs to the identity.')
  }))
  checks.push(await step('peer_file', async () => {
    const { identity, federationPort: port } = readPeerFileFull(s.peer.identityFile)
    peerId = identity.id; peerAccount = identity.accountId; peerKey = identity.publicKey; peerScopes = identity.scopes; peerTrust = identity.trust; peerFederationPort = port; peerAdmin = identity.admin
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
    if (![peerScopes, scopes].every(sameScopes)) problems.push('both identities must carry exactly the attempts and replicas scopes (an edited peer file with more is refused)')
    if (admin || peerAdmin) problems.push('neither identity may be an admin')
    checks.push(problems.length ? fail('pairing', 'pairing_invalid', `The two identities do not pair: ${problems.join('; ')}.`,
      'Initialise both nodes with the same --account and exchange the peer-offer.json files; do not edit an identity by hand.')
      : ok('pairing', 'The identities pair (same account, owner devices, exactly the attempts and replicas scopes, no admin).'))
  } else checks.push(skip('pairing', 'Skipped: an identity is missing.'))

  // Ports. The owner API port is never forwarded; the federation port is, and the peer checks Host against the port it listens on.
  const api = apiPortFromEnv(env, s.listen.port ?? 4310), fed = s.listen.federationPort, peerUrlPort = Number(new URL(s.peer.url).port)
  checks.push(api === fed ? fail('listen', 'ports_collide', `The owner API and the federation listener are both configured for port ${api}.`, 'Give listen.federationPort its own number.')
    : ok('listen', `Owner API on 127.0.0.1:${api} (never forwarded); federation on 127.0.0.1:${fed} (the one the peer's ssh forward must reach, as the same number).`, { apiPort: api, federationPort: fed }))
  if (peerFederationPort !== null && peerFederationPort !== peerUrlPort) {
    checks.push(fail('forward_port', 'forward_port_mismatch', `peer.url uses port ${peerUrlPort}, but the peer file says that node's federation listener is on ${peerFederationPort}.`,
      `Forward the same number on both ends (ssh -L ${peerFederationPort}:127.0.0.1:${peerFederationPort}) and set peer.url to http://127.0.0.1:${peerFederationPort}.`))
  } else checks.push(ok('forward_port', `peer.url port ${peerUrlPort}${peerFederationPort === null ? ' (the peer file does not state its federation port)' : ' matches the peer file'}.`))
  const ownProbe = await probeFederation(`http://127.0.0.1:${fed}`, 2_000, options.transport)
  checks.push(ownProbe.kind === 'refused' ? ok('own_port', `Federation port ${fed} is free: this node is not running.`)
    : ownProbe.kind === 'status' && ownProbe.status === 401 ? ok('own_port', `A Guanxi federation listener already answers on port ${fed} (this node, if it was started with this configuration).`)
    : warn('own_port', 'own_port_in_use', `Something other than a Guanxi federation endpoint answers on port ${fed}.`, 'Choose another listen.federationPort, or stop that process.'))
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
      // Attach mode digests the model file on THIS machine: the node's user must be able to read what the server reports.
      checks.push(await step('model_file', async () => {
        const props = await client.props(AbortSignal.timeout(6_000))
        accessSync(props.modelPath, constants.R_OK)
        return ok('model_file', 'The model file the llama-server reports is readable by this user (attach mode hashes it here).')
      }, () => ({ code: 'model_file_unreadable', summary: 'The model file the llama-server reports cannot be read by this user.',
        fix: 'Run the node as a user that can read it; an owner-only parent directory needs traverse (--x) access for this user.' })))
    } else { checks.push(skip('llama_alias', 'Skipped: the llama-server is not healthy yet.'), skip('model_file', 'Skipped: the llama-server is not healthy yet.')) }
    checks.push(skip('gates', 'Acceptance gates run on the home node; nothing to check here.'))
  } else {
    const home = s.home!
    checks.push(executable('/usr/bin/git') ? ok('git', '/usr/bin/git is present (owned checkouts use it).') : fail('git', 'git_missing', '/usr/bin/git is missing.', 'Install git; owned checkouts and the target repository clone need it.'))
    const root = home.checkoutRoot ?? join(dataDir, 'relay-checkouts')
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
      checks.push(...(lead.auth === 'api_key' ? leadKeyChecks(lead, env) : [ ok('lead_auth', 'The lead signs in with the owner\'s subscription: `start` prints the sign-in command for K5\'s private config directory.')]))
    } else checks.push(skip('lead', 'No lead section: relay starts come from the public relay route.'))
  }
  return { ok: checks.every(check => check.status !== 'fail'), config: s.file, role: s.role, checks }
}
