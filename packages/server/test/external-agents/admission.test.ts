import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture, owner } from './helpers.ts'
import { ExternalAgents } from '../../src/external-agents/service.ts'
import { ExternalStore } from '../../src/external-agents/store.ts'
import type { ExternalPolicy } from '../../src/external-agents/types.ts'

async function until(check: () => Promise<boolean> | boolean, message = 'Fixture did not reach the expected lifecycle point') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function peer(f: Awaited<ReturnType<typeof fixture>>, policy: Partial<ExternalPolicy> = {}) {
  const store = new ExternalStore(join(f.dir, 'external-agents.sqlite'), f.kernel.scrubber)
  const agents = new ExternalAgents(f.connections, f.kernel.sessionLog!, f.kernel.scrubber, f.dir, store, {
    nodeId: f.installations[0]!.nodeId, installations: f.installations, ...policy,
  })
  let closed = false
  return { store, agents, close: async () => { if (closed) return; closed = true; await agents.close(); store.close() } }
}

type Settled<T> = { status: 'ok'; value: T } | { status: 'error'; error: { code?: string } } | { status: 'timeout' }
async function settled<T>(promise: Promise<T>, ms = 1000): Promise<Settled<T>> {
  return Promise.race([promise.then(value => ({ status: 'ok' as const, value }), error => ({ status: 'error' as const, error })),
    new Promise<{ status: 'timeout' }>(resolve => setTimeout(() => resolve({ status: 'timeout' as const }), ms))])
}

test('two K5 services sharing one sidecar cannot exceed the same account ceiling', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f)
  t.after(second.close)
  await f.scenario('codex', { scenario: 'hang' })
  const firstAbort = new AbortController()
  const first = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: firstAbort.signal })
  const firstSettled = first.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  const secondAbort = new AbortController()
  const outcome = await settled(second.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
    role: 'lead', prompt: 'hello', signal: secondAbort.signal }))
  secondAbort.abort(); firstAbort.abort(); await firstSettled; await second.close()
  assert.notEqual(outcome.status, 'timeout', 'the second service must settle instead of starting a child')
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.status === 'error' ? outcome.error.code : '', 'account_busy')
})

test('a login held by one service is exclusive with every run and login in the same group across services', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f)
  t.after(second.close)
  await f.scenario('codex', { scenario: 'login-hang' })
  let shown!: () => void
  const urlShown = new Promise<void>(resolve => { shown = resolve })
  const abort = new AbortController()
  const login = f.service().signInWithChatGPT(owner, owner, binding.connectionId, () => shown(), abort.signal)
  const loginSettled = login.then(() => 'succeeded', error => error.code)
  await urlShown
  const run = await settled(second.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
    role: 'lead', prompt: 'hello', signal: AbortSignal.timeout(2000) }))
  const otherLogin = await settled(second.agents.signInWithChatGPT(owner, owner, binding.connectionId, () => undefined,
    AbortSignal.timeout(2000)))
  abort.abort(); await loginSettled; await second.close()
  assert.notEqual(run.status, 'timeout')
  assert.equal(run.status, 'error')
  assert.equal(run.status === 'error' ? run.error.code : '', 'account_busy')
  assert.notEqual(otherLogin.status, 'timeout')
  assert.equal(otherLogin.status, 'error')
  assert.equal(otherLogin.status === 'error' ? otherLogin.error.code : '', 'account_busy')
})

test('a different configured ceiling for an occupied group is refused as a policy conflict', async t => {
  const f = await fixture(t)
  const install = f.installations[0]!
  await f.reload({ installations: [{ ...install, concurrency: 3 }] })
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f, { installations: [{ ...install, concurrency: 1 }] })
  t.after(second.close)
  await f.scenario('codex', { scenario: 'hang' })
  const firstAbort = new AbortController()
  const first = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: firstAbort.signal })
  const firstSettled = first.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  const secondAbort = new AbortController()
  const outcome = await settled(second.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
    role: 'lead', prompt: 'hello', signal: secondAbort.signal }))
  secondAbort.abort(); firstAbort.abort(); await firstSettled; await second.close()
  assert.notEqual(outcome.status, 'timeout')
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.status === 'error' ? outcome.error.code : '', 'account_policy_conflict')
})

test('effective_bare stays unknown after a successful logged-in Claude fixture', async t => {
  const f = await fixture(t, ['claude-code'])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  const facts = f.connections.store.get(owner, binding.connectionId).facts
  assert.deepEqual(facts.effective_bare, { value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' })
  assert.equal(facts.bare?.value, null)
  assert.equal(facts.bare?.source, 'node_launch_policy')
})
