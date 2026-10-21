import assert from 'node:assert/strict'
import { test } from 'node:test'
import { networkInterfaces } from 'node:os'
import { nativeAgentInputSchema } from '@guanxi/contract'
import { filterNativeRequest, isNodeRequest } from '../../src/native-agent/request-policy.ts'
import type { SandboxPolicy } from '../../src/native-agent/sandbox-protocol.ts'

test('loopback allowlist entries require an explicit valid TCP port including numeric aliases', () => {
  const input = { projectId: 'p', connectionId: 'c', model: 'm', prompt: 'p' }
  for (const domain of ['localhost', 'sub.localhost', '127.0.0.1', '127.1', '2130706433', '0x7f000001', 'localhost:0', 'localhost:65536']) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [domain] }).success, false, domain)
  }
  for (const domain of ['localhost:80', '127.0.0.1:8080', 'example.com', 'example.com:443']) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [domain] }).success, true, domain)
  }
})
test('IP-literal and localhost request grants allow only the explicitly named service port', async () => {
  for (const mode of ['read-only', 'full-access'] as const) {
    for (const host of ['0.0.0.0', '0', '0x0', '127.1', '192.168.1.2', '198.51.100.7', '[::]', '[::1]', '[::ffff:192.168.1.2]', '[2001:db8::1]', 'localhost', 'sub.localhost']) {
      const policy: SandboxPolicy = { mode, scratch: '', roots: [], attachments: [], protectedPaths: [], domains: [host] }
      assert.equal(nativeAgentInputSchema.safeParse({ projectId: 'p', connectionId: 'c', model: 'm', prompt: 'p', domains: [host] }).success, false, `policy creation: ${host}`)
      let authorized = 0
      const authorize = async () => { authorized++; return true }
      assert.deepEqual(await filterNativeRequest(new Request(`http://${host}:8080/`), policy, authorize), { action: 'deny' }, `${mode}: old port-less ${host}`)
      policy.domains = [`${host}:8080`]
      assert.deepEqual(await filterNativeRequest(new Request(`http://${host}:8080/`), policy, authorize), { action: 'allow' }, `${mode}: named ${host}`)
      for (const target of [`http://${host}:8081/`, `http://${host}/`, `https://${host}/`]) {
        assert.deepEqual(await filterNativeRequest(new Request(target), policy, authorize), { action: 'deny' }, `${mode}: unnamed ${target}`)
      }
      assert.equal(authorized, 1, 'denied services never reach egress authorization')
      for (const [scheme, port] of [['http', 80], ['https', 443]] as const) {
        policy.domains = [`${host}:${port}`]
        assert.deepEqual(await filterNativeRequest(new Request(`${scheme}://${host}/`), policy, authorize), { action: 'allow' }, `${scheme} default port is still explicitly granted`)
      }
    }
  }
})
test('node-port denial recognizes loopback aliases, IPv6, mapped IPv4 and every local interface', async () => {
  for (const host of ['localhost', 'sub.localhost', '127.0.0.2', '127.1', '2130706433', '[::1]', '[::ffff:127.0.0.1]', '0.0.0.0', '[::]']) {
    assert.equal(await isNodeRequest(new URL(`http://${host}:4389/`), [4389, 5189]), true, host)
  }
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) {
    const host = entry.family === 'IPv6' ? `[${entry.address.split('%')[0]}]` : entry.address
    assert.equal(await isNodeRequest(new URL(`http://${host}:5189/`), [4389, 5189]), true, host)
  }
  assert.equal(await isNodeRequest(new URL('http://198.51.100.7:4389/'), [4389, 5189]), true, 'reserve node ports even on remote addresses before DNS rebinding')
  assert.equal(await isNodeRequest(new URL('http://rebind.invalid:4389/'), [4389, 5189]), true, 'deny before any DNS resolution can change the destination')
  assert.equal(await isNodeRequest(new URL('http://localhost:12345/'), [4389, 5189]), false)
})
