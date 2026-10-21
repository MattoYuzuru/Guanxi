import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createEgressAuthorizer } from '../../src/native-agent/egress-ipc.ts'
import { filterNativeRequest } from '../../src/native-agent/request-policy.ts'
import type { SandboxPolicy } from '../../src/native-agent/sandbox-protocol.ts'

const request = new Request('http://127.0.0.1:8080/', { headers: { 'x-fixture': 'clean' } })
const policy: SandboxPolicy = { mode: 'read-only', scratch: '', roots: [], attachments: [], protectedPaths: [], domains: ['127.0.0.1:8080'] }
class SilentParent extends EventEmitter {
  connected = true
  sent: { egress: { id: number; url: string; headers: [string, string][] } }[] = []
  send(message: SilentParent['sent'][number], callback: (error: Error | null) => void) {
    this.sent.push(message)
    callback(null) // The message is sent successfully, but no decision ever arrives.
  }
}

test('egress IPC timeout denies a request when the parent never answers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parent = new SilentParent()
  const decision = createEgressAuthorizer(parent)(request)
  assert.equal(parent.sent.length, 1, 'the request actually asked for an IPC decision')
  assert.deepEqual(parent.sent[0]!.egress, { id: 1, url: request.url, headers: [...request.headers] })
  t.mock.timers.tick(1000)
  assert.deepEqual(await filterNativeRequest(request, policy, () => decision), { action: 'deny' }, 'an unanswered decision fails closed')
  parent.emit('message', { egressDecision: { id: 1, allow: true } })
  assert.equal(await decision, false, 'a late allow cannot change a timed-out decision')
})

for (const failure of ['disconnected', 'missing-send', 'send-callback', 'send-throw', 'disconnect-in-flight'] as const) {
  test(`egress IPC ${failure} denies the request`, async () => {
    const parent = new SilentParent()
    if (failure === 'disconnected') parent.connected = false
    if (failure === 'missing-send') Object.defineProperty(parent, 'send', { value: undefined })
    if (failure === 'send-callback') parent.send = (_message, callback) => callback(new Error('fixture IPC failure'))
    if (failure === 'send-throw') parent.send = () => { throw new Error('fixture IPC failure') }
    const decision = createEgressAuthorizer(parent)(request)
    if (failure === 'disconnect-in-flight') parent.emit('disconnect')
    assert.deepEqual(await filterNativeRequest(request, policy, () => decision), { action: 'deny' })
  })
}

test('egress IPC correlates concurrent replies and requires an explicit allow', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parent = new SilentParent(), authorize = createEgressAuthorizer(parent)
  const first = authorize(request), second = authorize(request)
  parent.emit('message', { egressDecision: { id: 999, allow: true } })
  parent.emit('message', { egressDecision: { id: 2, allow: true } })
  parent.emit('message', { egressDecision: { id: 1, allow: 'true' } })
  assert.deepEqual(await filterNativeRequest(request, policy, () => first), { action: 'deny' })
  assert.deepEqual(await filterNativeRequest(request, policy, () => second), { action: 'allow' })
  t.mock.timers.tick(1000)
  assert.equal(await second, true, 'a settled allow is not changed by its former deadline')
})
