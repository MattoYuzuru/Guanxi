import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { projectFingerprint } from '../../src/indexing/snapshot.ts'
import { DEFAULT_INDEX_SETTINGS } from '../../src/indexing/types.ts'
import { DatabaseSync } from 'node:sqlite'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { ProjectIndex, type IndexEvent } from '../../src/indexing/service.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'

const green = async () => ({ observedAt: new Date().toISOString(), source: 'fixture', confidence: 'observed' as const, memoryAvailableFraction: 0.8, cpuBusyFraction: 0.1, thermal: 'nominal' as const, foreground: 'active' as const, allowed: true })
async function waitFor(predicate: () => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture_timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function ftsShadow(db: DatabaseSync): Buffer {
  const parts: Buffer[] = []
  for (const table of ['fulltext_data', 'fulltext_idx']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[]) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) parts.push(Buffer.from(value))
        else if (typeof value === 'string') parts.push(Buffer.from(value))
      }
    }
  }
  return Buffer.concat(parts)
}
async function fixture(files = 200) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-x1-service-')))
  const root = join(dir, 'repo'), data = join(dir, 'data')
  await mkdir(root); await mkdir(data)
  await Promise.all(Array.from({ length: files }, (_, index) => writeFile(join(root, `f${index}.ts`), `export const value${index} = ${index}\n`)))
  const scrubber = new SecretScrubber(), governor = new ResourceGovernor()
  return { dir, root, data, scrubber, governor, close: () => rm(dir, { recursive: true, force: true }) }
}

test('two unchanged ticks build and publish once; a change rebuilds; a deleted root is untracked', async () => {
  const f = await fixture()
  const events: IndexEvent[] = []
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor, settings: { pollMs: 50 }, headroom: green, onIndexEvent: event => events.push(event) })
  const count = (type: IndexEvent['type']) => events.filter(event => event.type === type).length
  try {
    await service.track(f.root)
    await waitFor(() => count('publish') === 1)
    // Two further ticks must skip without a build, purge or manifest rewrite.
    await waitFor(() => count('skip') >= 2)
    assert.equal(count('build'), 1)
    assert.equal(count('publish'), 1)
    const first = new DatabaseSync(service.database, { readOnly: true })
    const indexedAt = first.prepare('SELECT indexed_at FROM roots').get()!.indexed_at
    first.close()
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(count('build'), 1)
    const unchanged = new DatabaseSync(service.database, { readOnly: true })
    assert.equal(unchanged.prepare('SELECT indexed_at FROM roots').get()!.indexed_at, indexedAt)
    unchanged.close()
    await writeFile(join(f.root, 'f0.ts'), 'export const changedNeedle = 0\n')
    await waitFor(() => count('publish') === 2)
    assert.equal(count('build'), 2)
    // Remove the root name atomically: recursive rm exposes partially deleted
    // trees to a tick, which legitimately admits another changed-tree build.
    const removed = join(f.dir, 'removed')
    await rename(f.root, removed)
    await rm(removed, { recursive: true, force: true })
    await waitFor(() => count('untrack') === 1)
    await service.untrack(f.root)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(count('build'), 2)
    assert.equal(service.status().roots, 0)
  } finally { await service.close(); await f.governor.close(); await f.close() }
})

test('a newly registered value invalidates an unchanged fingerprint and purges stored rows', async () => {
  const f = await fixture(2)
  const events: IndexEvent[] = []
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor, settings: { pollMs: 50 }, headroom: green, onIndexEvent: event => events.push(event) })
  try {
    const value = `service-${randomUUID()}`
    await writeFile(join(f.root, 'secret.ts'), value)
    await writeFile(join(f.root, 'ok.ts'), 'export const Needle = 1\n')
    await service.track(f.root)
    await waitFor(() => events.filter(event => event.type === 'publish').length === 1)
    f.scrubber.register('secret://service', value)
    await waitFor(() => events.filter(event => event.type === 'publish').length === 2)
    const db = new DatabaseSync(service.database, { readOnly: true })
    try {
      for (const table of ['contents', 'files', 'maps', 'fulltext']) {
        const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
        assert.equal(rows.includes(value), false, table)
      }
      assert.equal(ftsShadow(db).includes(Buffer.from(value)), false, 'fulltext shadow')
    } finally { db.close() }
  } finally { await service.close(); await f.governor.close(); await f.close() }
})

test('overlapping builds share one writer and release the idle lease', async () => {
  const f = await fixture(1), events: IndexEvent[] = []
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor,
    settings: { pollMs: 60_000 }, headroom: green, onIndexEvent: event => events.push(event) })
  try {
    await Promise.all([service.build(f.root), service.build(f.root)])
    assert.equal(events.filter(event => event.type === 'build').length, 1)
    assert.equal(events.filter(event => event.type === 'publish').length, 1)
    assert.equal(events.filter(event => event.type === 'skip').length, 1)
    const lease = f.governor.tryIdleLease(() => {})
    assert.ok(lease, 'both callers settled after the writer released its lease')
    lease.release()
  } finally { await service.close(); await f.governor.close(); await f.close() }
})

test('reopening an unchanged root with a lower FTS threshold rebuilds its postings', async () => {
  const f = await fixture(1), events: IndexEvent[] = []
  const first = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor,
    settings: { pollMs: 60_000, ftsMinFiles: 2 }, headroom: green })
  let second: ProjectIndex | undefined
  try {
    await first.build(f.root)
    await first.close()
    const before = new DatabaseSync(first.database, { readOnly: true })
    assert.equal(before.prepare('SELECT count(*) n FROM fulltext').get()!.n, 0)
    before.close()
    second = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor,
      settings: { pollMs: 60_000, ftsMinFiles: 1 }, headroom: green, onIndexEvent: event => events.push(event) })
    await second.build(f.root)
    assert.equal(events.filter(event => event.type === 'publish').length, 1)
    const after = new DatabaseSync(second.database, { readOnly: true })
    assert.equal(after.prepare('SELECT count(*) n FROM fulltext').get()!.n, 1)
    after.close()
  } finally { await first.close(); await second?.close(); await f.governor.close(); await f.close() }
})

test('untracking a queued root prevents an older tick from building or publishing it', async () => {
  const f = await fixture(1), events: IndexEvent[] = []
  const other = join(f.dir, 'other')
  await mkdir(other); await writeFile(join(other, 'b.ts'), 'export const other = 1')
  f.scrubber.expect('fixture')
  let removed = false
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor,
    settings: { pollMs: 50 }, onIndexEvent: event => events.push(event), headroom: async () => {
      if (!removed) removed = await service.untrack(other)
      return green()
    } })
  try {
    // Readiness holds the first tick until both roots are in its snapshot.
    await service.track(f.root); await service.track(other)
    f.scrubber.ready('fixture')
    await waitFor(() => events.some(event => event.type === 'skip' && event.root === f.root))
    assert.equal(removed, true)
    assert.equal(events.filter(event => event.root === other && (event.type === 'build' || event.type === 'publish')).length, 0)
    const db = new DatabaseSync(service.database, { readOnly: true })
    try { assert.equal(db.prepare('SELECT count(*) n FROM roots').get()!.n, 1) } finally { db.close() }
    assert.equal(service.status().roots, 1)
  } finally { await service.close(); await f.governor.close(); await f.close() }
})

test('untracking cancels an idle build already queued behind an explicit build', async () => {
  const f = await fixture(1), events: IndexEvent[] = []
  const other = join(f.dir, 'other')
  await mkdir(other); await writeFile(join(other, 'b.ts'), 'export const other = 1')
  let resume!: () => void, samples = 0
  const headroom = new Promise<void>(resolve => { resume = resolve })
  const service = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor,
    settings: { pollMs: 60_000 }, onIndexEvent: event => events.push(event), headroom: async () => {
      if (++samples === 1) await headroom
      return green()
    } })
  let build: Promise<unknown> | undefined
  try {
    build = service.build(f.root)
    await waitFor(() => samples === 1)
    await service.track(other)
    await waitFor(() => (Reflect.get(service, 'pending') as Set<Promise<unknown>>).size === 2)
    assert.equal(await service.untrack(other), true)
    resume(); await build
    await waitFor(() => !Reflect.get(service, 'building'))
    assert.equal(events.filter(event => event.root === other && (event.type === 'build' || event.type === 'publish')).length, 0)
    const db = new DatabaseSync(service.database, { readOnly: true })
    try { assert.equal(db.prepare('SELECT count(*) n FROM roots').get()!.n, 1) } finally { db.close() }
  } finally { resume(); await build?.catch(() => {}); await service.close(); await f.governor.close(); await f.close() }
})

test('a root removed during the sandboxed fingerprint cannot publish a partial tree', async () => {
  const f = await fixture(1), events: IndexEvent[] = []
  let moved = false, admissions = 0, checks = 0
  const facade = f.scrubber.facade()
  const service = new ProjectIndex({ dataDir: f.data, governor: f.governor, settings: { pollMs: 60_000 },
    onIndexEvent: event => events.push(event), headroom: async () => { admissions++; return green() },
    scrubber: { ...facade, snapshot: () => {
      // The second registration snapshot answers the fingerprint worker's
      // first policy/path check, after its read-only sandbox has started.
      if (++checks === 2) { renameSync(f.root, join(f.dir, 'removed')); moved = true }
      return facade.snapshot!()
    } } })
  try {
    await assert.rejects(service.build(f.root), /index_unavailable|index_tree_changed/)
    assert.equal(moved, true)
    assert.ok(admissions >= 1, 'fingerprint and headroom resampling share idle admission')
    const lease = f.governor.tryIdleLease(() => {})
    assert.ok(lease, 'root-change refusal settles after its idle lease is released')
    lease.release()
    assert.equal(events.filter(event => event.type === 'build' || event.type === 'publish').length, 0)
  } finally { await service.close(); await f.governor.close(); await f.close() }
})


test('fingerprint policy reads happen only in the sandbox, never in the server parent', async () => {
  const f = await fixture(1), events: IndexEvent[] = []
  await writeFile(join(f.root, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(f.root, 'ignored.ts'), 'excluded fixture text')
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.open, originalReadFile = fs.readFile
  let parentReads = 0
  const trap = mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (String(args[0]).startsWith(f.root + '/')) {
      mock.method(handle, 'read', async () => { parentReads++; throw new Error('fixture_parent_project_read') })
    }
    return handle
  })
  const fileTrap = mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).startsWith(f.root + '/')) { parentReads++; throw new Error('fixture_parent_project_read') }
    return originalReadFile(...args)
  })
  syncBuiltinESMExports()
  const service = new ProjectIndex({ dataDir: f.data, governor: f.governor, scrubber: f.scrubber,
    settings: { pollMs: 60_000 }, headroom: green, onIndexEvent: event => events.push(event) })
  try {
    // Positive instrumentation control: the formerly parent-side helper really
    // attempts to read the ignore policy through the trapped FileHandle.
    await projectFingerprint(f.root, DEFAULT_INDEX_SETTINGS, async () => true)
    assert.equal(parentReads, 1)
    parentReads = 0
    await service.build(f.root)
    await service.build(f.root)
    assert.equal(parentReads, 0, 'server parent must read zero project/ignore bytes')
    assert.deepEqual(events.map(event => event.type), ['build', 'publish', 'skip'])
    const db = new DatabaseSync(service.database, { readOnly: true })
    try {
      const paths = db.prepare('SELECT path FROM files ORDER BY path').all().map(row => row.path)
      assert.deepEqual(paths, ['.gitignore', 'f0.ts'])
    } finally { db.close() }
  } finally {
    trap.mock.restore(); fileTrap.mock.restore(); syncBuiltinESMExports()
    await service.close(); await f.governor.close(); await f.close()
  }
})

test('a query cannot replace its immutable root grant by recanonicalizing an outside symlink', async () => {
  const { symlink } = await import('node:fs/promises')
  const f = await fixture(1)
  const outside = join(f.dir, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'private.ts'), 'outside fixture text')
  await rename(f.root, join(f.dir, 'original')); await symlink(outside, f.root)
  const service = new ProjectIndex({ dataDir: f.data, governor: f.governor, scrubber: f.scrubber,
    settings: { pollMs: 60_000 }, headroom: green })
  try {
    await assert.rejects(service.search(f.root, 'outside'), /index_tree_changed/)
    await assert.rejects(service.map(f.root), /index_tree_changed/)
    assert.equal((Reflect.get(service, 'workers') as Set<unknown>).size, 0)
    assert.equal(Reflect.get(service, 'runtime'), undefined, 'refusal precedes sandbox grants/runtime creation')
  } finally { await service.close(); await f.governor.close(); await f.close() }
})

for (const cancel of [false, true]) test(`result validation ${cancel ? 'cancels' : 'settles'} when worker close arrives during the final root check`, async () => {
  const f = await fixture(1)
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const original = fs.lstat
  const controller = new AbortController()
  let received = false, held = false, settled = false
  let worker: import('node:child_process').ChildProcess | undefined
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const trap = mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (received && String(args[0]) === f.root && !held) {
      held = true
      // Inject the OS event ordering deterministically; natural worker lifetime
      // varies with loaded parser resources and need not close this quickly.
      queueMicrotask(() => worker!.emit('close', 0))
      await hold
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  const scrubber = f.scrubber.facade()
  const service = new ProjectIndex({ dataDir: f.data, governor: f.governor, settings: { pollMs: 60_000 }, headroom: green,
    scrubber: { ...scrubber, snapshot: () => {
      const active = [...Reflect.get(service, 'workers') as Set<import('node:child_process').ChildProcess>][0]
      if (active && !worker) {
        worker = active
        worker.prependListener('message', message => { if (message && typeof message === 'object' && 'kind' in message && message.kind === 'result') received = true })
      }
      return scrubber.snapshot!()
    } } })
  let build: Promise<unknown> | undefined
  try {
    build = service.build(f.root, controller.signal)
    void build.then(() => { settled = true }, () => { settled = true })
    await waitFor(() => held)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'a complete result must await validation rather than reject on close')
    if (cancel) controller.abort()
    release()
    if (cancel) await assert.rejects(build, /index_cancelled/)
    else { await build; assert.equal(service.status().build, 'complete') }
  } finally {
    release(); await build?.catch(() => {})
    trap.mock.restore(); syncBuiltinESMExports()
    await service.close(); await f.governor.close(); await f.close()
  }
})
