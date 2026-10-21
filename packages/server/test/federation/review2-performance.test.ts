import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { history } from './ingest-benchmark.ts'
import { SimNode, identity } from './harness.ts'

test('N1: 1000 reverse operations ingest in under 2 seconds', async (t) => {
  const worker = new Worker(new URL('./ingest-benchmark.ts', import.meta.url))
  try {
    const report = await new Promise<{ elapsed: number; result: { accepted: number; deferred: number } }>((resolve, reject) => {
      let timer = setTimeout(() => reject(new Error('benchmark fixture did not start')), 10_000)
      worker.on('message', (message) => {
        clearTimeout(timer)
        if (message.ready) timer = setTimeout(() => resolve({ elapsed: 2_000, result: { accepted: 0, deferred: 1_000 } }), 2_000)
        else resolve(message)
      })
      worker.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    assert.ok(report.elapsed < 2_000, '1000 reverse operations must ingest in under 2 seconds')
    assert.equal(report.result.accepted, 1_000)
    assert.equal(report.result.deferred, 0)
    t.diagnostic(`1000 reverse ops: ${report.elapsed.toFixed(1)} ms`)
  } finally { await worker.terminate() }
})

test('N1: oversized POST config yields to the event loop within 250 ms', async (t) => {
  const home = new SimNode(identity('home'))
  const cloud = new SimNode(identity('cloud', { trust: 'cloud_ephemeral', admin: false, scopes: ['config'] }))
  try {
    home.trust(cloud); cloud.trust(home)
    const operations = history(cloud, 3_000).reverse()
    assert.ok(Buffer.byteLength(JSON.stringify(operations)) < 1024 * 1024, 'work overload fits the byte budget')
    const start = performance.now()
    const tick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 0))
    const response = await cloud.request(home, 'POST', '/config', operations)
    const delay = await tick
    assert.equal(response.status, 413, 'oversized config work is refused')
    assert.deepEqual(await response.json(), { code: 'config_batch_too_large' })
    assert.ok(delay < 250, `oversized POST event-loop delay ${delay.toFixed(1)} ms exceeds 250 ms`)
    assert.equal(home.federation.config.operations().length, 0)
    t.diagnostic(`oversized POST timer delay: ${delay.toFixed(1)} ms`)
  } finally { home.close(); cloud.close() }
})

test('N1: host configOpsPerRequest setting controls the documented work budget', async () => {
  const home = new SimNode(identity('home'), ':memory:', { configOpsPerRequest: 2 })
  const author = new SimNode(identity('author'))
  try {
    home.trust(author)
    const operations = history(author, 3)
    assert.equal((await author.request(home, 'POST', '/config', operations)).status, 413)
    const response = await author.request(home, 'POST', '/config', operations.slice(0, 2))
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { accepted: number }).accepted, 2)
  } finally { home.close(); author.close() }
})

test('N1: missing admissible context is checked before signature verification', () => {
  const receiver = new SimNode(identity('receiver')); const author = new SimNode(identity('author'))
  try {
    receiver.trust(author)
    const operations = history(author, 2)
    const invalid = { ...operations[1]!, signature: 'invalid' }
    const report = receiver.federation.config.ingest([invalid])
    assert.equal(report.deferred, 1, 'cheap context check precedes expensive signature verification')
    assert.equal(report.skipped, 0)
    const retry = receiver.federation.config.ingest([invalid, operations[0]!])
    assert.equal(retry.accepted, 1)
    assert.equal(retry.reasons.unauthenticated, 1, 'ready operations still require valid signatures')
  } finally { receiver.close(); author.close() }
})
