import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeAgentInputSchema } from '@guanxi/contract'

test('native domain contract requires a valid explicit port for every IP literal and localhost', () => {
  const input = { projectId: 'p', connectionId: 'c', model: 'm', prompt: 'p' }
  const hosts = ['localhost', 'sub.localhost', '127.0.0.1', '127.1', '2130706433', '0x7f000001',
    '0.0.0.0', '0', '0.0', '0000', '0x0', '0x00000000', '0.0.0.0x0',
    '192.168.1.2', '10.1.2.3', '172.16.0.1', '198.51.100.7',
    '[::]', '[0:0:0:0:0:0:0:0]', '[::1]', '[::ffff:192.168.1.2]', '[2001:db8::1]']
  for (const host of hosts) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [host] }).success, false, `port-less ${host}`)
    for (const port of [1, 80, 443, 8080, 65535]) {
      assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [`${host}:${port}`] }).success, true, `${host}:${port}`)
    }
    for (const port of [0, 65536]) {
      assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [`${host}:${port}`] }).success, false, `${host}:${port}`)
    }
  }
  for (const entry of ['::', '::1', '::1:8080', '[::1]:', '[bad::ip]:80', 'localhost:', 'example.com:0', 'example.com:65536', 'https://example.com', 'example.com/path']) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [entry] }).success, false, entry)
  }
  for (const entry of ['example.com', 'example.com:443']) {
    assert.equal(nativeAgentInputSchema.safeParse({ ...input, domains: [entry] }).success, true, entry)
  }
})
