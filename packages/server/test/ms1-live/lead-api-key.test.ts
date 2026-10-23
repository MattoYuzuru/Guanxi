/** D-211: the MS1 lead may run Claude Code on the owner's Anthropic API key, imported by K3 into the vault. Fake keys only: no test
 * reads the owner's dotenv file, opens the OS keychain or makes a network call. */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { EXTERNAL_AGENT_SERVICE, type ExternalAgentService } from '../../src/external-agents/plugin.ts'
import { start } from '../../src/index.ts'
import { loadMs1LiveConfig, Ms1LiveError, parseMs1LiveConfig, type Ms1LiveSettings } from '../../src/ms1-live/config.ts'
import type { VaultKeychain } from '../../src/vault/keychain.ts'
import { cli, freePort } from './live-world.ts'

const reserves = { turn: 4096, safety: 512, handoff: 3072, tool: 3072, stepMedian: 1536, effective: 24000 }
const caps = { cycles: 1, tokens: 1, moneyMicros: 1, wallMs: 1 }
const lead = (overrides: Record<string, unknown> = {}) => ({ adapter: 'claude-code', bridge: '/x/bridge', bridgeVersion: '0.94.0', claudeExecutable: '/x/claude',
  limits: { maxCaps: caps, maxDeadlineMs: 1 }, ...overrides })
const home = (leadOverrides: Record<string, unknown> = {}) => ({ version: 1, role: 'home', node: { identityFile: 'identity.json', privateKeyFile: 'node.key' },
  peer: { identityFile: 'peer.json', url: 'http://127.0.0.1:4562' }, listen: { federationPort: 4561 }, model: 'qwen3.8-27b', home: { alwaysOn: true, reserves, lead: lead(leadOverrides) } })
const refused = (raw: unknown, code: string, field: string) => assert.throws(() => parseMs1LiveConfig(raw, '/etc/x/ms1-live.json'),
  (error: unknown) => error instanceof Ms1LiveError && error.code === code && error.field === field, `${code} at ${field}`)
const fakeKey = () => `sk-ant-api03-FAKE${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`
const keychain = async (): Promise<VaultKeychain> => ({ key: () => Buffer.alloc(32, 9) })

test('config: the lead pays by subscription unless told otherwise, and the API-key options belong to api_key only', () => {
  const sub = parseMs1LiveConfig(home(), '/etc/x/ms1-live.json').home!.lead!
  assert.deepEqual([sub.auth, sub.connection, sub.providerKeysFile, sub.effort], ['subscription', undefined, undefined, undefined])
  const api = parseMs1LiveConfig(home({ auth: 'api_key', connection: 'anthropic (dotenv)', providerKeysFile: '/Users/x/keys.env', effort: 'medium' }), '/etc/x/ms1-live.json').home!.lead!
  assert.deepEqual([api.auth, api.connection, api.providerKeysFile, api.effort], ['api_key', 'anthropic (dotenv)', '/Users/x/keys.env', 'medium'])
  refused(home({ connection: 'x' }), 'config_api_key_only', 'home.lead.connection')
  refused(home({ auth: 'subscription', providerKeysFile: '/x/keys.env' }), 'config_api_key_only', 'home.lead.providerKeysFile')
  refused(home({ auth: 'api_key', providerKeysFile: 'keys.env' }), 'config_path_not_absolute', 'home.lead.providerKeysFile')
  refused(home({ auth: 'api_key', effort: 'maximum' }), 'config_invalid', 'home.lead.effort')
  refused(home({ auth: 'oauth' }), 'config_invalid', 'home.lead.auth')
  refused(home({ auth: 'api_key', apiKey: 'sk-ant-api03-SECRETSECRETSECRET' }), 'config_unknown_key', 'home.lead')
})

interface Pair { root: string; home: string; keyFile: string; settings: (change?: (config: any) => void) => Ms1LiveSettings }
async function pair(t: { after(fn: () => unknown): void }): Promise<Pair> {
  const root = mkdtempSync(join(tmpdir(), 'ms1-apikey-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const [hp, hf, ep, ef] = [await freePort(), await freePort(), await freePort(), await freePort()]
  await cli(['init', '--role', 'home', '--dir', join(root, 'home'), '--port', String(hp), '--federation-port', String(hf), '--peer-federation-port', String(ef), '--json'])
  await cli(['init', '--role', 'executor', '--dir', join(root, 'exec'), '--port', String(ep), '--federation-port', String(ef), '--peer-federation-port', String(hf), '--llama-url', 'http://127.0.0.1:1', '--json'])
  copyFileSync(join(root, 'exec', 'peer-offer.json'), join(root, 'home', 'peer.json')); copyFileSync(join(root, 'home', 'peer-offer.json'), join(root, 'exec', 'peer.json'))
  for (const name of ['bridge', 'claude']) { writeFileSync(join(root, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(root, name), 0o755) }
  const keyFile = join(root, 'keys.env')
  const file = join(root, 'home', 'ms1-live.json')
  const settings = (change?: (config: any) => void) => {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.home.lead = { adapter: 'claude-code', bridge: join(root, 'bridge'), bridgeVersion: '0.94.0', claudeExecutable: join(root, 'claude'), model: 'default',
      limits: { maxCaps: caps, maxDeadlineMs: 1 }, auth: 'api_key', providerKeysFile: keyFile, effort: 'medium' }
    change?.(config)
    writeFileSync(file, JSON.stringify(config))
    return loadMs1LiveConfig(file)
  }
  return { root, home: join(root, 'home'), keyFile, settings }
}
const writeKeys = (path: string, text: string, mode = 0o600) => { writeFileSync(path, text); chmodSync(path, mode) }
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)])

test('doctor judges the key file without printing a value: source, mode, token family, missing key, partial import', async t => {
  const w = await pair(t)
  const key = fakeKey()
  w.settings()
  const run = async (env: Record<string, string> = {}) => {
    const result = await cli(['doctor', '--config', join(w.home, 'ms1-live.json'), '--json'], { HOME: w.root, ...env })
    assert.equal(result.out.includes(key), false, 'no key value in the report')
    assert.equal(result.out.includes('sk-ant-api03-FAKE'), false)
    const checks = (JSON.parse(result.out) as { checks: Array<{ id: string; status: string; code?: string; summary: string; fix?: string }> }).checks
    return (id: string) => checks.find(check => check.id === id)
  }
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\n`)
  let check = await run()
  assert.equal(check('lead_key')?.status, 'ok'); assert.match(check('lead_key')!.summary, /home\.lead\.providerKeysFile/); assert.equal(check('lead_key_mode'), undefined)
  assert.equal(check('lead_auth'), undefined, 'the subscription sign-in hint is for subscription mode only')
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\n`, 0o644)
  assert.equal((await run())('lead_key_mode')?.code, 'lead_key_file_mode')
  // The OAuth token family is refused as an API key, with the fix.
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=sk-ant-oat01-${'a'.repeat(50)}\n`)
  check = await run(); assert.equal(check('lead_key')?.code, 'lead_key_invalid'); assert.match(check('lead_key')!.fix!, /Console/)
  writeKeys(w.keyFile, `OPENAI_API_KEY=${'o'.repeat(40)}\n`)
  assert.equal((await run())('lead_key')?.code, 'lead_key_missing')
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\nDEEPSEEK_API_KEY=short\n`)
  assert.equal((await run())('lead_key')?.code, 'lead_key_import_failed')
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\nANTHROPIC_API_KEY=${key}\n`)
  assert.equal((await run())('lead_key')?.code, 'lead_key_file_invalid')
  rmSync(w.keyFile)
  assert.equal((await run())('lead_key')?.code, 'lead_key_file_unreadable')
  // The environment variable names the file first, as `start` does.
  const other = join(w.root, 'other.env')
  writeKeys(other, `ANTHROPIC_API_KEY=${key}\n`)
  check = await run({ GUANXI_PROVIDER_KEYS_FILE: other }); assert.equal(check('lead_key')?.status, 'ok'); assert.match(check('lead_key')!.summary, /GUANXI_PROVIDER_KEYS_FILE/)
  w.settings(config => { delete config.home.lead.providerKeysFile })
  check = await run(); assert.equal(check('lead_key')?.status, 'warn'); assert.equal(check('lead_key')?.code, 'lead_key_file_not_given')
  w.settings(config => { config.home.lead.auth = 'subscription'; delete config.home.lead.providerKeysFile; delete config.home.lead.effort })
  check = await run(); assert.equal(check('lead_key'), undefined); assert.equal(check('lead_auth')?.status, 'ok')
})

test('start imports the key into the node\'s vault, wires K5 to that connection with the effort, and puts the key nowhere else', async t => {
  const w = await pair(t)
  const key = fakeKey()
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\n`)
  const boot = (settings: Ms1LiveSettings) => start({ port: 0, host: '127.0.0.1', dataDir: join(w.root, 'data'), webDir: w.root, devOrigins: [], ms1Live: settings, connectionsKeychain: keychain })
  const first = await boot(w.settings())
  const connections = first.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const rows = connections.snapshot('local').connections
  assert.deepEqual(rows.map(row => row.name).sort(), ['anthropic (dotenv)', 'ms1-executor'], 'no subscription connection is created')
  const paying = rows.find(row => row.name === 'anthropic (dotenv)')!
  assert.deepEqual([paying.kind, paying.provider, paying.auth], ['model_api', 'anthropic', 'api_key'])
  assert.equal(first.ms1Live!.leadConnectionId, paying.id)
  const external = first.kernel.node.service<ExternalAgentService>(EXTERNAL_AGENT_SERVICE)!
  assert.deepEqual(external.capabilities('local').map(c => [c.adapter, c.connectionId]), [['claude-code', paying.id]])
  await assert.rejects(external.prepareLogin('local', 'local', paying.id), /api_or_local_required/)
  await first.close()
  // Restart with no file at all: the key is in the vault from the first import, so the same connection pays and nothing is re-imported.
  writeKeys(w.keyFile, 'UNRELATED=1\n')
  const second = await boot(w.settings(config => { delete config.home.lead.providerKeysFile }))
  assert.equal(second.ms1Live!.leadConnectionId, paying.id)
  await second.close()
  // The key is not in any file this node wrote (the vault holds it sealed under the wrapping key).
  const dataFiles = filesUnder(join(w.root, 'data'))
  assert.ok(dataFiles.length > 3)
  for (const path of dataFiles) assert.equal(readFileSync(path).includes(key), false, path)
})

test('start refuses, by code and field and without a value, when the lead\'s key cannot be found, imported or chosen', async t => {
  const w = await pair(t)
  const key = fakeKey()
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
  let n = 0
  const boot = (settings: Ms1LiveSettings) => start({ port: 0, host: '127.0.0.1', dataDir: join(w.root, `data${n++}`), webDir: w.root, devOrigins: [], ms1Live: settings, connectionsKeychain: keychain })
  const refuses = async (settings: Ms1LiveSettings, code: string, field: string) => {
    const outcome = await boot(settings).then(server => server.close().then(() => 'started'), error => error)
    assert.ok(outcome instanceof Ms1LiveError && outcome.code === code && outcome.field === field, `expected ${code}, got ${outcome instanceof Error ? outcome.message : outcome}`)
    assert.equal(String(outcome.message).includes(key), false)
  }
  // No file and an empty vault.
  await refuses(w.settings(config => { delete config.home.lead.providerKeysFile }), 'lead_key_missing', 'home.lead.providerKeysFile')
  // A file without the key, an OAuth token, and a file that fails to import as a whole: never a fallback to anything older.
  writeKeys(w.keyFile, `OPENAI_API_KEY=${'o'.repeat(40)}\n`)
  await refuses(w.settings(), 'lead_key_missing', 'home.lead.providerKeysFile')
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=sk-ant-oat01-${'b'.repeat(50)}\n`)
  await refuses(w.settings(), 'lead_key_import_failed', 'home.lead.providerKeysFile')
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\nDEEPSEEK_API_KEY=short\n`)
  await refuses(w.settings(), 'lead_key_import_failed', 'home.lead.providerKeysFile')
  assert.ok(warnings.length >= 2 && warnings.every(call => call.length === 1 && call[0] === 'provider_key_import_failed'), 'only the fixed code is logged')

  // Choosing the paying connection: by name, by id, ambiguity, a connection that is not an Anthropic key.
  writeKeys(w.keyFile, `ANTHROPIC_API_KEY=${key}\n`)
  const dataDir = join(w.root, 'shared')
  const run = (settings: Ms1LiveSettings) => start({ port: 0, host: '127.0.0.1', dataDir, webDir: w.root, devOrigins: [], ms1Live: settings, connectionsKeychain: keychain })
  const first = await run(w.settings())
  const connections = first.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const imported = connections.snapshot('local').connections.find(row => row.name === 'anthropic (dotenv)')!
  const second = connections.create('local', { name: 'second-anthropic', kind: 'model_api', provider: 'anthropic', auth: 'api_key' })
  await connections.saveSecret('local', second.id, fakeKey())
  await first.close()
  const attempt = async (connection: string | undefined, code: string | null, expected?: string) => {
    const settings = w.settings(config => { delete config.home.lead.providerKeysFile; if (connection === undefined) delete config.home.lead.connection; else config.home.lead.connection = connection })
    const outcome = await run(settings).then(async server => { const id = server.ms1Live!.leadConnectionId; await server.close(); return id }, error => error)
    if (code === null) assert.equal(outcome, expected)
    else assert.ok(outcome instanceof Ms1LiveError && outcome.code === code, `expected ${code}, got ${outcome instanceof Error ? outcome.message : outcome}`)
  }
  await attempt(undefined, 'lead_connection_ambiguous')
  await attempt('second-anthropic', null, second.id)
  await attempt(imported.id, null, imported.id)
  await attempt('no-such-connection', 'lead_connection_not_found')
  await attempt('ms1-executor', 'lead_connection_invalid')
})

test('the command explains a lead without a key by code, field and summary, and exits 2 with nothing left listening', async t => {
  const w = await pair(t)
  w.settings(config => { delete config.home.lead.providerKeysFile })
  const api = await freePort()
  const result = await cli(['start', '--config', join(w.home, 'ms1-live.json'), '--data-dir', join(w.root, 'data'), '--port', String(api), '--json'], { HOME: w.root })
  assert.equal(result.code, 2)
  const event = JSON.parse(result.out.split('\n').at(-1)!)
  assert.deepEqual([event.event, event.code, event.field], ['failed', 'lead_key_missing', 'home.lead.providerKeysFile'])
  assert.match(event.summary, /No Anthropic API key is available/)
  await assert.rejects(fetch(`http://127.0.0.1:${api}/api/health`), 'the owner API listener is closed')
})
