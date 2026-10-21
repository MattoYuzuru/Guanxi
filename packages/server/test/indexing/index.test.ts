import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, chmod, readdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { executeIndex, boundMap } from '../../src/indexing/engine.ts'
import { symbols } from '../../src/indexing/parser.ts'
import { DEFAULT_INDEX_SETTINGS, type IndexWorkerData, type MapResult, type SearchResult } from '../../src/indexing/types.ts'
import { ProjectIndex } from '../../src/indexing/service.ts'
import { hasHeadroom } from '../../src/indexing/headroom.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'

const settings = { ...DEFAULT_INDEX_SETTINGS, ftsMinFiles: 1 }
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-x1-')))
  const root = join(dir, 'repo'), data = join(dir, 'data'), other = join(dir, 'other')
  await mkdir(root); await mkdir(data)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
  git('init', '--template=', '-b', 'main'); git('config', 'user.name', 'X1 fixture'); git('config', 'user.email', 'x1@example.invalid')
  const database = join(data, 'index.sqlite'), scrubber = new SecretScrubber()
  const allow = async (text: string) => scrubber.isReady() && scrubber.scrub(text) === text
  const request = (kind: IndexWorkerData['request']['kind'], tree = root, extra = {}) => ({ request: { kind, root: tree, ...extra }, database, settings })
  const run = (kind: IndexWorkerData['request']['kind'], tree = root, extra = {}) => executeIndex(request(kind, tree, extra), allow)
  const search = async (tree = root, text = 'Needle') => (await run('search', tree, { text }) as SearchResult).hits.map(h => `${h.path}:${h.line}:${h.text}`).sort()
  return { dir, root, other, data, git, database, scrubber, allow, request, run, search, close: () => rm(dir, { recursive: true, force: true }) }
}

test('freshness exactly matches two real worktrees after branch switches, edit, delete and rename', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'shared.ts'), 'export function sharedNeedle() {}\n')
    await writeFile(join(f.root, 'old.ts'), 'export const oldNeedle = 1\n')
    f.git('add', '.'); f.git('commit', '-m', 'base'); const base = f.git('rev-parse', 'HEAD')
    f.git('worktree', 'add', '-b', 'feature', f.other)
    await writeFile(join(f.other, 'feature.py'), 'def featureNeedle(): pass\n')
    f.git('-C', f.other, 'add', '.'); f.git('-C', f.other, 'commit', '-m', 'feature')
    await f.run('build'); await f.run('build', f.other)
    const common = ['old.ts:1:export const oldNeedle = 1', 'shared.ts:1:export function sharedNeedle() {}']
    assert.deepEqual(await f.search(), common)
    assert.deepEqual(await f.search(f.other), [...common, 'feature.py:1:def featureNeedle(): pass'].sort())
    // Before any refresh, live content must supply new hits and hide old ones.
    await writeFile(join(f.root, 'old.ts'), 'export const editedNeedle = 2\n')
    await rename(join(f.other, 'old.ts'), join(f.other, 'renamed.ts'))
    await rm(join(f.other, 'shared.ts'))
    assert.deepEqual(await f.search(), ['old.ts:1:export const editedNeedle = 2', 'shared.ts:1:export function sharedNeedle() {}'])
    assert.deepEqual(await f.search(f.other), ['feature.py:1:def featureNeedle(): pass', 'renamed.ts:1:export const oldNeedle = 1'])
    f.git('checkout', '-b', 'alternate', base)
    f.git('-C', f.other, 'reset', '--hard'); f.git('-C', f.other, 'clean', '-fd'); f.git('-C', f.other, 'checkout', '-b', 'second', base)
    await f.run('build', f.other)
    assert.deepEqual(await f.search(f.other), common)
    assert.deepEqual(await f.search(), ['old.ts:1:export const editedNeedle = 2', 'shared.ts:1:export function sharedNeedle() {}'])
    await f.run('build')
    const db = new DatabaseSync(f.database, { readOnly: true })
    const manifests = db.prepare('SELECT path FROM files WHERE root_key = ? ORDER BY path').all((await import('../../src/indexing/snapshot.ts')).hash(f.root))
    assert.deepEqual(manifests.map(r => r.path), ['old.ts', 'shared.ts'])
    db.close()
  } finally { await f.close() }
})

test('content and FTS rows are stored once across worktrees; incremental builds reuse symbol rows', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.ts'), 'export function sharedNeedle() {}')
    f.git('add', '.'); f.git('commit', '-m', 'base'); f.git('worktree', 'add', '-b', 'other', f.other)
    await f.run('build'); await f.run('build', f.other)
    const guard = new DatabaseSync(f.database)
    guard.exec("CREATE TRIGGER forbid_reparse BEFORE INSERT ON maps BEGIN SELECT RAISE(ABORT, 'cached_symbols_reparsed'); END")
    guard.close()
    await f.run('build')
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.equal(db.prepare('SELECT count(*) n FROM contents').get()!.n, 1)
    assert.equal(db.prepare('SELECT count(*) n FROM maps').get()!.n, 1)
    assert.equal(db.prepare('SELECT count(*) n FROM fulltext').get()!.n, 1)
    assert.equal(db.prepare('SELECT count(*) n FROM files').get()!.n, 2)
    assert.equal(db.prepare('SELECT count(*) n FROM roots').get()!.n, 2)
    db.close()
  } finally { await f.close() }
})

async function workerCrash(data: IndexWorkerData): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../../src/indexing/worker.ts', import.meta.url), { workerData: data })
    w.on('message', m => { if (m.kind === 'check') w.postMessage({ id: m.id, allowed: true }) })
    w.once('error', reject); w.once('exit', resolve)
  })
}
for (const crashPoint of ['content', 'manifest'] as const) test(`crash recovery at ${crashPoint} keeps an atomic manifest and rebuilds cleanly`, async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const beforeNeedle = 1')
    await f.run('build')
    const before = new DatabaseSync(f.database, { readOnly: true })
    const old = before.prepare('SELECT * FROM files').all(); before.close()
    await writeFile(join(f.root, 'a.ts'), 'export const afterNeedle = 2')
    assert.equal(await workerCrash({ ...f.request('build'), crashPoint }), 86)
    const crashed = new DatabaseSync(f.database, { readOnly: true })
    assert.equal(crashed.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    assert.deepEqual(crashed.prepare('SELECT * FROM files').all(), old)
    crashed.close()
    await f.run('build')
    assert.deepEqual(await f.search(), ['a.ts:1:export const afterNeedle = 2'])
    assert.equal((await f.run('map') as MapResult).provenance.coverage.indexed, 1)
  } finally { await f.close() }
})

test('ignored files, nested negations, .env variants, symlinks, binary and registered values never enter stored rows', async () => {
  const f = await fixture()
  try {
    const secret = `fixture-${randomUUID()}`
    f.scrubber.register('secret://x1-fixture', secret)
    await writeFile(join(f.root, '.gitignore'), '*.skip\nignored/\n')
    await mkdir(join(f.root, 'nested')); await mkdir(join(f.root, 'ignored'))
    await writeFile(join(f.root, 'nested', '.gitignore'), '!keep.skip\n')
    await writeFile(join(f.root, 'nested', 'keep.skip'), 'Needle keep')
    await writeFile(join(f.root, 'nested', 'no.skip'), 'Needle skip')
    await writeFile(join(f.root, 'ignored', 'no.ts'), 'Needle ignored')
    await writeFile(join(f.root, 'value.ts'), `const a = '${secret}'`)
    await writeFile(join(f.root, `${secret}.ts`), 'Needle secret path')
    for (const path of ['.env', '.env.local', '.env.example', 'file.skip']) await writeFile(join(f.root, path), 'Needle forbidden')
    // Tracked files are still excluded by policy, regardless of git ls-files.
    f.git('add', '-f', '.env', 'file.skip')
    await writeFile(join(f.root, 'binary'), Buffer.from([1, 0, 2]))
    await writeFile(join(f.root, 'ok.ts'), 'Needle allowed')
    await writeFile(join(f.data, 'outside'), 'Needle outside')
    await symlink(join(f.data, 'outside'), join(f.root, 'link.ts'))
    await f.run('build')
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.deepEqual(db.prepare('SELECT path FROM files ORDER BY path').all().map(r => r.path), ['.gitignore', 'nested/.gitignore', 'nested/keep.skip', 'ok.ts'])
    for (const table of ['contents', 'files', 'maps', 'fulltext']) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
      assert.equal(rows.includes(secret), false, table)
      for (const forbidden of ['Needle forbidden', 'Needle outside', 'Needle ignored', 'Needle skip']) assert.equal(rows.includes(forbidden), false, `${table}: ${forbidden}`)
    }
    db.close()
    assert.deepEqual(await f.search(), ['nested/keep.skip:1:Needle keep', 'ok.ts:1:Needle allowed'])
  } finally { await f.close() }
})

test('FTS threshold is a setting, short queries and unavailable DB use literal Node fallback', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.ts'), 'Needle "quoted" a%_b \u754c\u4e16\u597d x')
    const noDb = await f.run('search', f.root, { text: 'Needle' }) as SearchResult
    assert.equal(noDb.engine, 'node-grep'); assert.equal(noDb.hits.length, 1)
    await executeIndex({ ...f.request('build'), settings: { ...settings, ftsMinFiles: 2 } }, f.allow)
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.equal(db.prepare('SELECT count(*) n FROM fulltext').get()!.n, 0); db.close()
    await f.run('build')
    for (const text of ['Needle', '"quoted"', 'a%_b', '\u754c\u4e16\u597d', 'x']) {
      const result = await f.run('search', f.root, { text }) as SearchResult
      assert.equal(result.hits.length, 1, text)
      assert.equal(result.engine, text === 'x' ? 'node-grep' : 'fts5+grep')
    }
    const miss = await f.run('search', f.root, { text: 'absent' }) as SearchResult
    assert.equal(miss.hits.length, 0)
    assert.equal(miss.provenance.indexAgeMs !== null, true)
    assert.equal(miss.provenance.coverage.indexed, 1)
  } finally { await f.close() }
})

test('a package.json ancestor of the data directory cannot break the worker', async () => {
  const f = await fixture(), governor = new ResourceGovernor()
  // The lane layout puts the data directory inside a checkout with its own
  // package.json. The worker runtime needs its own package scope so Node stops
  // there instead of reading that ancestor, which the sandbox forbids.
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor, ephemeral: true })
  try {
    await writeFile(join(f.dir, 'package.json'), '{"name":"checkout","private":true}\n')
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1\n')
    const result = await service.search(f.root, 'Needle')
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0]!.path, 'a.ts')
  } finally { await service.close(); await governor.close(); await f.close() }
})

test('tree-sitter covers the required languages and degrades when a grammar is missing', async () => {
  const examples = [
    ['typescript', 'export function Orbit() {}'], ['tsx', 'export function Orbit() { return <div/> }'],
    ['javascript', 'function Orbit() {}'], ['python', 'def Orbit():\n  pass'], ['go', 'package a\nfunc Orbit() {}'],
    ['rust', 'fn Orbit() {}'], ['java', 'class Orbit { void call() {} }'], ['c', 'int Orbit() { return 0; }'], ['cpp', 'class Orbit {};'],
  ]
  for (const [language, text] of examples) {
    const result = await symbols(text!, language!)
    assert.equal(result.source, 'tree-sitter', language)
    assert.ok(result.entries.some(s => s.name.includes('Orbit')), `${language}: ${JSON.stringify(result.entries)}`)
  }
  assert.deepEqual(await symbols('class Orbit {}', 'java', ['java']), { entries: [], source: 'file' })
  const headings = await symbols('# Orbit\n```ts\n# Hidden\n```\nSecond\n---\n', 'markdown')
  assert.deepEqual(headings.entries.map(s => s.name), ['Orbit', 'Second'])
})

test('complete repo.map JSON respects its stated token bound, including unicode, metadata and empty output', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 30; i++) await writeFile(join(f.root, `${i}-\u754c.ts`), `export function symbol${i}() {}`)
    await f.run('build')
    for (const budget of [600, 1000, 2000, 20_000]) {
      const result = await f.run('map', f.root, { budget }) as MapResult
      assert.equal(result.tokenBound, budget)
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= result.tokenBound)
      assert.equal(result.truncated, budget < 20_000)
      assert.equal(result.provenance.coverage.symbols, 30)
    }
    await assert.rejects(f.run('map', f.root, { budget: 1 }), /index_budget_too_small/)
    const base = await f.run('map', f.root, { budget: 20_000 }) as MapResult
    assert.throws(() => boundMap(base, NaN), /budget_invalid/)
    let edge = 3000
    for (let i = 0; i < 4; i++) edge = Buffer.byteLength(JSON.stringify({ ...base, tokenBound: edge })) - 1
    const edgeResult = boundMap(structuredClone(base), edge)
    assert.equal(edgeResult.truncated, true)
    const units = (m: MapResult) => m.entries.length + m.entries.reduce((n, e) => n + e.symbols.length, 0)
    assert.ok(units(edgeResult) < units(base), 'truncated must omit content even at a one-byte metadata boundary')
  } finally { await f.close() }
})

test('IX3 stays absent with the flag unset, false and true; no vector store or model dispatch exists', async () => {
  const f = await fixture()
  const transport = mock.method(globalThis, 'fetch', async () => new Response('fixture'))
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1')
    for (const embeddings of [undefined, false, true]) {
      const result = await executeIndex({ ...f.request('build'), embeddings }, f.allow) as { embeddings: boolean }
      assert.equal(result.embeddings, false)
    }
    assert.equal(transport.mock.callCount(), 0, 'no embedding transport is dispatched')
    transport.mock.restore()
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%embed%' OR name LIKE '%vector%'").all(), [])
    db.close()
    assert.deepEqual((await readdir(f.data)).filter(n => /embed|vector/.test(n)), [])
  } finally { transport.mock.restore(); await f.close() }
})

const green = async () => ({ observedAt: new Date().toISOString(), source: 'fixture', confidence: 'observed' as const, memoryAvailableFraction: 0.8, cpuBusyFraction: 0.1, thermal: 'nominal' as const, foreground: 'active' as const, allowed: true })
test('worker service builds automatically, never writes read-only roots, and closes without live workers', async () => {
  const f = await fixture()
  const governor = new ResourceGovernor()
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor, settings: { ftsMinFiles: 1, pollMs: 50 }, headroom: green })
  try {
    await writeFile(join(f.root, 'a.ts'), 'export function Needle() {}')
    await chmod(join(f.root, 'a.ts'), 0o400); await chmod(f.root, 0o500)
    const before = await readdir(f.root)
    await service.track(f.root)
    const deadline = Date.now() + 10_000
    while (service.status().build !== 'complete' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    assert.equal(service.status().build, 'complete')
    const result = await service.map(f.root, 2000)
    assert.equal(result.entries[0]!.symbols[0]!.name, 'Needle')
    assert.deepEqual(await readdir(f.root), before)
    assert.equal(await readFile(join(f.root, 'a.ts'), 'utf8'), 'export function Needle() {}')
    assert.equal(service.database.startsWith(f.data), true)
    await assert.rejects(service.track(f.dir), /index_root_denied/)
  } finally { await service.close(); await governor.close(); await chmod(f.root, 0o700); await f.close() }
})

test('headroom denial defers indexing; cancellation interrupts worker and permits a clean rebuild', async () => {
  const f = await fixture(), governor = new ResourceGovernor()
  let allowed = false
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor, settings: { pollMs: 60_000 }, headroom: async () => ({ ...await green(), allowed }) })
  try {
    await writeFile(join(f.root, 'a.ts'), 'export function Needle() {}')
    await assert.rejects(service.build(f.root), /index_headroom/)
    assert.equal(service.status().build, 'deferred')
    assert.equal((await service.search(f.root, 'Needle')).hits.length, 1)
    allowed = true
    const control = new AbortController(); control.abort()
    await assert.rejects(service.build(f.root, control.signal))
    await service.build(f.root)
    assert.equal((await service.map(f.root)).provenance.coverage.indexed, 1)
  } finally { await service.close(); await governor.close(); await f.close() }
})

test('governor idle lease is preemptible, cannot overlap another idle writer, and never blocks interactive admission', async () => {
  const governor = new ResourceGovernor()
  let aborted = 0
  const idle = governor.tryIdleLease(() => { aborted++ })!
  assert.ok(idle)
  assert.equal(governor.tryIdleLease(() => {}), null)
  const ticket = governor.enqueue({ owner: { kind: 'operation', operationId: 'interactive' }, operation: 'chat', model: { provider: 'ollama', name: 'fixture' }, requestedContext: 1, priority: 'normal', enqueuedAt: new Date().toISOString() })
  const interactive = await governor.acquire(ticket)
  assert.equal(aborted, 1)
  assert.equal(interactive.state, 'active')
  assert.equal(governor.tryIdleLease(() => {}), null)
  interactive.release()
  assert.equal(governor.tryIdleLease(() => {}), null, 'preempted owner still holds lease until actual release')
  idle.release(); idle.release()
  const next = governor.tryIdleLease(() => { aborted++ })!
  assert.ok(next)
  let closed = false
  const close = governor.close().then(() => { closed = true })
  await new Promise(r => setImmediate(r))
  assert.equal(closed, false)
  next.release(); await close
  assert.equal(closed, true)
  assert.equal(aborted, 2)
})


test('late secret registration and new ignore rules purge unreferenced stored content on rebuild', async () => {
  const f = await fixture()
  try {
    const value = `late-${randomUUID()}`
    await writeFile(join(f.root, 'a.ts'), value)
    await writeFile(join(f.root, 'b.ts'), 'forbidden-on-refresh')
    await f.run('build')
    f.scrubber.register('secret://late', value)
    assert.deepEqual(await f.search(f.root, value), [])
    await writeFile(join(f.root, '.gitignore'), 'b.ts\n')
    await f.run('build')
    const db = new DatabaseSync(f.database, { readOnly: true })
    for (const table of ['files', 'contents', 'maps', 'fulltext']) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
      assert.equal(rows.includes(value), false, table)
      assert.equal(rows.includes('forbidden-on-refresh'), false, table)
    }
    assert.deepEqual(db.prepare('SELECT path FROM files').all().map(r => r.path), ['.gitignore'])
    db.close()
  } finally { await f.close() }
})


test('an in-flight worker cancellation releases the idle lease only after termination', async () => {
  const f = await fixture(), governor = new ResourceGovernor(), control = new AbortController()
  let checks = 0
  const scrubber = f.scrubber.facade()
  const service = new ProjectIndex({ dataDir: f.data, governor, settings: { pollMs: 60_000 }, headroom: green,
    scrubber: { ...scrubber, scrub: value => { checks++; if (checks === 1) control.abort(); return scrubber.scrub(value) } } })
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1')
    await assert.rejects(service.build(f.root, control.signal), /index_cancelled|index_interrupted/)
    assert.ok(checks > 0, 'cancellation reached a live worker')
    await service.build(f.root)
    assert.equal(service.status().build, 'complete')
  } finally { await service.close(); await governor.close(); await f.close() }
})


test('adaptive headroom permits active use, rejects pressure and reserves more for unknown observations', () => {
  const sample = { memoryAvailableFraction: 0.4, cpuBusyFraction: 0.4, thermal: 'nominal' as const, foreground: 'active' as const }
  assert.equal(hasHeadroom(sample), true, 'active foreground is not an idle-only rule')
  assert.equal(hasHeadroom({ ...sample, memoryAvailableFraction: 0.1 }), false)
  assert.equal(hasHeadroom({ ...sample, cpuBusyFraction: 0.8 }), false)
  assert.equal(hasHeadroom({ ...sample, thermal: 'pressure' }), false)
  assert.equal(hasHeadroom({ ...sample, foreground: 'idle', cpuBusyFraction: 0.8, memoryAvailableFraction: 0.1 }), true)
  assert.equal(hasHeadroom({ ...sample, foreground: 'unknown', memoryAvailableFraction: 0.1 }), false)
  assert.equal(hasHeadroom({ ...sample, foreground: 'idle', thermal: 'unknown', cpuBusyFraction: 0.8 }), false)
})

test('empty/uninitialized/malformed sidecars cannot disable IX0 or file-level maps', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1')
    const empty = new DatabaseSync(f.database); empty.close()
    assert.deepEqual(await f.search(), ['a.ts:1:export const Needle = 1'])
    const map = await f.run('map') as MapResult
    assert.equal(map.entries.length, 1); assert.equal(map.provenance.indexAgeMs, null)
    const malformed = new DatabaseSync(f.database); malformed.exec('PRAGMA user_version = 1'); malformed.close()
    assert.deepEqual(await f.search(), ['a.ts:1:export const Needle = 1'])
  } finally { await f.close() }
})

test('a content-changing branch switch is visible before rebuild with current and indexed commits', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'main.ts'), 'mainNeedle')
    f.git('add', '.'); f.git('commit', '-m', 'main'); const main = f.git('rev-parse', 'HEAD')
    f.git('checkout', '-b', 'changed')
    await rm(join(f.root, 'main.ts')); await writeFile(join(f.root, 'other.ts'), 'otherNeedle')
    f.git('add', '-A'); f.git('commit', '-m', 'changed'); const changed = f.git('rev-parse', 'HEAD')
    f.git('checkout', 'main'); f.git('worktree', 'add', '-b', 'parallel', f.other)
    await f.run('build'); await f.run('build', f.other)
    f.git('checkout', 'changed')
    const result = await f.run('search', f.root, { text: 'Needle' }) as SearchResult
    assert.deepEqual(result.hits.map(h => [h.path, h.text]), [['other.ts', 'otherNeedle']])
    assert.equal(result.provenance.commit, changed)
    assert.equal(result.provenance.indexCommit, main)
    assert.deepEqual(await f.search(f.other), ['main.ts:1:mainNeedle'])
    assert.equal(result.provenance.coverage.indexed, 0)
  } finally { await f.close() }
})

test('a parent swapped to an outside symlink between containment and open cannot supply indexed bytes', async () => {
  const f = await fixture()
  try {
    const { readProjectFile } = await import('../../src/indexing/snapshot.ts')
    await mkdir(join(f.root, 'nested')); await mkdir(join(f.data, 'outside'))
    await writeFile(join(f.root, 'nested', 'a.ts'), 'allowed')
    await writeFile(join(f.data, 'outside', 'a.ts'), 'outsideNeedle')
    const content = await readProjectFile(f.root, 'nested/a.ts', settings.maxFileBytes, async () => {
      await rename(join(f.root, 'nested'), join(f.root, 'old'))
      await symlink(join(f.data, 'outside'), join(f.root, 'nested'))
    })
    assert.equal(content, null)
    await f.run('build')
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM contents').all()).includes('outsideNeedle'), false)
    db.close()
  } finally { await f.close() }
})

test('oversized ignore policy fails closed and does not turn exclusions into indexed files', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, '.gitignore'), 'private.txt\n#' + 'padding'.repeat(30))
    await writeFile(join(f.root, 'private.txt'), 'Needle')
    await executeIndex({ ...f.request('build'), settings: { ...settings, maxFileBytes: 32 } }, f.allow)
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.equal(db.prepare('SELECT count(*) n FROM files').get()!.n, 0)
    assert.equal(db.prepare('SELECT count(*) n FROM contents').get()!.n, 0)
    db.close()
  } finally { await f.close() }
})

test('close waits for invocations that have not created a worker and removes their captured runtime', async () => {
  const f = await fixture(), governor = new ResourceGovernor()
  const service = new ProjectIndex({ dataDir: f.data, governor, scrubber: f.scrubber, settings: { pollMs: 60_000 }, headroom: green })
  try {
    await writeFile(join(f.root, 'a.ts'), 'Needle')
    const query = service.search(f.root, 'Needle')
    const outcome = query.then(() => 'completed', () => 'cancelled')
    await service.close()
    await outcome
    await new Promise(r => setImmediate(r))
    assert.equal((await readdir(f.data)).some(n => n.startsWith('index-runtime-')), false)
    await assert.rejects(service.search(f.root, 'Needle'))
    assert.equal(service.close(), service.close())
  } finally { await service.close(); await governor.close(); await f.close() }
})

test('FTS candidate and coverage reads share a snapshot while another builder adds postings', async () => {
  const f = await fixture()
  const { IndexStore } = await import('../../src/indexing/store.ts')
  const original = IndexStore.prototype.fts
  let inserted = false
  const hook = mock.method(IndexStore.prototype, 'fts', function(this: InstanceType<typeof IndexStore>, text: string) {
    const candidates = original.call(this, text)
    const writer = new DatabaseSync(f.database)
    const row = writer.prepare('SELECT hash, text FROM contents').get()!
    writer.prepare('INSERT INTO fulltext(hash, text) VALUES (?, ?)').run(row.hash!, row.text!)
    writer.close(); inserted = true
    return candidates
  })
  try {
    await writeFile(join(f.root, 'a.ts'), 'Needle')
    await executeIndex({ ...f.request('build'), settings: { ...settings, ftsMinFiles: 2 } }, f.allow)
    assert.deepEqual(await f.search(), ['a.ts:1:Needle'])
    assert.equal(inserted, true)
  } finally { hook.mock.restore(); await f.close() }
})

test('unchanged content is not parsed again across builds or worktrees', async () => {
  const f = await fixture(), parse = mock.fn(symbols)
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1')
    f.git('add', '.'); f.git('commit', '-m', 'base'); f.git('worktree', 'add', '-b', 'other', f.other)
    await executeIndex(f.request('build'), f.allow, undefined, parse)
    assert.equal(parse.mock.callCount(), 1)
    await executeIndex(f.request('build', f.other), f.allow, undefined, parse)
    await executeIndex(f.request('build'), f.allow, undefined, parse)
    assert.equal(parse.mock.callCount(), 1)
    await writeFile(join(f.root, 'a.ts'), 'export const changedNeedle = 1')
    await executeIndex(f.request('build'), f.allow, undefined, parse)
    assert.equal(parse.mock.callCount(), 2)
  } finally { await f.close() }
})

test('registration after content commit purges all worktree references even when the build fails', async () => {
  const f = await fixture()
  try {
    const value = `during-${randomUUID()}`
    await writeFile(join(f.root, 'a.ts'), value)
    f.git('add', '.'); f.git('commit', '-m', 'base'); f.git('worktree', 'add', '-b', 'other', f.other)
    await f.run('build'); await f.run('build', f.other)
    let checkpoints = 0
    await assert.rejects(executeIndex(f.request('build'), f.allow, async () => {
      if (++checkpoints === 2) f.scrubber.register('secret://during', value)
    }), /index_tree_changed/)
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.equal(db.prepare('SELECT count(*) n FROM files').get()!.n, 0)
    for (const table of ['contents', 'maps', 'fulltext']) assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(value), false)
    db.close()
  } finally { await f.close() }
})

test('the scanner OS boundary denies ancestor symlink escapes and root writes', async () => {
  const f = await fixture()
  const { indexProcess, stopIndexProcess } = await import('../../src/indexing/process.ts')
  try {
    await mkdir(join(f.data, 'runtime')); await mkdir(join(f.data, 'outside'))
    await writeFile(join(f.root, 'allowed'), 'inside')
    await writeFile(join(f.data, 'outside', 'private'), 'outsideNeedle')
    await symlink(join(f.data, 'outside'), join(f.root, 'nested'))
    const entry = join(f.data, 'runtime', 'probe.mjs')
    await writeFile(entry, `import {readFile,writeFile} from 'node:fs/promises';process.once('message',async()=>{const result={inside:await readFile(${JSON.stringify(join(f.root, 'allowed'))},'utf8'),escape:false,write:false};try{await readFile(${JSON.stringify(join(f.root, 'nested', 'private'))},'utf8');result.escape=true}catch{}try{await writeFile(${JSON.stringify(join(f.root, 'new'))},'bad');result.write=true}catch{}process.send(result);process.disconnect()})`)
    const child = await indexProcess(entry, f.root, f.data)
    try {
      const result = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('close', () => reject(new Error('probe_closed'))); child.send({ start: true }) })
      assert.deepEqual(result, { inside: 'inside', escape: false, write: false })
    } finally { await stopIndexProcess(child) }
  } finally { await f.close() }
})

test('shrinking headroom preempts a running build and allows a later healthy rebuild', async () => {
  const f = await fixture(), governor = new ResourceGovernor()
  let samples = 0, shrink = true
  const service = new ProjectIndex({ dataDir: f.data, governor, scrubber: f.scrubber, settings: { pollMs: 60_000 }, headroomPollMs: 5,
    headroom: async () => ({ ...await green(), allowed: !shrink || ++samples === 1 }) })
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1')
    await assert.rejects(service.build(f.root), /index_cancelled|index_interrupted/)
    assert.ok(samples >= 2)
    assert.equal(service.status().headroom!.allowed, false)
    shrink = false
    await service.build(f.root)
    assert.equal(service.status().build, 'complete')
  } finally { await service.close(); await governor.close(); await f.close() }
})
