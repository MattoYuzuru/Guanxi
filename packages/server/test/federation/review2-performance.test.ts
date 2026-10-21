import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { Federation } from '../../src/federation/service.ts'
import { SharedConfig } from '../../src/federation/config.ts'
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


test('self-review: ingest scans stored counters once and scrubs each input once', (t) => {
  const receiver = new SimNode(identity('receiver')); const author = new SimNode(identity('author'))
  try {
    receiver.trust(author)
    const operations = history(author, 64)
    receiver.federation.config.ingest(operations.slice(0, 32))
    const prepare = receiver.db.prepare.bind(receiver.db)
    let scans = 0
    t.mock.method(receiver.db, 'prepare', (sql: string) => {
      if (sql.includes('FROM federation_operations') && !sql.includes('WHERE origin=?')) scans++
      return prepare(sql)
    })
    let scrubs = 0
    const config = new SharedConfig(receiver.db, receiver.keys.identity, receiver.keys.privateKey,
      (id) => receiver.federation.peer(id), () => receiver.time, (value) => { if (value !== null) scrubs++ })
    const result = config.ingest(operations.slice(32).reverse())
    assert.equal(result.accepted, 32)
    assert.equal(result.deferred, 0)
    assert.equal(scans, 1, 'stored history is scanned once per ingest')
    assert.equal(scrubs, 32, 'only incoming signed payloads are scrubbed once')
  } finally { receiver.close(); author.close() }
})

test('independent review: default config request budget admits 256 and refuses 257', async () => {
  const receiver = new SimNode(identity('receiver')); const author = new SimNode(identity('author'))
  try {
    receiver.trust(author)
    const operations = history(author, 257)
    const rejected = await author.request(receiver, 'POST', '/config', operations)
    assert.equal(rejected.status, 413, 'documented default refuses 257 operations')
    assert.equal(receiver.federation.config.operations().length, 0)
    const accepted = await author.request(receiver, 'POST', '/config', operations.slice(0, 256))
    assert.equal(accepted.status, 200, 'documented default admits 256 operations')
    assert.equal((await accepted.json() as { accepted: number }).accepted, 256)
  } finally { receiver.close(); author.close() }
})

test('independent review: host config budget must be a positive safe integer', () => {
  const receiver = new SimNode(identity('receiver'))
  try {
    // Use the existing fixture database; constructor validation runs before any
    // migration, so invalid host values have no storage side effects.
    for (const configOpsPerRequest of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new Federation({ ...receiver.keys, db: receiver.db, scrubber: receiver.scrubber,
        log: receiver.log, runs: receiver.runs, configOpsPerRequest }), /invalid_config_budget/, 'invalid host work budgets fail closed')
    }
  } finally { receiver.close() }
})
