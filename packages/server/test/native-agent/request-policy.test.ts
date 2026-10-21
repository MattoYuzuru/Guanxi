import assert from 'node:assert/strict'
import { test } from 'node:test'
import { networkInterfaces } from 'node:os'
import { nativeAgentInputSchema } from '@guanxi/contract'
import { isNodeRequest } from '../../src/native-agent/request-policy.ts'

test('loopback allowlist entries require an explicit valid TCP port including numeric aliases', () => {
  const input = { projectId: 'p', connectionId: 'c', model: 'm', prompt: 'p' }
  for (const domain of ['localhost', 'sub.localhost', '127.0.0.1', '127.1', '2130706433', '0x7f000001', 'localhost:0', 'localhost:65536']) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [domain] }).success, false, domain)
  }
  for (const domain of ['localhost:80', '127.0.0.1:8080', 'example.com', 'example.com:443']) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [domain] }).success, true, domain)
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
  assert.equal(await isNodeRequest(new URL('http://localhost:12345/'), [4389, 5189]), false)
})
