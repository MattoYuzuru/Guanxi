import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKernel, definePlugin, provide } from '@guanxi/kernel'
import { createBenchPlugin } from '../src/plugin.ts'
import { fixtureExecutor } from '../src/runner.ts'
import { plan } from './helpers.ts'
function host() {
  const outcomes: string[] = []; let n = 0
  const store = { create: () => ({ id: `run-${++n}` }), start: (id: string) => ({ id }), renew() {}, complete(_a: unknown, status: string) { outcomes.push(status) } }
  return { outcomes, plugin: definePlugin({ manifest: { id: 'test.bench-host', engines: { guanxi: '^0.1.0' }, trust: 'T0', provides: ['runs.durable', 'egress.scrubber'] }, apply(ctx) { provide(ctx, 'runs.durable', { store }); provide(ctx, 'egress.scrubber', { isReady: () => true }) } }) }
}
test('kernel-owned external run completes through R1 and disposal removes the service', async () => {
  const kernel = createKernel({ onLog() {} }); const h = host()
  await kernel.plugin(h.plugin)
  await kernel.plugin(createBenchPlugin({ ledger: ':memory:', executor: fixtureExecutor() }))
  const service = kernel.service<any>('bench.runner')
  const result = await service.run(plan()).done
  assert.equal(result.runId, 'run-1'); assert.equal(result.trials.length, 20)
  assert.deepEqual(h.outcomes, ['completed'])
  await kernel.dispose()
  assert.equal(kernel.service('bench.runner'), undefined)
  assert.throws(() => service.run(plan()), /unavailable/)
})
test('unloading aborts active external work and waits for settlement before releasing its ledger', async () => {
  const kernel = createKernel({ onLog() {} }); const h = host(); let stopped = false
  await kernel.plugin(h.plugin)
  await kernel.plugin(createBenchPlugin({ ledger: ':memory:', executor: { run(_p, signal) { return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { stopped = true; reject(new Error('cancelled')) }, { once: true })) } } }))
  const job = kernel.service<any>('bench.runner').run(plan())
  const rejection = assert.rejects(job.done, /bench_failed/)
  await kernel.dispose(); await rejection
  assert.equal(stopped, true)
  assert.deepEqual(h.outcomes, ['canceled'])
})
