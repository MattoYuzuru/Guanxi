import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadMs1LiveConfig, Ms1LiveError } from '../../src/ms1-live/config.ts'
import { initNode, MS1_SCOPES, PEER_FORMAT, readCredentials } from '../../src/ms1-live/identity.ts'
import { cli } from './live-world.ts'

const code = (expected: string) => (error: unknown) => error instanceof Ms1LiveError && error.code === expected
const keyBody = (path: string) => readFileSync(path, 'utf8').split('\n').filter(line => line && !line.startsWith('-----')).join('')

async function pair(dir: string, options: { account?: string } = {}) {
  const a = await cli(['init', '--role', 'home', '--dir', join(dir, 'a'), '--json', ...(options.account ? ['--account', options.account] : [])])
  const b = await cli(['init', '--role', 'executor', '--dir', join(dir, 'b'), '--json'])
  assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err)
  copyFileSync(join(dir, 'b', 'peer-offer.json'), join(dir, 'a', 'peer.json')); copyFileSync(join(dir, 'a', 'peer-offer.json'), join(dir, 'b', 'peer.json'))
  return { a: loadMs1LiveConfig(join(dir, 'a', 'ms1-live.json')), b: loadMs1LiveConfig(join(dir, 'b', 'ms1-live.json')), a1: a, b1: b }
}
const scratch = <T>(body: (dir: string) => Promise<T>) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms1-identity-'))
  try { return await body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('init writes a private key (0600), a public identity and offer that hold no key material, and prints no key', scratch(async dir => {
  const { a, a1 } = await pair(dir)
  assert.equal(statSync(a.node.privateKeyFile).mode & 0o777, 0o600); assert.equal(statSync(join(dir, 'a')).mode & 0o077, 0, 'the directory is private')
  const body = keyBody(a.node.privateKeyFile)
  assert.ok(body.length > 40)
  for (const file of ['identity.json', 'peer-offer.json', 'ms1-live.json', 'peer.json']) assert.ok(!readFileSync(join(dir, 'a', file), 'utf8').includes(body.slice(0, 30)), `${file} holds no key`)
  const offer = JSON.parse(readFileSync(join(dir, 'a', 'peer-offer.json'), 'utf8'))
  assert.equal(offer.format, PEER_FORMAT); assert.deepEqual(offer.identity.scopes, MS1_SCOPES); assert.equal(offer.identity.trust, 'owner_device'); assert.equal(offer.identity.admin, false)
  assert.equal(offer.port, 4551)
  assert.ok(!a1.out.includes(body.slice(0, 30)) && !a1.err.includes(body.slice(0, 30)), 'no command output carries the key')
  assert.ok(!a1.out.includes('BEGIN'))
}))

test('an identity is never replaced: a second init in the same directory fails and leaves the key and identity untouched', scratch(async dir => {
  const { a } = await pair(dir)
  const before = { key: readFileSync(a.node.privateKeyFile, 'utf8'), identity: readFileSync(a.node.identityFile, 'utf8') }
  const again = await cli(['init', '--role', 'home', '--dir', join(dir, 'a'), '--json'])
  assert.equal(again.code, 2); assert.equal(JSON.parse(again.out).error.code, 'already_initialized')
  assert.deepEqual({ key: readFileSync(a.node.privateKeyFile, 'utf8'), identity: readFileSync(a.node.identityFile, 'utf8') }, before)
  assert.throws(() => initNode(join(dir, 'a'), { role: 'home', config: () => ({}) }), code('already_initialized'))
}))

test('credentials load only for a private key that belongs to the identity, paired with a peer of the same account', scratch(async dir => {
  const { a, b } = await pair(dir)
  const ok = readCredentials(a)
  assert.equal(ok.local.identity.accountId, 'owner'); assert.equal(ok.peer.id, readCredentials(b).local.identity.id); assert.equal(ok.peerPort, 4552)

  chmodSync(a.node.privateKeyFile, 0o644)
  assert.throws(() => readCredentials(a), code('private_key_mode'), 'a key other users can read is refused')
  chmodSync(a.node.privateKeyFile, 0o600)

  const good = readFileSync(a.node.privateKeyFile, 'utf8')
  writeFileSync(a.node.privateKeyFile, readFileSync(b.node.privateKeyFile)); chmodSync(a.node.privateKeyFile, 0o600)
  assert.throws(() => readCredentials(a), code('key_identity_mismatch'), 'another node\'s key')
  writeFileSync(a.node.privateKeyFile, 'not a key'); chmodSync(a.node.privateKeyFile, 0o600)
  assert.throws(() => readCredentials(a), code('private_key_invalid'))
  writeFileSync(a.node.privateKeyFile, good); chmodSync(a.node.privateKeyFile, 0o600)

  copyFileSync(a.node.identityFile, a.peer.identityFile)
  assert.throws(() => readCredentials(a), code('peer_is_self'))
  writeFileSync(a.peer.identityFile, '{"format":"x"}'); assert.throws(() => readCredentials(a), code('peer_invalid'))
  rmSync(a.peer.identityFile); assert.throws(() => readCredentials(a), code('peer_unreadable'))
}))

test('nodes of different accounts, non-owner trust or too few scopes do not pair', scratch(async dir => {
  const { a } = await pair(dir, { account: 'someone-else' })
  assert.throws(() => readCredentials(a), code('account_mismatch'))
  const offer = JSON.parse(readFileSync(join(dir, 'b', 'peer-offer.json'), 'utf8'))
  const mutate = (change: (identity: any) => void) => { const copy = structuredClone(offer); change(copy.identity); copy.identity.accountId = 'someone-else'; writeFileSync(a.peer.identityFile, JSON.stringify(copy)) }
  mutate(identity => { identity.trust = 'shared_device' }); assert.throws(() => readCredentials(a), code('peer_not_owner_device'))
  mutate(identity => { identity.scopes = ['attempts'] }); assert.throws(() => readCredentials(a), code('peer_scope_missing'), 'attempts alone cannot pin a relay run')
}))
