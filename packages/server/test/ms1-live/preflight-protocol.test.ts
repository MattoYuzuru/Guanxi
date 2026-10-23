import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ATTEMPT_DISPATCH_CAPABILITY, ATTEMPT_RESERVATIONS_CAPABILITY, RELAY_RUNTIME_CAPABILITY } from '@guanxi/contract/federation'
import { loadMs1LiveConfig } from '../../src/ms1-live/config.ts'
import { preflight } from '../../src/ms1-live/preflight.ts'
import { cli, freePort } from './live-world.ts'

/** The home's view of an executor that declares `minor`: an unsigned probe is the usual 401, a signed handshake is answered, nothing else exists. */
const executorAt = (minor: number): typeof fetch => async (_url, init) => {
  const signed = init?.headers !== undefined && 'X-Guanxi-Node' in (init.headers as Record<string, string>)
  if (!signed) return Response.json({ code: 'unauthenticated' }, { status: 401 })
  return Response.json({ version: { major: 1, minor }, negotiated: { major: 1, minor }, readOnly: false, capabilities: [ATTEMPT_RESERVATIONS_CAPABILITY, ATTEMPT_DISPATCH_CAPABILITY, RELAY_RUNTIME_CAPABILITY] })
}
async function home(t: { after(fn: () => unknown): void }, structuredOutput?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ms1-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const [hp, hf, ep, ef] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const h = await cli(['init', '--role', 'home', '--dir', join(dir, 'home'), '--port', String(hp), '--federation-port', String(hf), '--peer-federation-port', String(ef), '--json'])
  const e = await cli(['init', '--role', 'executor', '--dir', join(dir, 'exec'), '--port', String(ep), '--federation-port', String(ef), '--peer-federation-port', String(hf), '--llama-url', 'http://127.0.0.1:1', '--json'])
  assert.equal(h.code + e.code, 0)
  copyFileSync(join(dir, 'exec', 'peer-offer.json'), join(dir, 'home', 'peer.json'))
  const settings = loadMs1LiveConfig(join(dir, 'home', 'ms1-live.json'))
  return structuredOutput === undefined ? settings : { ...settings, home: { ...settings.home!, structuredOutput } }
}
const handshake = async (settings: Awaited<ReturnType<typeof home>>, minor: number) => (await preflight({ settings, transport: executorAt(minor) })).checks.find(check => check.id === 'handshake')!

test('preflight refuses an executor older than federation 1.6 while the grammar is on, says how to fix it, and accepts it with the grammar off', async t => {
  const on = await home(t), old = await handshake(on, 5)
  assert.equal(old.status, 'fail'); assert.equal(old.code, 'peer_protocol_old')
  assert.match(old.summary, /federation 1\.5/); assert.match(old.fix ?? '', /same Guanxi commit.*home\.structuredOutput/)
  assert.equal((await handshake(on, 6)).status, 'ok', 'an executor that speaks 1.6 passes')
  const off = await home(t, false)
  assert.equal((await handshake(off, 5)).status, 'ok', 'without the grammar an older executor still interoperates')
})
