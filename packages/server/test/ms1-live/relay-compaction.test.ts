/** B3-c: `home.relayCompaction` is a benchmark-arm switch. It is absent by default, reaches the relay start host only when `naive`, and never appears for the executor role. */
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { start } from '../../src/index.ts'
import { loadMs1LiveConfig, Ms1LiveError, parseMs1LiveConfig, type Ms1LiveSettings } from '../../src/ms1-live/config.ts'
import { RELAY_SERVICE } from '../../src/relay/plugin.ts'
import { reserves } from '../relay/fixture.ts'
import { cli, freePort } from './live-world.ts'

const home = (extra: Record<string, unknown> = {}) => ({ version: 1, role: 'home', node: { identityFile: 'identity.json', privateKeyFile: 'node.key' },
  peer: { identityFile: 'peer.json', url: 'http://127.0.0.1:4562' }, listen: { federationPort: 4561 }, model: 'qwen3.8-27b', home: { alwaysOn: true, reserves, ...extra } })

test('home.relayCompaction is absent unless configured, and takes only the two named modes', () => {
  assert.equal(parseMs1LiveConfig(home(), '/etc/x/ms1-live.json').home!.relayCompaction, undefined)
  for (const mode of ['ledger', 'naive'] as const) assert.equal(parseMs1LiveConfig(home({ relayCompaction: mode }), '/etc/x/ms1-live.json').home!.relayCompaction, mode)
  for (const bad of ['summary', true, '']) {
    assert.throws(() => parseMs1LiveConfig(home({ relayCompaction: bad }), '/etc/x/ms1-live.json'),
      (error: unknown) => error instanceof Ms1LiveError && error.code === 'config_invalid' && error.field === 'home.relayCompaction', String(bad))
  }
})

async function pairing(t: { after(fn: () => unknown): void }): Promise<{ root: string; settings: Ms1LiveSettings }> {
  const root = await mkdtemp(join(tmpdir(), 'ms1-compaction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const [hp, hf, ep, ef] = [await freePort(), await freePort(), await freePort(), await freePort()]
  await cli(['init', '--role', 'home', '--dir', join(root, 'home'), '--port', String(hp), '--federation-port', String(hf), '--peer-federation-port', String(ef), '--json'])
  await cli(['init', '--role', 'executor', '--dir', join(root, 'exec'), '--port', String(ep), '--federation-port', String(ef), '--peer-federation-port', String(hf), '--llama-url', 'http://127.0.0.1:1', '--json'])
  await copyFile(join(root, 'exec', 'peer-offer.json'), join(root, 'home', 'peer.json')); await copyFile(join(root, 'home', 'peer-offer.json'), join(root, 'exec', 'peer.json'))
  return { root, settings: loadMs1LiveConfig(join(root, 'home', 'ms1-live.json')) }
}

test('the home reaches the relay start host with the default limits unless the mode is naive; a relayHost limit still overrides field by field', async t => {
  const limits = async (relayCompaction?: 'ledger' | 'naive', relayHost?: object) => {
    const { root, settings } = await pairing(t)
    const ms1Live = relayCompaction === undefined ? settings : { ...settings, home: { ...settings.home!, relayCompaction } }
    const server = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], ms1Live, ...(relayHost ? { relayHost } : {}) } as never)
    t.after(() => server.close())
    return (server.kernel.node.service<{ publicStarts: object }>(RELAY_SERVICE)!.publicStarts as unknown as { host: { limits: Record<string, unknown> } }).host.limits
  }
  assert.equal('compaction' in await limits(), false, 'the default host carries no compaction field at all')
  assert.equal('compaction' in await limits('ledger'), false, 'an explicit ledger is the default')
  assert.equal((await limits('naive')).compaction, 'naive')
  assert.equal((await limits('naive')).structuredOutput, true, 'the other limits are untouched')
  assert.equal((await limits('naive', { limits: { gateTimeoutMs: 1234 } })).gateTimeoutMs, 1234)
})

test('a naive home refuses a lead: the node-wide arm must not change a lead\'s delegations', () => {
  const lead = { adapter: 'claude-code', bridge: '/opt/bridge', bridgeVersion: '1.2.3', claudeExecutable: '/opt/claude',
    limits: { maxCaps: { cycles: 1, tokens: 1, moneyMicros: 0, wallMs: 1 }, maxDeadlineMs: 1 } }
  assert.doesNotThrow(() => parseMs1LiveConfig(home({ lead }), '/etc/x/ms1-live.json'))
  assert.doesNotThrow(() => parseMs1LiveConfig(home({ relayCompaction: 'ledger', lead }), '/etc/x/ms1-live.json'))
  assert.throws(() => parseMs1LiveConfig(home({ relayCompaction: 'naive', lead }), '/etc/x/ms1-live.json'),
    (error: unknown) => error instanceof Ms1LiveError && error.code === 'config_compaction_with_lead' && error.field === 'home.relayCompaction')
})

test('a programmatic relayHost limit with an unknown compaction mode refuses at boot, not at the first start', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ms1-compaction-boot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // If a mutant lets the boot through, the listener is closed so the test fails instead of hanging.
  const outcome = await start({ port: await freePort(), host: '127.0.0.1', dataDir: join(root, 'data'), webDir: root, devOrigins: [], relayHost: { limits: { compaction: 'summary' } } } as never)
    .then(server => server.close().then(() => 'started'), (error: unknown) => error)
  assert.ok(outcome instanceof Error && /relay_compaction_invalid/.test(outcome.message), String(outcome))
})
