/** The plain boot is untouched, and a bad MS1 live configuration is a boot error before any file or listener exists. */
import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { FEDERATION_SERVICE } from '../../src/federation/plugin.ts'
import { start } from '../../src/index.ts'
import { loadMs1LiveConfig, Ms1LiveError, type Ms1LiveSettings } from '../../src/ms1-live/config.ts'
import { reserves } from '../relay/fixture.ts'
import { cli, freePort } from './live-world.ts'

async function dir(t: { after(fn: () => unknown): void }) {
  const path = await mkdtemp(join(tmpdir(), 'ms1-boot-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
async function pairing(t: { after(fn: () => unknown): void }, role: 'home' | 'executor' = 'home'): Promise<{ root: string; settings: Ms1LiveSettings; other: Ms1LiveSettings }> {
  const root = await dir(t)
  const [hp, hf, ep, ef] = [await freePort(), await freePort(), await freePort(), await freePort()]
  await cli(['init', '--role', 'home', '--dir', join(root, 'home'), '--port', String(hp), '--federation-port', String(hf), '--peer-federation-port', String(ef), '--json'])
  await cli(['init', '--role', 'executor', '--dir', join(root, 'exec'), '--port', String(ep), '--federation-port', String(ef), '--peer-federation-port', String(hf), '--llama-url', 'http://127.0.0.1:1', '--json'])
  await copyFile(join(root, 'exec', 'peer-offer.json'), join(root, 'home', 'peer.json')); await copyFile(join(root, 'home', 'peer-offer.json'), join(root, 'exec', 'peer.json'))
  const [home, exec] = [loadMs1LiveConfig(join(root, 'home', 'ms1-live.json')), loadMs1LiveConfig(join(root, 'exec', 'ms1-live.json'))]
  return { root, settings: role === 'home' ? home : exec, other: role === 'home' ? exec : home }
}
const noData = async (path: string) => assert.rejects(stat(path), { code: 'ENOENT' }, 'no data directory was created')
/** `start` must refuse; if a mutant lets it through, the listener is closed so the test fails instead of hanging. */
async function mustRefuse(boot: Promise<{ close(): Promise<void> }>, code: string) {
  const outcome = await boot.then(server => server.close().then(() => 'started'), error => error)
  assert.ok(outcome instanceof Ms1LiveError && outcome.code === code, `expected ${code}, got ${outcome instanceof Error ? outcome.message : outcome}`)
}
const refuses = (code: string) => (error: unknown) => error instanceof Ms1LiveError && error.code === code

test('without the option the boot is the plain one: no federation node, no pairing connection, no federation route, the stock relay refusal', async t => {
  const root = await dir(t)
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [] })
  t.after(() => server.close())
  assert.equal(server.ms1Live, null); assert.equal(server.kernel.federation, null)
  assert.equal(server.kernel.node.service(FEDERATION_SERVICE), undefined, 'the federation plugin is not loaded')
  assert.deepEqual(server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('local').connections.map(row => [row.name, row.kind, row.provider, row.auth]), [['Ollama', 'local_runtime', 'ollama', 'none']], 'only the stock local Ollama connection is created behind the owner\'s back')
  const handshake = await fetch(`${server.url}/api/federation/handshake`)
  assert.equal(handshake.status, 404, 'there is no federation route to authenticate against')
  const relay = await fetch(`${server.url}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k', projectId: 'p', connectionId: 'c', model: 'm', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base: 'a'.repeat(40), goal: 'g', items: [{ id: 'one', title: 'one', dependsOn: [], acceptance: ['true'], protectedPaths: [] }], protectedPaths: [] }, caps: { cycles: 1, tokens: 1000, wallMs: 1000, moneyMicros: null } }) })
  assert.deepEqual([relay.status, await relay.json()], [503, { code: 'runtime_meter_unavailable' }])
  assert.deepEqual((await readdir(join(root, 'data'))).filter(name => /relay-checkouts|federation/.test(name)), [])
  assert.equal(server.context.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'federation%' OR name LIKE 'remote_%'").get()!.n, 0, 'no federation tables')
})

test('configuration problems are boot errors raised before any file, database or listener exists', async t => {
  const { root, settings } = await pairing(t)
  const base = { port: 0, host: '127.0.0.1', webDir: root, devOrigins: [] }
  await mustRefuse(start({ ...base, dataDir: join(root, 'd1'), ms1Live: settings, federation: { identity: { id: 'x', accountId: 'a', publicKey: 'k', trust: 'owner_device', admin: false, scopes: [] }, privateKey: 'k' } }), 'option_conflict')
  await mustRefuse(start({ ...base, dataDir: join(root, 'd2'), ms1Live: settings, relay: { runtime: { maximumAgeMs: 1 }, reserves } }), 'option_conflict')
  await mustRefuse(start({ ...base, dataDir: join(root, 'd3'), ms1Live: settings, host: '0.0.0.0' }), 'listen_not_loopback')
  await mustRefuse(start({ ...base, dataDir: join(root, 'd4'), ms1Live: settings, host: '192.168.1.5' }), 'listen_not_loopback')
  // One exact address: the Host allowlist, the forward's far end and the doctor all assume 127.0.0.1.
  for (const [i, host] of ['localhost', '::1', '[::1]', '127.0.0.2'].entries()) await mustRefuse(start({ ...base, dataDir: join(root, `h${i}`), ms1Live: settings, host }), 'listen_not_loopback')
  await mustRefuse(start({ ...base, dataDir: join(root, 'd7'), ms1Live: settings, port: settings.listen.federationPort }), 'ports_collide')
  const lead = { adapter: 'claude-code' as const, bridge: '/x/bridge', bridgeVersion: '1.0.0', claudeExecutable: '/x/claude', billingAccount: 'b', model: 'default', auth: 'subscription' as const, domains: [],
    limits: { maxCaps: { cycles: 1, tokens: 1, moneyMicros: 1, wallMs: 1 }, maxDeadlineMs: 1, allowDetach: false } }
  await mustRefuse(start({ ...base, dataDir: join(root, 'd8'), ms1Live: { ...settings, home: { ...settings.home!, lead } }, externalAgents: { nodeId: 'n', installations: [] } }), 'option_conflict')
  await mustRefuse(start({ ...base, dataDir: join(root, 'd9'), ms1Live: { ...settings, model: 'fixture:cloud' } }), 'model_invalid')
  await chmod(settings.node.privateKeyFile, 0o640)
  await mustRefuse(start({ ...base, dataDir: join(root, 'd5'), ms1Live: settings }), 'private_key_mode')
  await chmod(settings.node.privateKeyFile, 0o600)
  await copyFile(settings.node.identityFile, settings.peer.identityFile)
  await mustRefuse(start({ ...base, dataDir: join(root, 'd6'), ms1Live: settings }), 'peer_is_self')
  for (const name of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'h0', 'h1', 'h2', 'h3']) await noData(join(root, name))
})

test('a home boots with its pairing: one unattended executor connection created once and the same one after a restart, and unsigned federation requests refused', async t => {
  const { root, settings } = await pairing(t)
  const dataDir = join(root, 'data')
  const first = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: root, devOrigins: [], ms1Live: settings })
  const connection = first.ms1Live!.connectionId
  const listed = first.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('local').connections
  assert.deepEqual(listed.filter(c => c.name !== 'Ollama').map(c => [c.id, c.name, c.kind, c.unattended]), [[connection, 'ms1-executor', 'local_runtime', true]])
  assert.deepEqual(listed.filter(c => c.name === 'Ollama').map(c => [c.kind, c.provider, c.auth]), [['local_runtime', 'ollama', 'none']])
  assert.ok(first.kernel.federation, 'the federation service is on the returned kernel'); assert.equal(first.kernel.federation!.identity.id, first.ms1Live!.identity.id)
  const federationUrl = `http://127.0.0.1:${settings.listen.federationPort}`
  const unsigned = await fetch(`${federationUrl}/api/federation/handshake`)
  assert.deepEqual([unsigned.status, await unsigned.json()], [401, { code: 'unauthenticated' }], 'an unsigned request is refused by the federation layer')
  await first.close()
  await assert.rejects(fetch(`${federationUrl}/api/federation/handshake`), 'the federation listener is closed with the node')
  const second = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => second.close())
  assert.equal(second.ms1Live!.connectionId, connection, 'the same connection, not a second one')
  assert.equal(second.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('local').connections.length, 2, 'the stock Ollama connection and the one executor connection')
})

test('a data directory belongs to one identity: booting it with another node\'s identity fails loudly instead of silently re-pairing', async t => {
  const a = await pairing(t), b = await pairing(t)
  const dataDir = join(a.root, 'data')
  const first = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: a.root, devOrigins: [], ms1Live: a.settings })
  await first.close()
  await assert.rejects(start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: a.root, devOrigins: [], ms1Live: b.settings }), (error: unknown) => (error as { code?: string }).code === 'local_identity_changed')
})

test('an executor with no llama-server behind its attach URL stays up, reports the model as unavailable, and serves under its federation account', async t => {
  const { root, settings } = await pairing(t, 'executor')
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  const live = server.ms1Live!
  assert.equal(live.role, 'executor')
  const settled = await live.startWarming()
  assert.deepEqual([settled.state, settled.code], ['unavailable', 'runtime_meter_unavailable'], 'nothing listens at the attach URL: reported, not hidden, not fatal')
  assert.equal(await live.startWarming(), settled, 'warming is started once')
  assert.equal((await fetch(`http://127.0.0.1:${settings.listen.federationPort}/api/federation/handshake`)).status, 401)
  assert.deepEqual(server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('owner').connections.map(c => c.name), ['ms1-executor'], 'the executor serves under its federation account')
})

test('the executor attests exactly its one configured model to the dispatch layer, the home attests none and serves no relay runtime', async t => {
  const a = await pairing(t, 'executor')
  const executor = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(a.root, 'data'), webDir: a.root, devOrigins: [], ms1Live: a.settings })
  t.after(() => executor.close())
  const live = executor.ms1Live!
  const attested = live.attestedModel('qwen3.8-27b-iq3s')!
  assert.deepEqual({ ...attested, observedAt: typeof attested.observedAt }, { connectionId: executor.ms1Live!.connectionId, model: 'qwen3.8-27b-iq3s', placement: 'installed_local', source: 'ms1-live attach configuration (asserted when asked, not observed)', observedAt: 'number' })
  assert.equal(live.attestedModel('qwen3.8-27b-iq3s:latest')!.connectionId, attested.connectionId, 'the same model under its implicit tag')
  for (const other of ['some-other-model', 'qwen3.8-27b-iq3s:cloud', 'qwen3.8-27b', 'qwen3.8-27b-iq3s-q4', '']) assert.equal(live.attestedModel(other), null, `${other || '(empty)'} is not served here`)
  assert.ok(executor.kernel.federation!.capabilities().includes('remote-relay-runtime-v1'), 'an attached llama-server is the relay runtime')

  const h = await pairing(t, 'home')
  const home = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(h.root, 'data'), webDir: h.root, devOrigins: [], ms1Live: h.settings })
  t.after(() => home.close())
  assert.equal(home.ms1Live!.attestedModel('qwen3.8-27b-iq3s'), null, 'a home runs no model itself in this mode')
  assert.ok(home.kernel.federation!.attemptDispatch, 'but it can dispatch')
  assert.ok(!home.kernel.federation!.capabilities().includes('remote-relay-runtime-v1'), 'and does not advertise the relay runtime')
  assert.ok(executor.kernel.federation!.capabilities().includes('remote-relay-runtime-v1'))
})

test('start through the command: a bad configuration exits 2 without a data directory, an occupied port exits 1 naming the port, and neither prints a key', async t => {
  const { root, settings } = await pairing(t)
  const dataDir = join(root, 'cli-data')
  const bad = await cli(['start', '--config', join(root, 'absent.json'), '--data-dir', dataDir, '--json'])
  assert.equal(bad.code, 2); assert.equal(JSON.parse(bad.out).error.code, 'config_unreadable'); await noData(dataDir)
  const { createServer } = await import('node:net')
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(settings.listen.port!, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())))
  // The port is named explicitly: an ambient GUANXI_API_PORT (every lane sets one) would otherwise win over the configuration.
  const busy = await cli(['start', '--config', settings.file, '--data-dir', dataDir, '--port', String(settings.listen.port), '--json'])
  assert.equal(busy.code, 1); assert.deepEqual(JSON.parse(busy.out), { event: 'failed', code: 'port_in_use' })
  const needs = await cli(['start', '--config', settings.file, '--lead-prompt-file', join(root, 'p.txt')])
  assert.equal(needs.code, 2); assert.match(needs.err, /go together/)
  const noLead = await cli(['start', '--config', settings.file, '--lead-prompt-file', join(root, 'p.txt'), '--project', 'p'])
  assert.equal(noLead.code, 2); assert.match(noLead.err, /home\.lead section/)
  const body = (await import('node:fs')).readFileSync(settings.node.privateKeyFile, 'utf8').split('\n').filter(line => line && !line.startsWith('-----')).join('').slice(0, 30)
  for (const result of [bad, busy, needs, noLead]) assert.ok(!(result.out + result.err).includes(body))
})

test('the federation listener carries the signed API and nothing else, and the owner API does not carry federation: only the first is ever forwarded', async t => {
  const { root, settings } = await pairing(t)
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  const federation = `http://127.0.0.1:${settings.listen.federationPort}`
  for (const [method, path] of [['GET', '/api/workspaces'], ['GET', '/api/projects'], ['POST', '/api/relay'], ['GET', '/api/connections'], ['GET', '/api/agent/projects'], ['GET', '/api/health'], ['GET', '/'], ['GET', '/api/federationx/handshake']] as const) {
    const response = await fetch(federation + path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })
    assert.deepEqual([response.status, await response.json()], [404, { code: 'not_found' }], `${method} ${path} is not served on the federation port`)
  }
  for (const [method, path] of [['GET', '/api/workspaces'], ['GET', '/api/health']] as const) assert.equal((await fetch(server.url + path, { method })).status, 200, `${path} is served on the owner API`)
  const onOwner = await fetch(`${server.url}/api/federation/handshake`)
  assert.deepEqual([onOwner.status, (await onOwner.json() as { code: string }).code], [404, 'internal_error'], 'federation is not mounted on the owner API')
  // The peer's DNS-rebinding guard applies to the federation listener too: its Host must be one of this node's own authorities.
  const { request } = await import('node:http')
  const host = await new Promise<number>(resolve => { const r = request({ host: '127.0.0.1', port: settings.listen.federationPort, path: '/api/federation/handshake', headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode!) }); r.end() })
  assert.equal(host, 403)
})

test('an occupied federation port fails the start and releases everything: the owner API port is free again and the same node boots once the port is', async t => {
  const { root, settings } = await pairing(t)
  const { createServer } = await import('node:net')
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(settings.listen.federationPort, '127.0.0.1', resolve))
  const api = await freePort()
  const options = { port: api, host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings }
  await assert.rejects(start(options), (error: unknown) => (error as { code?: string }).code === 'EADDRINUSE')
  await new Promise<void>(resolve => occupied.close(() => resolve()))
  const server = await start(options)
  t.after(() => server.close())
  assert.equal(server.port, api, 'the owner API port was released by the failed start'); assert.equal(server.ms1Live!.connectionId.length > 0, true)
})

test('the pairing\'s connection is refused loudly when the data directory already has a conflicting one or the policy forbids unattended access', async t => {
  const { root, settings } = await pairing(t)
  const base = { host: '127.0.0.1', webDir: root, devOrigins: [] }
  const plain = await start({ ...base, port: await freePort(), dataDir: join(root, 'conflict') })
  plain.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.create('local', { name: 'ms1-executor', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: false })
  await plain.close()
  await assert.rejects(start({ ...base, port: await freePort(), dataDir: join(root, 'conflict'), ms1Live: settings }), refuses('connection_conflict'))
  await assert.rejects(start({ ...base, port: await freePort(), dataDir: join(root, 'policy'), ms1Live: settings, connectionsPolicy: { ownerDevice: true, nodeKeyOptIn: false } }), refuses('unattended_unavailable'))
  // Both refusals released their listeners: the same ports serve a correct start.
  const ok = await start({ ...base, port: await freePort(), dataDir: join(root, 'fresh'), ms1Live: settings })
  await ok.close()
})

test('an executor restarted on its data directory reuses its connection, and closing it while it hashes the model does not wait for the hash', async t => {
  const { mkdirSync, truncateSync, writeFileSync } = await import('node:fs')
  const { startFakeLlama } = await import('../fixtures/fake-llama-server.ts')
  const { root, settings } = await pairing(t, 'executor')
  // A sparse 8 GiB "model": hashing it takes seconds, and the fake server reports it as its model file.
  mkdirSync(join(root, 'model'), { recursive: true })
  const modelPath = join(root, 'model', 'big.gguf'); writeFileSync(modelPath, ''); truncateSync(modelPath, 8 * 1024 ** 3)
  const fake = await startFakeLlama({ alias: 'qwen3.8-27b-iq3s', modelPath, nCtx: 16000 })
  t.after(() => fake.close())
  const live = { ...settings, executor: { llamaServer: { baseUrl: fake.url } } }
  const dataDir = join(root, 'data')
  const first = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: root, devOrigins: [], ms1Live: live })
  const connection = first.ms1Live!.connectionId
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(first.ms1Live!.warmState().state, 'warming', 'the hash is in progress')
  const began = Date.now()
  await first.close()
  assert.ok(Date.now() - began < 2500, `closing took ${Date.now() - began} ms: it waited for the hash`)
  const second = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: root, devOrigins: [], ms1Live: live })
  t.after(() => second.close())
  assert.equal(second.ms1Live!.connectionId, connection, 'the same connection after a restart')
  assert.equal(second.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('owner').connections.length, 1)
})

test('start through the command with a lead that cannot be set up returns 1 and closes the node it started: no listener is left behind', async t => {
  const { root, settings } = await pairing(t)
  const { writeFileSync, readFileSync } = await import('node:fs')
  const config = JSON.parse(readFileSync(settings.file, 'utf8'))
  config.home.lead = { adapter: 'claude-code', bridge: join(root, 'bridge'), bridgeVersion: '1.0.0', claudeExecutable: join(root, 'absent-claude'), limits: { maxCaps: { cycles: 1, tokens: 1, moneyMicros: 1, wallMs: 1 }, maxDeadlineMs: 1 } }
  writeFileSync(settings.file, JSON.stringify(config))
  const api = await freePort()
  const result = await cli(['start', '--config', settings.file, '--data-dir', join(root, 'data'), '--port', String(api), '--json'])
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.out.split('\n').at(-1)!).event, 'failed')
  await assert.rejects(fetch(`http://127.0.0.1:${api}/api/health`), 'the owner API listener is closed')
  await assert.rejects(fetch(`http://127.0.0.1:${settings.listen.federationPort}/api/federation/handshake`), 'and so is the federation listener')
})

test('the relay host and plugin accept extra trusted fields (the seam for a judge source) without letting them replace the derived ones', async t => {
  const { root, settings } = await pairing(t)
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings,
    relayHost: { limits: { gateTimeoutMs: 1234 } } })
  t.after(() => server.close())
  const { RELAY_SERVICE } = await import('../../src/relay/plugin.ts')
  const host = (server.kernel.node.service<{ publicStarts: object }>(RELAY_SERVICE)!.publicStarts as unknown as { host: { limits: { gateTimeoutMs: number }; runtime?: unknown; allocate?: unknown; reserves?: unknown } }).host
  assert.equal(host.limits.gateTimeoutMs, 1234, 'a field passed through relayHost reaches the relay start host')
  assert.ok(host.runtime && host.allocate && host.reserves, 'the pairing\'s runtime, allocator and reserves are still the home\'s own')
})

test('home.structuredOutput reaches the relay start host (on by default, off when configured) and a relayHost limit overrides it field by field', async t => {
  const limits = async (structuredOutput?: boolean, relayHost?: object) => {
    const { root, settings } = await pairing(t)
    const ms1Live = structuredOutput === undefined ? settings : { ...settings, home: { ...settings.home!, structuredOutput } }
    const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live, ...(relayHost ? { relayHost } : {}) } as never)
    t.after(() => server.close())
    const { RELAY_SERVICE } = await import('../../src/relay/plugin.ts')
    return (server.kernel.node.service<{ publicStarts: object }>(RELAY_SERVICE)!.publicStarts as unknown as { host: { limits: { structuredOutput: boolean; gateTimeoutMs: number } } }).host.limits
  }
  assert.equal((await limits()).structuredOutput, true)
  const disabled = await limits(false)
  assert.equal(disabled.structuredOutput, false); assert.equal(disabled.gateTimeoutMs, 120_000, 'the other limits keep their defaults')
  const merged = await limits(false, { limits: { gateTimeoutMs: 1234 } })
  assert.deepEqual([merged.structuredOutput, merged.gateTimeoutMs], [false, 1234])
})

test('device enrollment is not served on the federation listener: an unsigned caller cannot write enrollment rows', async t => {
  const { root, settings } = await pairing(t)
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  const federation = `http://127.0.0.1:${settings.listen.federationPort}`
  const { readFileSync } = await import('node:fs')
  const publicKey = (JSON.parse(readFileSync(settings.node.identityFile, 'utf8')) as { identity: { publicKey: string } }).identity.publicKey
  for (const [path, body] of [['/api/federation/device/code', { publicKey }], ['/api/federation/device/token', { device_code: 'x' }]] as const) {
    const response = await fetch(federation + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.deepEqual([response.status, await response.json()], [404, { code: 'not_found' }], path)
  }
  assert.equal(server.context.db.prepare('SELECT COUNT(*) n FROM federation_devices').get()!.n, 0, 'no enrollment row was written')
  // The signed API is still there: an unsigned request is refused by authentication, not by routing.
  assert.equal((await fetch(`${federation}/api/federation/handshake`)).status, 401)
})

test('an MS1 node accepts only counted dispatch grants: an uncounted (plain chat) job is refused before authentication, a counted one reaches it', async t => {
  const { root, settings } = await pairing(t, 'executor')
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  const url = `http://127.0.0.1:${settings.listen.federationPort}/api/federation/attempts/dispatch`
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const job = { kind: 'local_inference', model: 'm', context: 100, outputTokens: 10, deadline: 1, messages: [{ role: 'user', content: 'hi' }] }
  for (const body of [{ grant: { job } }, { grant: {} }, {}, 'not json', { grant: { job: { ...job, counted: null } } }]) {
    const response = await post(body)
    assert.deepEqual([response.status, await response.json()], [403, { code: 'uncounted_refused' }], JSON.stringify(body))
  }
  const counted = await post({ grant: { job: { ...job, counted: { contentSha256: 'a'.repeat(64), renderedSha256: 'b'.repeat(64), tokens: 5, digest: 'd', contextTokens: 100 } } } })
  assert.equal(counted.status, 401, 'a counted grant is judged by authentication')
})

test('the pairing\'s connection serves relay calls through a transport only: a plain local chat on it is refused instead of silently using the node\'s own Ollama', async t => {
  const { root, settings } = await pairing(t)
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  const connections = server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const request = { model: 'ms1-guard-probe', messages: [{ role: 'user' as const, content: 'hi' }], options: { num_ctx: 1000, num_predict: 10 } }
  await assert.rejects(connections.localChat('local', server.ms1Live!.connectionId, request, { runId: 'r', requestId: 'q' }),
    (error: unknown) => (error as { code?: string }).code === 'policy_denied', 'refused before any Ollama request')
  await assert.rejects(connections.localChat('local', server.ms1Live!.connectionId, request, { runId: 'r', requestId: 'q', background: true }),
    (error: unknown) => (error as { code?: string }).code === 'policy_denied')
  // Another local-runtime connection of the owner is untouched by the guard.
  const other = connections.create('local', { name: 'my ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: false })
  await assert.rejects(connections.localChat('local', other.id, request, { runId: 'r', requestId: 'q' }), (error: unknown) => (error as { code?: string }).code !== 'policy_denied')
})

test('closing an executor with a signed observe in flight during a model hash does not wait for the hash', async t => {
  const { mkdirSync, truncateSync, writeFileSync } = await import('node:fs')
  const { startFakeLlama } = await import('../fixtures/fake-llama-server.ts')
  const { FederationChannel } = await import('../../src/federation/channel.ts')
  const { readCredentials } = await import('../../src/ms1-live/identity.ts')
  const { loopbackTransport } = await import('../../src/ms1-live/transport.ts')
  const { root, settings, other } = await pairing(t, 'executor')
  mkdirSync(join(root, 'model'), { recursive: true })
  const modelPath = join(root, 'model', 'big.gguf'); writeFileSync(modelPath, ''); truncateSync(modelPath, 8 * 1024 ** 3)
  const fake = await startFakeLlama({ alias: 'qwen3.8-27b-iq3s', modelPath, nCtx: 16000 })
  t.after(() => fake.close())
  const live = { ...settings, executor: { llamaServer: { baseUrl: fake.url } } }
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: live })
  // The home's signed observe, exactly as the relay sends it, arrives while the file is being hashed.
  const home = readCredentials(other)
  const channel = new FederationChannel({ local: home.local.identity, privateKey: home.local.privateKey, peer: home.peer,
    transport: loopbackTransport({ base: `http://127.0.0.1:${settings.listen.federationPort}`, timeoutMs: 60_000, messageTimeoutMs: 60_000 }) })
  const observing = channel.relayObserve({ binding: { homeNodeId: home.local.identity.id, executorNodeId: home.peer.id, model: live.model, run: null }, challenge: 'c1' }).then(() => 'answered', () => 'refused')
  await new Promise(resolve => setTimeout(resolve, 400))
  const began = Date.now()
  await server.close()
  assert.ok(Date.now() - began < 2500, `closing took ${Date.now() - began} ms: it waited for the hash and the open request`)
  assert.equal(await observing, 'refused', 'the in-flight request was ended, not answered from a closed node')
})

test('live mode never falls back to ~/.guanxi: without a data directory it uses <config dir>/data, and the default home directory is refused', async t => {
  const { existsSync } = await import('node:fs')
  const { root, settings } = await pairing(t)
  const saved = { HOME: process.env['HOME'], dir: process.env['GUANXI_DATA_DIR'] }
  const fakeHome = join(root, 'fake-home')
  process.env['HOME'] = fakeHome; delete process.env['GUANXI_DATA_DIR']
  t.after(() => { process.env['HOME'] = saved.HOME; if (saved.dir === undefined) delete process.env['GUANXI_DATA_DIR']; else process.env['GUANXI_DATA_DIR'] = saved.dir })
  await mustRefuse(start({ port: await freePort(), host: '127.0.0.1', webDir: root, devOrigins: [], ms1Live: settings, dataDir: join(fakeHome, '.guanxi') }), 'data_dir_default')
  assert.equal(existsSync(join(fakeHome, '.guanxi')), false, 'nothing was created there')
  const server = await start({ port: await freePort(), host: '127.0.0.1', webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  assert.equal(existsSync(join(root, 'home', 'data', 'guanxi.db')), true, 'the node lives beside its configuration')
  assert.equal(existsSync(join(fakeHome, '.guanxi')), false, 'and not in the default home directory')
})

test('relayHost cannot replace what start owns, even from untyped code: runtime, allocator, reserves, project resolution and node ports are stripped', async t => {
  const root = await dir(t)
  const sentinel = { sentinel: true }
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [],
    relayHost: { limits: { gateTimeoutMs: 4321 }, runtime: sentinel, allocate: sentinel, reserves: sentinel, project: sentinel, nodePorts: sentinel } as never })
  t.after(() => server.close())
  const { RELAY_SERVICE } = await import('../../src/relay/plugin.ts')
  const host = (server.kernel.node.service<{ publicStarts: object }>(RELAY_SERVICE)!.publicStarts as unknown as { host: Record<string, unknown> & { limits: { gateTimeoutMs: number } } }).host
  assert.equal(host.limits.gateTimeoutMs, 4321, 'a permitted extra passes')
  assert.equal(host['runtime'], undefined); assert.equal(host['allocate'], undefined); assert.equal(host['reserves'], undefined)
  assert.notEqual(host['project'], sentinel); assert.notEqual(host['nodePorts'], sentinel)
})


test('what start returns for an MS1 node is a read-only view: no key, no federation host options, no way back to either', async t => {
  const { readFileSync } = await import('node:fs')
  const { root, settings } = await pairing(t)
  const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => server.close())
  const view = server.ms1Live as unknown as Record<string, unknown>
  for (const name of ['federationHost', 'homeRelay', 'leadWiring', 'prepare', 'peerChannel', 'privateKey', 'settings']) assert.equal(view[name], undefined, name)
  assert.ok(Object.isFrozen(view))
  const key = readFileSync(settings.node.privateKeyFile, 'utf8').split('\n').filter(line => line && !line.startsWith('-----')).join('').slice(0, 30)
  const reachable = new Set<string>()
  const walk = (value: unknown, depth: number) => { if (depth > 4 || value === null || typeof value !== 'object' && typeof value !== 'function') return; for (const name of Reflect.ownKeys(value as object)) { reachable.add(String(name)); try { walk((value as Record<string | symbol, unknown>)[name], depth + 1) } catch { /* getter */ } } }
  walk(view, 0)
  assert.ok(!JSON.stringify(view).includes(key), 'no key in the view')
  assert.ok(!reachable.has('privateKey') && !reachable.has('federationHost'), 'nothing named a key or the host options is reachable from it')
  assert.equal(server.ms1Live!.role, 'home'); assert.ok(server.ms1Live!.identity.id)
})
