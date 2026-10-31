import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { HOME_DB_OPEN_OPTIONS, HttpRelaySource, SqliteLedgerReader } from '../src/relay-smoke-source.ts'
import { memoryStore, runSmoke } from '../src/relay-smoke-run.ts'
import { canonicalText } from '../src/relay-smoke-facts.ts'
import { insertCost, insertSeal, seed } from './relay-smoke-db-fixture.ts'
import { canonicalText as canon } from '../src/relay-smoke-facts.ts'
import { config } from './relay-smoke-helpers.ts'
import { ARM, serve } from './relay-smoke-rig.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'b3b-db-'))

test('the reader recovers seals, the final ledger and call costs, and re-derives every integrity fact itself', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'guanxi.db')
    const db = seed(path)
    db.exec("INSERT INTO relay_runs VALUES ('run-a', '" + canonicalText({ cycle: 2, head: 'b'.repeat(40), items: { I01: 'done', I02: 'verification_requested' }, evidence: [{ id: 'g', item: 'I01', head: 'b'.repeat(40), ok: true, output: 'x' }] }) + "')")
    insertSeal(db, 'run-a', 1, 1); insertSeal(db, 'run-a', 2, 1, { tamper: 'ledger' }); insertSeal(db, 'run-a', 3, 2, { tamper: 'bundle' })
    insertSeal(db, 'run-b', 1, 1)
    insertCost(db, 'run-a', 'm-1', 20_000); insertCost(db, 'run-b', 'm-9', 1, 1)
    db.close()
    const reader = new SqliteLedgerReader(path)
    assert.deepEqual(reader.check(), [])
    const read = reader.read('run-a')
    assert.deepEqual(read.seals.map(s => [s.cycle, s.epoch]), [[1, 1], [2, 1], [3, 2]])
    assert.deepEqual(read.costs, [{ key: 'm-1', inputTokens: 20_000, outputTokens: 300 }], 'only this run, and no other run costs')
    const [honest, ledgerTamper, bundleTamper] = read.seals
    assert.equal(honest!.ledgerSha256, honest!.handoffLedgerSha256)
    assert.equal(honest!.bundleMatchesHandoff, true); assert.equal(honest!.artifactMatchesHandoff, true)
    assert.notEqual(ledgerTamper!.ledgerSha256, ledgerTamper!.handoffLedgerSha256, 'the ledger hash is recomputed from the stored ledger, never copied from the handoff')
    assert.equal(bundleTamper!.bundleMatchesHandoff, false)
    assert.deepEqual(read.final, { cycle: 2, head: 'b'.repeat(40), items: { I01: 'done', I02: 'verification_requested' }, evidence: [{ item: 'I01', head: 'b'.repeat(40), ok: true }] })
    assert.ok(!JSON.stringify(read).includes('PRIVATE-GATE-OUTPUT'), 'gate output is never read into an observation')
    assert.equal(reader.read('run-missing').seals.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stored artifact whose hash differs, or a corrupt handoff, is a failed integrity fact, not a crash', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'guanxi.db')
    const db = seed(path)
    insertSeal(db, 'run-a', 1, 1, { tamper: 'artifact' }); insertSeal(db, 'run-a', 2, 1, { tamper: 'corrupt' })
    db.close()
    const seals = new SqliteLedgerReader(path).read('run-a').seals
    assert.equal(seals[0]!.artifactMatchesHandoff, false)
    assert.deepEqual([seals[1]!.handoffLedgerSha256, seals[1]!.bundleMatchesHandoff, seals[1]!.artifactMatchesHandoff], [null, null, null])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the reader is read-only and fails closed on a missing or foreign database', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'guanxi.db')
    seed(path).close()
    const reader = new SqliteLedgerReader(path)
    assert.deepEqual({ ...HOME_DB_OPEN_OPTIONS }, { readOnly: true }, 'the reader opens the home database read-only')
    const ro = new DatabaseSync(path, HOME_DB_OPEN_OPTIONS)
    assert.throws(() => ro.exec('CREATE TABLE intruder(a)'), /readonly|read-only/i)
    ro.close()
    assert.deepEqual(reader.check(), [])
    assert.throws(() => new SqliteLedgerReader(join(dir, 'absent.db')).read('r'), { code: 'home_database_unreadable' })
    const foreign = join(dir, 'foreign.db'); const f = new DatabaseSync(foreign); f.exec('CREATE TABLE other(a)'); f.close()
    assert.deepEqual(new SqliteLedgerReader(foreign).check(), ['relay_seals', 'relay_runs', 'run_costs'])
    assert.throws(() => new SqliteLedgerReader(foreign).read('r'), { code: 'home_database_unreadable' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('end to end: the HTTP source plus a real database file give items, context and integrity', async () => {
  const dir = tmp()
  const rig = await serve()
  try {
    const path = join(dir, 'guanxi.db')
    seed(path).close()
    const http = new HttpRelaySource({ [ARM]: { url: rig.url, homeDb: path } })
    // The home node would have written these rows while the relay ran; mirror what the fake relay recorded.
    const source = {
      kind: http.kind, start: http.start.bind(http), status: http.status.bind(http), stop: http.stop.bind(http), events: http.events.bind(http),
      async ledger(arm: string, runId: string) {
        const observed = await rig.fake.ledger(arm, runId)
        assert.ok(observed)
        const w = new DatabaseSync(path, { enableForeignKeyConstraints: false })
        for (const seal of observed.seals) insertSeal(w, runId, seal.cycle, seal.epoch)
        for (const c of observed.costs) insertCost(w, runId, c.key, c.inputTokens, c.outputTokens)
        w.close()
        return http.ledger(arm, runId)
      },
    }
    const result = await runSmoke(config({ endpoint: { url: rig.url, homeDb: path } }), { source, now: rig.clock.now, sleep: async () => {}, store: memoryStore() })
    assert.equal(result.exitCode, 0, JSON.stringify(result.summary.document))
    assert.equal(result.summary.trials[0]!.ledgerRead, true)
    const totals = result.report!.arms[0]!.totals
    assert.deepEqual([totals.integrity.observed, totals.integrity.reportedMatch, totals.integrity.reportedValidationPassed], [5, 5, 5])
    assert.deepEqual([totals.context.expected, totals.context.observed], [15, 15])
    assert.deepEqual([totals.items.groupsUnknown, totals.items.expected, totals.items.passed], [0, 1, 1], 'the stored ledger lists one gate (I01) in every seal, so only the first cycle opens an opportunity')
  } finally { await rig.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("the reader's own open() is read-only: a write through it fails", () => {
  const dir = tmp()
  try {
    const path = join(dir, 'guanxi.db')
    seed(path).close()
    const db = new SqliteLedgerReader(path).open()
    try { assert.throws(() => db.exec('CREATE TABLE intruder(a)'), /readonly|read-only/i) } finally { db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a WAL database whose node is not running is refused instead of letting the reader create its -wal/-shm files', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'guanxi.db')
    const db = seed(path)
    db.exec('PRAGMA journal_mode = WAL')
    insertSeal(db, 'run-a', 1, 1)
    // the writer is open, as the live node is: its -shm exists and the read works
    assert.ok(existsSync(`${path}-shm`))
    assert.equal(new SqliteLedgerReader(path).read('run-a').seals.length, 1)
    db.close()
    assert.ok(!existsSync(`${path}-shm`), 'closing the last connection removes the shared-memory file')
    assert.throws(() => new SqliteLedgerReader(path).read('run-a'), { code: 'home_node_not_running' })
    assert.throws(() => new SqliteLedgerReader(path).check(), { code: 'home_node_not_running' })
    assert.ok(!existsSync(`${path}-shm`) && !existsSync(`${path}-wal`), 'the refused read left no files behind')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a seal whose ledger has an unexpected shape stays visible as unreadable, never silently dropped', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'guanxi.db')
    const db = seed(path)
    insertSeal(db, 'run-a', 1, 1)
    db.prepare('INSERT INTO relay_seals VALUES (?,?,?,?,?,?,?,?,?,?)').run('run-a', 2, 'attempt-x', 1, 1, canon({ cycle: 2, head: 'h', items: {}, evidence: [{ item: 'I01' }] }), canon({}), 'x', 'm', new Uint8Array([1]))
    db.close()
    const seals = new SqliteLedgerReader(path).read('run-a').seals
    assert.deepEqual(seals.map(s => [s.cycle, s.unreadable === true]), [[1, false], [2, true]])
    assert.deepEqual([seals[1]!.ledgerSha256, seals[1]!.evidence.length], [null, 0])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
