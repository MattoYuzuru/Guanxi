import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { thresholds } from '../../src/relay/budget.ts'
import { loadMs1LiveConfig, loopbackBase, ms1LiveFromEnv, MS1_LIVE_CONFIG_ENV, Ms1LiveError, parseMs1LiveConfig } from '../../src/ms1-live/config.ts'
import { cli } from './live-world.ts'

const reserves = { turn: 4096, safety: 512, handoff: 3072, tool: 3072, stepMedian: 1536, effective: 24000 }
const home = (overrides: Record<string, unknown> = {}) => ({ version: 1, role: 'home', node: { identityFile: 'identity.json', privateKeyFile: 'node.key' },
  peer: { identityFile: 'peer.json', url: 'http://127.0.0.1:4552' }, model: 'qwen3.8-27b', home: { alwaysOn: true, reserves }, ...overrides })
const executor = (overrides: Record<string, unknown> = {}) => ({ version: 1, role: 'executor', node: { identityFile: 'identity.json', privateKeyFile: 'node.key' },
  peer: { identityFile: 'peer.json', url: 'http://127.0.0.1:4551' }, model: 'qwen3.8-27b', executor: { llamaServer: { baseUrl: 'http://127.0.0.1:8090' } }, ...overrides })
const refused = (raw: unknown, code: string, field: string | null) => assert.throws(() => parseMs1LiveConfig(raw, '/etc/x/ms1-live.json'),
  (error: unknown) => error instanceof Ms1LiveError && error.code === code && error.field === field, `${code} at ${field}`)

test('a valid home and executor configuration parse, with every path absolute and link timing defaulted from named policy', () => {
  const h = parseMs1LiveConfig(home(), '/etc/x/ms1-live.json')
  assert.equal(h.node.privateKeyFile, '/etc/x/node.key'); assert.equal(h.peer.identityFile, '/etc/x/peer.json'); assert.equal(h.peer.url, 'http://127.0.0.1:4552')
  assert.deepEqual(h.link, { requestTimeoutMs: 900_000, holderTtlMs: 30_000, safetyMs: 2_000, maxModelAgeMs: 60_000, maxReservationMs: 120_000 })
  assert.equal(h.home!.maximumAgeMs, 60_000); assert.equal(h.home!.checkoutRoot, undefined)
  const e = parseMs1LiveConfig(executor({ node: { identityFile: '/abs/id.json', privateKeyFile: '../key' } }), '/etc/x/ms1-live.json')
  assert.equal(e.node.identityFile, '/abs/id.json'); assert.equal(e.node.privateKeyFile, '/etc/key')
  assert.equal(e.executor!.llamaServer.baseUrl, 'http://127.0.0.1:8090')
})

test('the configuration is strict: unknown keys, wrong roles and missing sections are refused by field, never echoing the value', () => {
  refused(home({ privateKey: '-----BEGIN PRIVATE KEY-----SECRETSECRETSECRET' }), 'config_unknown_key', null)
  refused(home({ node: { identityFile: 'a', privateKeyFile: 'b', privateKeyPem: 'SECRETSECRET' } }), 'config_unknown_key', 'node')
  refused(home({ home: undefined }), 'config_section_required', 'home')
  refused(executor({ executor: undefined }), 'config_section_required', 'executor')
  refused(home({ executor: { llamaServer: { baseUrl: 'http://127.0.0.1:1' } } }), 'config_section_not_for_role', 'executor')
  refused(home({ role: 'both' }), 'config_invalid', 'role')
  refused(home({ version: 2 }), 'config_invalid', 'version')
  refused(home({ home: { reserves, alwaysOn: false } }), 'config_invalid', 'home.alwaysOn')
  refused(home({ home: { alwaysOn: true } }), 'config_invalid', 'home.reserves')
  refused(home({ home: { alwaysOn: true, reserves: { ...reserves, effective: 0 } } }), 'config_invalid', 'home.reserves.effective')
  refused(home({ link: { holderTtlMs: 1000, safetyMs: 500 } }), 'config_safety_too_large', 'link.safetyMs')
  refused(home({ link: { holderTtlMs: -1 } }), 'config_invalid', 'link.holderTtlMs')
  try { parseMs1LiveConfig(home({ model: 12345678 }), '/x/c.json') } catch (error) { assert.ok(!String((error as Error).message).includes('12345678')) }
  try { parseMs1LiveConfig(home({ privateKey: 'SECRETVALUE' }), '/x/c.json') } catch (error) { assert.ok(!String((error as Error).message).includes('SECRETVALUE')) }
})

test('only http loopback addresses with an explicit port are accepted anywhere an address is configured', () => {
  for (const bad of ['http://10.0.0.5:4552', 'http://fedora:4552', 'https://127.0.0.1:4552', 'http://127.0.0.1', 'http://0.0.0.0:4552', 'http://user:pw@127.0.0.1:4552',
    'http://127.0.0.1:4552/path', 'http://127.0.0.1:4552/?q=1', 'ssh://127.0.0.1:22', 'not a url', 'http://[::1]x:1']) {
    refused(home({ peer: { identityFile: 'p', url: bad } }), 'config_url_not_loopback', 'peer.url')
    refused(executor({ executor: { llamaServer: { baseUrl: bad } } }), 'config_url_not_loopback', 'executor.llamaServer.baseUrl')
    assert.throws(() => loopbackBase(bad, 'x'), (error: unknown) => error instanceof Ms1LiveError && /^url_/.test(error.code))
  }
  for (const good of ['http://127.0.0.1:4552', 'http://localhost:4552', 'http://[::1]:4552', 'http://127.0.0.1:4552/']) assert.ok(loopbackBase(good, 'x').startsWith('http://'))
})

test('a lead needs every owner ceiling, an absolute-path-ready bridge and an exact version; the home must assert it stays awake', () => {
  const lead = { adapter: 'claude-code', bridge: '/x/claude-agent-acp', bridgeVersion: '0.94.0', claudeExecutable: '/x/claude',
    limits: { maxCaps: { cycles: 40, tokens: 2_000_000, moneyMicros: 500_000, wallMs: 3_600_000 }, maxDeadlineMs: 86_400_000 } }
  const ok = parseMs1LiveConfig(home({ home: { alwaysOn: true, reserves, lead } }), '/x/c.json').home!.lead!
  assert.equal(ok.billingAccount, 'claude-code-account'); assert.equal(ok.model, 'default'); assert.equal(ok.limits.allowDetach, false); assert.deepEqual(ok.domains, [])
  refused(home({ home: { alwaysOn: true, reserves, lead: { ...lead, bridgeVersion: 'latest' } } }), 'config_invalid', 'home.lead.bridgeVersion')
  refused(home({ home: { alwaysOn: true, reserves, lead: { ...lead, limits: { maxDeadlineMs: 1, maxCaps: { cycles: 1, tokens: 1, wallMs: 1 } } } } }), 'config_invalid', 'home.lead.limits.maxCaps.moneyMicros')
  refused(home({ home: { alwaysOn: true, reserves, lead: { ...lead, adapter: 'codex' } } }), 'config_invalid', 'home.lead.adapter')
})

test('loading reads one file by path; the environment variable is the only switch and unset means the plain boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms1-config-'))
  try {
    assert.equal(ms1LiveFromEnv({}), undefined); assert.equal(ms1LiveFromEnv({ [MS1_LIVE_CONFIG_ENV]: '' }), undefined)
    assert.throws(() => loadMs1LiveConfig(join(dir, 'absent.json')), (error: unknown) => error instanceof Ms1LiveError && error.code === 'config_unreadable')
    writeFileSync(join(dir, 'bad.json'), '{not json'); assert.throws(() => loadMs1LiveConfig(join(dir, 'bad.json')), (error: unknown) => error instanceof Ms1LiveError && error.code === 'config_invalid_json')
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'c.json'), JSON.stringify(home()))
    const viaEnv = ms1LiveFromEnv({ [MS1_LIVE_CONFIG_ENV]: join(dir, 'sub', 'c.json') })!
    assert.equal(viaEnv.file, join(dir, 'sub', 'c.json')); assert.equal(viaEnv.node.identityFile, join(dir, 'sub', 'identity.json'))
    assert.throws(() => ms1LiveFromEnv({ [MS1_LIVE_CONFIG_ENV]: dir }), (error: unknown) => error instanceof Ms1LiveError && error.code === 'config_unreadable', 'a directory is not a configuration')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the template that init writes parses, and its reserves fit a 32768-token window (and preflight can tell when a window is too small)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms1-template-'))
  try {
    for (const role of ['home', 'executor']) {
      const result = await cli(['init', '--role', role, '--dir', join(dir, role), '--json'])
      assert.equal(result.code, 0, result.err)
      const settings = loadMs1LiveConfig(join(dir, role, 'ms1-live.json'))
      assert.equal(settings.role, role); assert.equal(settings.model, 'qwen3.8-27b'); assert.equal(settings.peer.url, role === 'home' ? 'http://127.0.0.1:4552' : 'http://127.0.0.1:4551')
      assert.equal(settings.listen!.port, role === 'home' ? 4551 : 4552)
      if (role === 'home') {
        const window = (tokens: number) => ({ tokens, framingTokens: 0, source: 'test', observedAt: 1, confidence: 'high' as const })
        assert.ok(thresholds(window(32768), settings.home!.reserves).soft > 0, 'the template is usable for the real window')
        assert.throws(() => thresholds(window(4096), settings.home!.reserves), /window_too_small/, 'and preflight can tell when it is not')
      } else assert.equal(settings.executor!.llamaServer.baseUrl, 'http://127.0.0.1:8090')
    }
    assert.equal(readFileSync(join(dir, 'home', 'ms1-live.json'), 'utf8').includes('PRIVATE'), false)
    chmodSync(join(dir, 'home'), 0o700)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
