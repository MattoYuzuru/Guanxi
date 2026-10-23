import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startFakeLlama } from '../fixtures/fake-llama-server.ts'
import { cli, freePort } from './live-world.ts'

interface Report { ok: boolean; checks: Array<{ id: string; status: string; code?: string; summary: string; fix?: string }> }
const status = (report: Report, id: string) => report.checks.find(check => check.id === id)
async function pair(t: { after(fn: () => unknown): void }, options: { llama?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ms1-doctor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const [hp, ep] = [await freePort(), await freePort()]
  const home = await cli(['init', '--role', 'home', '--dir', join(dir, 'home'), '--port', String(hp), '--peer-port', String(ep), '--json'])
  const exec = await cli(['init', '--role', 'executor', '--dir', join(dir, 'exec'), '--port', String(ep), '--peer-port', String(hp), '--llama-url', options.llama ?? 'http://127.0.0.1:1', '--json'])
  assert.equal(home.code + exec.code, 0)
  copyFileSync(join(dir, 'exec', 'peer-offer.json'), join(dir, 'home', 'peer.json')); copyFileSync(join(dir, 'home', 'peer-offer.json'), join(dir, 'exec', 'peer.json'))
  const doctor = async (role: 'home' | 'exec') => {
    const result = await cli(['doctor', '--config', join(dir, role, 'ms1-live.json'), '--json'], { HOME: dir })
    return { code: result.code, report: JSON.parse(result.out) as Report, raw: result.out }
  }
  const edit = (role: 'home' | 'exec', change: (config: any) => void) => { const file = join(dir, role, 'ms1-live.json'); const c = JSON.parse(readFileSync(file, 'utf8')); change(c); writeFileSync(file, JSON.stringify(c)) }
  return { dir, hp, ep, doctor, edit }
}

test('doctor on a fresh pairing reports nothing wrong, calls an absent peer "not yet" and prints no key', async t => {
  const w = await pair(t)
  const { code, report, raw } = await w.doctor('home')
  assert.equal(code, 0, raw); assert.equal(report.ok, true)
  for (const id of ['config', 'identity', 'private_key', 'peer_file', 'pairing', 'listen', 'forward_port', 'own_port', 'git', 'checkout_root']) assert.equal(status(report, id)?.status, 'ok', id)
  assert.equal(status(report, 'peer_reachable')?.status, 'warn'); assert.equal(status(report, 'peer_reachable')?.code, 'peer_unreachable')
  assert.match(status(report, 'peer_reachable')!.fix!, /ssh forward/)
  const body = readFileSync(join(w.dir, 'home', 'node.key'), 'utf8').split('\n').filter(line => line && !line.startsWith('-----')).join('')
  assert.ok(!raw.includes(body.slice(0, 30)), 'no key in the report')
  const text = await cli(['doctor', '--config', join(w.dir, 'home', 'ms1-live.json')])
  assert.equal(text.code, 0); assert.match(text.out, /^ok +config:/m); assert.match(text.out, /warn +peer_reachable:/m); assert.match(text.out, /fix: Start the peer node/)
})

test('doctor names each broken piece and exits 1: key mode, missing peer file, account, scopes, forwarded port, missing lead binaries', async t => {
  const w = await pair(t)
  chmodSync(join(w.dir, 'home', 'node.key'), 0o644)
  let r = await w.doctor('home'); assert.equal(r.code, 1); assert.equal(status(r.report, 'private_key')?.code, 'private_key_mode')
  chmodSync(join(w.dir, 'home', 'node.key'), 0o600)

  rmSync(join(w.dir, 'home', 'peer.json'))
  r = await w.doctor('home'); assert.equal(status(r.report, 'peer_file')?.code, 'peer_unreadable'); assert.equal(status(r.report, 'pairing')?.status, 'skip')
  assert.match(status(r.report, 'peer_file')!.fix!, /peer-offer\.json/)
  copyFileSync(join(w.dir, 'exec', 'peer-offer.json'), join(w.dir, 'home', 'peer.json'))

  const offer = JSON.parse(readFileSync(join(w.dir, 'exec', 'peer-offer.json'), 'utf8'))
  writeFileSync(join(w.dir, 'home', 'peer.json'), JSON.stringify({ ...offer, identity: { ...offer.identity, accountId: 'other' } }))
  r = await w.doctor('home'); assert.equal(status(r.report, 'pairing')?.code, 'pairing_invalid'); assert.match(status(r.report, 'pairing')!.summary, /accounts differ/)
  writeFileSync(join(w.dir, 'home', 'peer.json'), JSON.stringify({ ...offer, identity: { ...offer.identity, scopes: ['attempts'] } }))
  r = await w.doctor('home'); assert.match(status(r.report, 'pairing')!.summary, /attempts and replicas/)
  copyFileSync(join(w.dir, 'exec', 'peer-offer.json'), join(w.dir, 'home', 'peer.json'))

  w.edit('home', config => { config.peer.url = `http://127.0.0.1:${w.ep + 1}` })
  r = await w.doctor('home'); assert.equal(status(r.report, 'forward_port')?.code, 'forward_port_mismatch'); assert.match(status(r.report, 'forward_port')!.fix!, new RegExp(`-L ${w.ep}:127.0.0.1:${w.ep}`))
  w.edit('home', config => { config.peer.url = `http://127.0.0.1:${w.ep}`; config.home.lead = { adapter: 'claude-code', bridge: join(w.dir, 'absent-bridge'), bridgeVersion: '1.2.3', claudeExecutable: 'relative/claude',
    limits: { maxCaps: { cycles: 1, tokens: 1, moneyMicros: 1, wallMs: 1 }, maxDeadlineMs: 1 } } })
  r = await w.doctor('home'); assert.equal(status(r.report, 'lead_bridge')?.code, 'executable_missing'); assert.equal(status(r.report, 'lead_claude')?.code, 'path_not_absolute')
  assert.equal(r.report.ok, false)

  w.edit('home', config => { config.home.alwaysOn = false })
  r = await w.doctor('home'); assert.equal(r.code, 1); assert.equal(status(r.report, 'config')?.code, 'config_invalid'); assert.equal(r.report.checks.length, 1, 'nothing else is guessed from an invalid configuration')
})

test('on an executor doctor probes the llama-server: down, loading, a different alias, and the healthy case with its window and build', async t => {
  const fake = await startFakeLlama({ alias: 'other-alias', nCtx: 16000, modelPath: '/nonexistent.gguf' })
  t.after(() => fake.close())
  const w = await pair(t, { llama: fake.url })
  w.edit('exec', config => { config.model = 'fixture' })
  let r = await w.doctor('exec')
  assert.equal(status(r.report, 'llama_health')?.status, 'ok'); assert.equal(status(r.report, 'llama_alias')?.code, 'alias_mismatch'); assert.equal(r.code, 1)
  assert.match(status(r.report, 'llama_alias')!.fix!, /--alias/)
  await fake.configure({ alias: 'fixture' })
  r = await w.doctor('exec'); assert.equal(r.code, 0); assert.equal(status(r.report, 'llama_alias')?.status, 'ok'); assert.match(status(r.report, 'llama_alias')!.summary, /16000 tokens; build b0-fixture/)
  await fake.configure({ loading: true })
  r = await w.doctor('exec'); assert.equal(status(r.report, 'llama_health')?.code, 'llama_server_loading'); assert.equal(status(r.report, 'llama_alias')?.status, 'skip'); assert.equal(r.code, 0, 'loading is "not yet", not a fault')
  await fake.close()
  r = await w.doctor('exec'); assert.equal(status(r.report, 'llama_health')?.code, 'llama_server_unavailable'); assert.equal(r.code, 1)
  assert.match(status(r.report, 'llama_health')!.fix!, /--alias <model> --jinja/)
})

test('the command line: usage errors exit 2 with the usage text, help exits 0, nothing is run for an unknown command', async () => {
  const none = await cli([]); assert.equal(none.code, 2); assert.match(none.out, /ms1-live init/)
  assert.equal((await cli(['help'])).code, 0)
  const unknown = await cli(['nonsense']); assert.equal(unknown.code, 2); assert.match(unknown.err, /unknown command/)
  const flag = await cli(['doctor', '--frobnicate']); assert.equal(flag.code, 2); assert.match(flag.err, /unknown option/)
  const missing = await cli(['doctor', '--config']); assert.equal(missing.code, 2); assert.match(missing.err, /needs a value/)
  const noConfig = await cli(['doctor'], {}); assert.equal(noConfig.code, 2); assert.match(noConfig.err, /GUANXI_MS1_LIVE_CONFIG/)
  const badRole = await cli(['init', '--role', 'both', '--dir', join(tmpdir(), 'ms1-never')]); assert.equal(badRole.code, 2)
  const badPort = await cli(['init', '--role', 'home', '--dir', join(tmpdir(), 'ms1-never'), '--port', '70000']); assert.equal(badPort.code, 2); assert.match(badPort.err, /TCP port/)
  const pre = await cli(['preflight', '--config', '/nonexistent/ms1-live.json', '--json']); assert.equal(pre.code, 2); assert.equal(JSON.parse(pre.out).error.code, 'config_unreadable')
})
