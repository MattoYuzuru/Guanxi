import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, owner } from './helpers.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
    await f.scenario(adapter, { scenario: adapter === 'codex' ? 'hang-after-start' : 'hang' })
    if (action === 'timeout') await f.reload({ runDeadlineMs: 1500 })
    const controller = new AbortController()
    const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: controller.signal })
    const settled = run.then(value => ({ value }), error => ({ error }))
    await until(async () => {
      try { return (await f.trace(adapter)).some(frame => frame.method === (adapter === 'codex' ? 'turn/start' : 'session/prompt')) } catch { return false }
    })
    // Give the client one poll interval to process a turn/start response before aborting.
    await new Promise(resolve => setTimeout(resolve, 25))
    if (action === 'abort') controller.abort()
    if (action === 'unload') await f.reload()
    const result = await settled
    assert.ok('error' in result)
    assert.equal('error' in result ? result.error.code : '', action === 'timeout' ? 'timeout' : 'cancelled')
    if (action === 'timeout') {
      // The deadline is a recorded fact, not a hidden wall-clock cap.
      const sessionId = f.kernel.sessionLog!.list().sessions[0]!.sessionId
      const note = f.kernel.sessionLog!.readAll(sessionId, 'person').find(event => event.type === 'agent.note')
      assert.equal(JSON.parse(note!.data.text).runDeadlineMs, 1500)
    }
    assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
    await f.reload()
    assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
    const trace = await f.trace(adapter)
    assert.equal(trace.filter(frame => frame.method === (adapter === 'codex' ? 'turn/start' : 'session/prompt')).length, 1)
    // Cancellation is protocol-first: session/cancel for ACP and turn/interrupt for Codex.
    assert.equal(trace.filter(frame => frame.method === (adapter === 'codex' ? 'turn/interrupt' : 'session/cancel')).length, 1)
  }
  await f.scenario(adapter, {})
  const good = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  assert.match(good.text, /fixture completed/)
})

test('abort and timeout kill same-group descendants after the adapter exits on stdin close', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  for (const action of ['abort', 'timeout'] as const) {
    if (action === 'timeout') await f.reload({ runDeadlineMs: 1200 })
    await f.scenario('codex', { scenario: 'orphan' })
    const controller = new AbortController()
    const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello',
      ...(action === 'abort' ? { signal: controller.signal } : {}) })
    const settled = run.then(value => ({ value }), error => ({ error }))
    await until(async () => {
      try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') &&
        (await readFile(join(f.dir, 'codex', 'orphan.pid'), 'utf8')).length > 0 } catch { return false }
    })
    const pid = Number(await readFile(join(f.dir, 'codex', 'orphan.pid'), 'utf8'))
    try {
      if (action === 'abort') controller.abort()
      const result = await settled
      assert.ok('error' in result)
      assert.equal('error' in result ? result.error.code : '', action === 'timeout' ? 'timeout' : 'cancelled')
      // close() ends stdin, so the adapter exits by itself; its child must still be killed.
      await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
    } finally { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
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

test('Claude status-probe abort kills its ordinary descendant and settles admission without raw output', async t => {
  const f = await fixture(t, ['claude-code'])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.scenario('claude-code', { scenario: 'auth-descendant' })
  const controller = new AbortController()
  const settling = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: controller.signal })
    .then(() => 'succeeded', error => error.code)
  await until(async () => { try { return (await readFile(join(f.dir, 'claude-code', 'auth-ready'), 'utf8')) === 'ready' } catch { return false } })
  const pids = JSON.parse(await readFile(join(f.dir, 'claude-code', 'auth-pids.json'), 'utf8'))
  controller.abort()
  assert.equal(await Promise.race([settling, new Promise(resolve => setTimeout(() => resolve('stalled'), 10000))]), 'cancelled')
  const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }
  await until(() => gone(pids.parent) && gone(pids.descendant))
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  await new Promise(resolve => setTimeout(resolve, 1100))
  await assert.rejects(readFile(join(f.dir, 'claude-code', 'auth-descendant-write')), { code: 'ENOENT' })
})
