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
  const [hp, ep] = [await freePort(), await freePort()]
  await cli(['init', '--role', 'home', '--dir', join(root, 'home'), '--port', String(hp), '--peer-port', String(ep), '--json'])
  await cli(['init', '--role', 'executor', '--dir', join(root, 'exec'), '--port', String(ep), '--peer-port', String(hp), '--llama-url', 'http://127.0.0.1:1', '--json'])
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
  assert.deepEqual(server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('local').connections, [], 'no connection is created behind the owner\'s back')
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
  await chmod(settings.node.privateKeyFile, 0o640)
  await mustRefuse(start({ ...base, dataDir: join(root, 'd5'), ms1Live: settings }), 'private_key_mode')
  await chmod(settings.node.privateKeyFile, 0o600)
  await copyFile(settings.node.identityFile, settings.peer.identityFile)
  await mustRefuse(start({ ...base, dataDir: join(root, 'd6'), ms1Live: settings }), 'peer_is_self')
  for (const name of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) await noData(join(root, name))
})

test('a home boots with its pairing: one unattended executor connection created once and the same one after a restart, and unsigned federation requests refused', async t => {
  const { root, settings } = await pairing(t)
  const dataDir = join(root, 'data')
  const first = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: root, devOrigins: [], ms1Live: settings })
  const connection = first.ms1Live!.connectionId
  const listed = first.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('local').connections
  assert.deepEqual(listed.map(c => [c.id, c.name, c.kind, c.unattended]), [[connection, 'ms1-executor', 'local_runtime', true]])
  assert.ok(first.kernel.federation, 'the federation service is on the returned kernel'); assert.equal(first.kernel.federation!.identity.id, first.ms1Live!.identity.id)
  const unsigned = await fetch(`${first.url}/api/federation/handshake`)
  assert.deepEqual([unsigned.status, await unsigned.json()], [401, { code: 'unauthenticated' }], 'an unsigned request is refused by the federation layer')
  await first.close()
  const second = await start({ port: await freePort(), host: '127.0.0.1', dataDir, webDir: root, devOrigins: [], ms1Live: settings })
  t.after(() => second.close())
  assert.equal(second.ms1Live!.connectionId, connection, 'the same connection, not a second one')
  assert.equal(second.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('local').connections.length, 1)
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
  assert.equal(live.role, 'executor'); assert.equal(live.warmState().state, 'warming')
  const settled = new Promise<string>(resolve => live.startWarming(state => resolve(`${state.state}:${state.code}`)))
  assert.equal(await settled, 'unavailable:runtime_meter_unavailable', 'nothing listens at the attach URL: reported, not hidden, not fatal')
  assert.equal((await fetch(`${server.url}/api/federation/handshake`)).status, 401)
  assert.deepEqual(server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.snapshot('owner').connections.map(c => c.name), ['ms1-executor'], 'the executor serves under its federation account')
})

test('the executor attests exactly its one configured model to the dispatch layer, the home attests none and serves no relay runtime', async t => {
  const a = await pairing(t, 'executor')
  const executor = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(a.root, 'data'), webDir: a.root, devOrigins: [], ms1Live: a.settings })
  t.after(() => executor.close())
  const dispatch = executor.ms1Live!.federationHost().dispatch!
  const attested = dispatch.localModel!('qwen3.8-27b')!
  assert.deepEqual({ ...attested, observedAt: typeof attested.observedAt }, { connectionId: executor.ms1Live!.connectionId, model: 'qwen3.8-27b', placement: 'installed_local', source: 'ms1-live attach configuration', observedAt: 'number' })
  assert.equal(dispatch.localModel!('qwen3.8-27b:latest')!.connectionId, attested.connectionId, 'the same model under its implicit tag')
  for (const other of ['some-other-model', 'qwen3.8-27b:cloud', 'qwen3.8-27b-q4', '']) assert.equal(dispatch.localModel!(other), null, `${other || '(empty)'} is not served here`)
  assert.ok(dispatch.relayRuntime, 'an attached llama-server is the relay runtime')

  const h = await pairing(t, 'home')
  const home = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(h.root, 'data'), webDir: h.root, devOrigins: [], ms1Live: h.settings })
  t.after(() => home.close())
  const homeDispatch = home.ms1Live!.federationHost().dispatch!
  assert.equal(homeDispatch.localModel, undefined, 'a home runs no model itself in this mode'); assert.equal(homeDispatch.relayRuntime, undefined)
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
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(settings.listen!.port, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())))
  const busy = await cli(['start', '--config', settings.file, '--data-dir', dataDir, '--json'])
  assert.equal(busy.code, 1); assert.deepEqual(JSON.parse(busy.out), { event: 'failed', code: 'port_in_use' })
  const needs = await cli(['start', '--config', settings.file, '--lead-prompt-file', join(root, 'p.txt')])
  assert.equal(needs.code, 2); assert.match(needs.err, /go together/)
  const noLead = await cli(['start', '--config', settings.file, '--lead-prompt-file', join(root, 'p.txt'), '--project', 'p'])
  assert.equal(noLead.code, 2); assert.match(noLead.err, /home\.lead section/)
  const body = (await import('node:fs')).readFileSync(settings.node.privateKeyFile, 'utf8').split('\n').filter(line => line && !line.startsWith('-----')).join('').slice(0, 30)
  for (const result of [bad, busy, needs, noLead]) assert.ok(!(result.out + result.err).includes(body))
})
