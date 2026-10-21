import { test } from 'node:test'
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
    await f.run('build'); await f.run('build', f.other); await f.run('build')
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
  } finally { await f.close() }
})

test('IX3 stays absent with the flag unset, false and true; no vector store or model dispatch exists', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'a.ts'), 'export const Needle = 1')
    for (const embeddings of [undefined, false, true]) {
      const result = await executeIndex({ ...f.request('build'), embeddings }, f.allow) as { embeddings: boolean }
      assert.equal(result.embeddings, false)
    }
    const db = new DatabaseSync(f.database, { readOnly: true })
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%embed%' OR name LIKE '%vector%'").all(), [])
    db.close()
    assert.deepEqual((await readdir(f.data)).filter(n => /embed|vector/.test(n)), [])
  } finally { await f.close() }
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
