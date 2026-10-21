import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, owner } from './helpers.ts'

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Fixture did not reach the expected lifecycle point')
}

for (const adapter of ['copilot', 'codex'] as const) test(`${adapter}: cancellation, unload and timeout settle a running process, release admission and do not replay inference`, async t => {
  const f = await fixture(t, [adapter])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  for (const action of ['abort', 'unload', 'timeout'] as const) {
    await f.scenario(adapter, { scenario: 'hang' })
    if (action === 'timeout') await f.reload({ requestTimeoutMs: 1500 })
    const controller = new AbortController()
    const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: controller.signal })
    const settled = run.then(value => ({ value }), error => ({ error }))
    await until(async () => {
      try { return (await f.trace(adapter)).some(frame => frame.method === (adapter === 'codex' ? 'turn/start' : 'session/prompt')) } catch { return false }
    })
    if (action === 'abort') controller.abort()
    if (action === 'unload') await f.reload()
    const result = await settled
    assert.ok('error' in result)
    assert.equal('error' in result ? result.error.code : '', 'cancelled')
    assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
    await f.reload()
    assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
    assert.equal((await f.trace(adapter)).filter(frame => frame.method === (adapter === 'codex' ? 'turn/start' : 'session/prompt')).length, 1)
  }
  await f.scenario(adapter, {})
  const good = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  assert.match(good.text, /fixture completed/)
})

test('learned account concurrency rejects a third invocation before process launch and releases both permits on cancel', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  await f.reload({ installations: [{ ...f.installations[0]!, concurrency: 4 }] })
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  f.service().observeConcurrency(owner, owner, binding.connectionId, 3, 'concurrency_rejected')
  await f.scenario('codex', { scenario: 'hang' })
  const controller = new AbortController()
  const input = { ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead' as const, prompt: 'hello', signal: controller.signal }
  const runs = [f.service().run(input), f.service().run(input)]
  const settling = Promise.allSettled(runs)
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 2)
  await assert.rejects(f.service().run(input), /account_busy/)
  controller.abort()
  const results = await settling
  assert.equal(results.filter(r => r.status === 'rejected').length, 2)
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
})
