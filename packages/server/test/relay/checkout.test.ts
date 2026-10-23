import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { OwnedCheckoutAllocator } from '../../src/relay/checkout.ts'
import type { RelayStartPolicy } from '../../src/relay/start.ts'
import { RelayError } from '../../src/relay/types.ts'
import { plan } from './fixture.ts'

const exec = promisify(execFile)
const git = async (cwd: string, args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd })).stdout.trim()
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep)
const code = (expected: string) => (error: unknown) => error instanceof RelayError && error.code === expected

async function manifest(root: string): Promise<string[]> {
  const rows: string[] = []
  const walk = async (path: string) => {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name), entry = await lstat(full)
      rows.push(`${relative(root, full)}|${entry.mode.toString(8)}|${entry.size}|${entry.mtimeMs}`)
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(root)
  return rows
}
async function files(root: string): Promise<string[]> {
  const rows: string[] = []
  const walk = async (path: string) => { for (const name of await readdir(path)) { const full = join(path, name), entry = await lstat(full); if (entry.isDirectory()) await walk(full); else rows.push(full) } }
  await walk(root); return rows
}

async function fixture(t: { after(fn: () => unknown): void }, options: { git?: string; remove?: (path: string) => Promise<void> } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-checkout-')))
  const source = join(parent, 'project'), root = join(parent, 'allowed', 'relay-checkouts')
  await mkdir(join(source, 'src'), { recursive: true }); await mkdir(join(source, 'tests'))
  await writeFile(join(source, 'src', 'main.txt'), 'base content\n'); await writeFile(join(source, 'tests', 'accept.txt'), 'acceptance\n')
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  await git(source, ['init', '-q', '-b', 'main']); await git(source, ['add', '.']); await git(source, ['commit', '-q', '-m', 'base'])
  const base = await git(source, ['rev-parse', 'HEAD'])
  await writeFile(join(source, 'src', 'future.txt'), 'the answer from the future\n'); await git(source, ['add', '.']); await git(source, ['commit', '-q', '-m', 'future'])
  const future = await git(source, ['rev-parse', 'HEAD']); await git(source, ['tag', 'v-future']); await git(source, ['branch', 'side', base])
  await writeFile(join(source, 'src', 'main.txt'), 'dirty uncommitted change\n'); await writeFile(join(source, 'untracked.txt'), 'untracked\n')
  const allocator = new OwnedCheckoutAllocator({ root, ...options })
  const policy = (patch: { base?: string; source?: string } = {}): RelayStartPolicy => ({ input: { ...({} as RelayStartPolicy['input']), plan: { ...plan, base: patch.base ?? base } },
    project: { projectId: 'p', roots: [patch.source ?? source], source: 'fixture', observedAt: Date.now() }, reserves: {} as RelayStartPolicy['reserves'], nodePorts: [] })
  t.after(async () => { await chmod(root, 0o700).catch(() => undefined); await rm(parent, { recursive: true, force: true }) })
  return { parent, source, root, base, future, allocator, policy }
}

test('allocation is an isolated clone at exactly the plan base: clean, detached, no ref, remote or later object, no path back to the source', async t => {
  const f = await fixture(t), sourceBefore = await manifest(f.source)
  const owned = await f.allocator.allocate(f.policy(), new AbortController().signal)
  const allowed = await realpath(f.root), checkout = owned.root
  assert.equal(await git(checkout, ['rev-parse', 'HEAD']), f.base)
  assert.equal(await git(checkout, ['symbolic-ref', '-q', 'HEAD']).catch(() => 'detached'), 'detached')
  assert.equal(await git(checkout, ['status', '--porcelain=v2', '--untracked-files=all']), '', 'clean tree: the source worktree changes are not carried')
  assert.equal(await readFile(join(checkout, 'src', 'main.txt'), 'utf8'), 'base content\n')
  await assert.rejects(stat(join(checkout, 'untracked.txt'))); await assert.rejects(stat(join(checkout, 'src', 'future.txt')))
  // Owner exec only: group/other bits follow the process umask (e.g. 077 on a locked-down runner).
  assert.equal((await stat(join(checkout, 'run.sh'))).mode & 0o100, 0o100, 'the executable bit is part of the base tree')
  assert.equal(await git(checkout, ['for-each-ref']), '', 'no branch, tag or remote-tracking ref'); assert.equal(await git(checkout, ['remote']), '')
  await assert.rejects(git(checkout, ['cat-file', '-e', f.future]), 'a commit newer than the base does not exist in the object store')
  assert.equal(await git(checkout, ['rev-list', '--count', 'HEAD']), '1')
  const everything = await Promise.all((await files(join(checkout, '.git'))).map(async path => (await readFile(path)).toString('latin1')))
  assert.equal(everything.some(text => text.includes(f.source)), false, 'no file under .git names the source repository')
  for (const path of await files(allowed)) assert.equal((await lstat(path)).nlink, 1, `${path} is not hardlinked (the K4 sandbox refuses writable hardlinks)`)
  assert.deepEqual(await manifest(f.source), sourceBefore, 'the source repository and worktree are untouched')
  // The layout contract RelayStarts verifies before use.
  const [root, scratch, runtimeBase] = [await realpath(owned.root), await realpath(owned.scratch), await realpath(owned.runtimeBase)]
  assert.ok(inside(allowed, root) && inside(allowed, runtimeBase) && inside(runtimeBase, scratch))
  assert.ok(!inside(runtimeBase, root) && !inside(root, runtimeBase) && root !== scratch && scratch !== runtimeBase)
  assert.ok(!inside(f.source, root) && !inside(root, f.source) && !inside(f.source, runtimeBase))
  assert.equal(dirname(dirname(root)), allowed); assert.equal((await stat(dirname(root))).mode & 0o777, 0o700)
  await owned.close()
})

test('nothing is written outside the one allocation directory, even beside the source and the allowed root', async t => {
  const f = await fixture(t), outside = (rows: string[]) => rows.filter(row => !row.startsWith('allowed|') && !row.startsWith('allowed' + sep))
  const before = outside(await manifest(f.parent))
  const owned = await f.allocator.allocate(f.policy(), new AbortController().signal)
  assert.deepEqual(outside(await manifest(f.parent)), before, 'the source, its siblings and the parent are byte- and mtime-identical')
  const entries = await readdir(await realpath(f.root)); assert.equal(entries.length, 1); assert.match(entries[0]!, /^r-/)
  assert.deepEqual((await readdir(join(f.parent, 'allowed'))).sort(), ['relay-checkouts'])
  await owned.close()
})

test('close removes the whole allocation and proves it gone; it is idempotent, handles unwritable trees, and spares other allocations', async t => {
  const f = await fixture(t)
  const first = await f.allocator.allocate(f.policy(), new AbortController().signal), second = await f.allocator.allocate(f.policy(), new AbortController().signal)
  assert.notEqual(dirname(first.root), dirname(second.root))
  await mkdir(join(first.root, 'locked', 'inner'), { recursive: true }); await writeFile(join(first.root, 'locked', 'inner', 'f'), 'x'); await chmod(join(first.root, 'locked'), 0o500)
  await chmod(join(first.scratch), 0o500)
  const closing = first.close()
  assert.equal(first.close(), closing, 'a second close is the same acknowledgement')
  await closing
  await assert.rejects(lstat(dirname(first.root)), { code: 'ENOENT' })
  assert.ok((await lstat(second.root)).isDirectory(), 'another allocation is not affected')
  await second.close()
  assert.deepEqual(await readdir(await realpath(f.root)), [])
})

test('a removal that fails is cleanup_unconfirmed and the allocation is retained; a later close can still finish', async t => {
  let failing = true
  const f = await fixture(t, { remove: async path => { if (failing) throw new Error('synthetic EBUSY'); await rm(path, { recursive: true, force: true }) } })
  const owned = await f.allocator.allocate(f.policy(), new AbortController().signal)
  await assert.rejects(owned.close(), code('cleanup_unconfirmed'))
  assert.ok((await lstat(dirname(owned.root))).isDirectory(), 'the evidence of failure is the retained directory')
  failing = false
  await owned.close()
  await assert.rejects(lstat(dirname(owned.root)), { code: 'ENOENT' })
})

test('a K4 cleanup quarantine inside the allocation blocks deletion, because a container may still hold those paths', async t => {
  const f = await fixture(t), owned = await f.allocator.allocate(f.policy(), new AbortController().signal)
  const directory = join(owned.runtimeBase, 'native-cleanup'); await mkdir(directory)
  await writeFile(join(directory, 'guanxi-exec-synthetic.json'), JSON.stringify([owned.scratch, owned.root]))
  await assert.rejects(owned.close(), code('cleanup_unconfirmed'))
  assert.ok((await lstat(owned.root)).isDirectory()); assert.ok((await lstat(join(directory, 'guanxi-exec-synthetic.json'))).isFile())
  await rm(join(directory, 'guanxi-exec-synthetic.json')); await owned.close()
  await assert.rejects(lstat(dirname(owned.root)), { code: 'ENOENT' })
})

test('only a marked directory directly under the allowed root is ever deleted; a swapped path or a forged marker is left alone', async t => {
  const f = await fixture(t), victim = join(f.parent, 'victim'); await mkdir(victim); await writeFile(join(victim, 'precious'), 'keep')
  const forged = await f.allocator.allocate(f.policy(), new AbortController().signal)
  await writeFile(join(dirname(forged.root), '.guanxi-relay-checkout.json'), JSON.stringify({ owner: 'guanxi-relay-checkout', id: 'someone-else' }))
  await assert.rejects(forged.close(), code('cleanup_unconfirmed')); assert.ok((await lstat(forged.root)).isDirectory())
  const swapped = await f.allocator.allocate(f.policy(), new AbortController().signal), real = dirname(swapped.root)
  // Even a perfect copy of the marker does not make a directory elsewhere deletable.
  await writeFile(join(victim, '.guanxi-relay-checkout.json'), await readFile(join(real, '.guanxi-relay-checkout.json')))
  await rm(real, { recursive: true, force: true }); await symlink(victim, real)
  await assert.rejects(swapped.close(), code('cleanup_unconfirmed'))
  assert.equal(await readFile(join(victim, 'precious'), 'utf8'), 'keep')
  await rm(real, { force: true })
})

test('an invalid base, a missing commit, a non-repository or an overlapping allowed root create nothing and say why', async t => {
  const f = await fixture(t), signal = new AbortController().signal
  for (const base of ['main', 'A'.repeat(40), 'abc', '']) await assert.rejects(f.allocator.allocate(f.policy({ base }), signal), code('relay_checkout_invalid'), base)
  await assert.rejects(f.allocator.allocate(f.policy({ base: 'f'.repeat(40) }), signal), code('relay_checkout_invalid'))
  const plain = join(f.parent, 'plain'); await mkdir(plain)
  await assert.rejects(f.allocator.allocate(f.policy({ source: plain }), signal), code('relay_project_unavailable'))
  const nested = new OwnedCheckoutAllocator({ root: join(f.source, '.lane-data', 'checkouts') })
  await assert.rejects(nested.allocate(f.policy(), signal), code('relay_checkout_invalid'))
  const parentRoot = new OwnedCheckoutAllocator({ root: f.parent })
  await assert.rejects(parentRoot.allocate(f.policy(), signal), code('relay_checkout_invalid'))
  assert.deepEqual(await readdir(f.root).catch(() => []), [], 'no directory survived a refused allocation')
  await assert.rejects(stat(join(f.source, '.lane-data')), { code: 'ENOENT' }, 'a refused root inside the project was not even created')
  assert.deepEqual((await readdir(f.parent)).sort(), ['allowed', 'plain', 'project'])
})

test('abort before and during the clone cleans the partial allocation, and a cleanup failure is not hidden behind the cancellation', async t => {
  const slow = join(await mkdtemp(join(tmpdir(), 'guanxi-slow-git-')), 'git')
  await writeFile(slow, '#!/bin/sh\nexec /bin/sleep 20\n'); await chmod(slow, 0o755)
  t.after(() => rm(dirname(slow), { recursive: true, force: true }))
  const f = await fixture(t, { git: slow }), before = new AbortController(); before.abort(new Error('early'))
  await assert.rejects(f.allocator.allocate(f.policy(), before.signal), /early/)
  assert.deepEqual(await readdir(f.root).catch(() => []), [])
  const during = new AbortController(), started = Date.now(), pending = f.allocator.allocate(f.policy(), during.signal)
  setTimeout(() => during.abort(new Error('stop')), 150)
  await assert.rejects(pending, code('relay_stopped'))
  assert.ok(Date.now() - started < 5000, 'the running git process was killed, not waited for')
  assert.deepEqual(await readdir(f.root).catch(() => []), [], 'the partial allocation was removed')
  const stuck = await fixture(t, { git: slow, remove: async () => { throw new Error('synthetic EBUSY') } }), abort = new AbortController()
  const failing = stuck.allocator.allocate(stuck.policy(), abort.signal); setTimeout(() => abort.abort(new Error('stop')), 150)
  await assert.rejects(failing, code('cleanup_unconfirmed'))
  assert.equal((await readdir(await realpath(stuck.root))).length, 1, 'the directory that could not be removed is retained')
})

test('concurrent allocations are independent clones with distinct roots', async t => {
  const f = await fixture(t), signal = new AbortController().signal
  const all = await Promise.all([1, 2, 3].map(() => f.allocator.allocate(f.policy(), signal)))
  assert.equal(new Set(all.map(owned => owned.root)).size, 3)
  for (const owned of all) assert.equal(await git(owned.root, ['rev-parse', 'HEAD']), f.base)
  await Promise.all(all.map(owned => owned.close()))
  assert.deepEqual(await readdir(await realpath(f.root)), [])
})

test('a source that borrows objects through alternates leaves no path back and no object beyond the base', async t => {
  const f = await fixture(t), shared = join(f.parent, 'shared-project')
  // `clone --shared` stores nothing itself: its history, including the future commit, lives in the origin.
  await exec('/usr/bin/git', ['clone', '-q', '--shared', f.source, shared])
  await git(shared, ['checkout', '-q', f.future])
  const alternates = await readFile(join(shared, '.git', 'objects', 'info', 'alternates'), 'utf8')
  assert.ok(alternates.includes(f.source), 'the fixture really does borrow from the origin')
  const owned = await f.allocator.allocate(f.policy({ source: shared }), new AbortController().signal)
  await assert.rejects(stat(join(owned.root, '.git', 'objects', 'info', 'alternates')), { code: 'ENOENT' })
  await assert.rejects(git(owned.root, ['cat-file', '-e', f.future]), 'the later commit is not reachable through any store')
  assert.equal(await git(owned.root, ['rev-parse', 'HEAD']), f.base)
  assert.equal(await git(owned.root, ['fsck', '--no-dangling', '--connectivity-only']).catch(() => 'broken'), '')
  const everything = await Promise.all((await files(join(owned.root, '.git'))).map(async path => (await readFile(path)).toString('latin1')))
  assert.equal(everything.some(text => text.includes(f.source) || text.includes(shared)), false)
  await owned.close()
})

test('an object store that keeps anything the base commit does not reach is refused by the object-set invariant, not trusted to the pruning step', async t => {
  const f = await fixture(t), wrapper = await mkdtemp(join(tmpdir(), 'guanxi-git-wrapper-'))
  t.after(() => rm(wrapper, { recursive: true, force: true }))
  // A git whose `prune` silently does nothing: the later commit stays behind as a loose object.
  const lax = join(wrapper, 'git')
  await writeFile(lax, '#!/bin/sh\nfor a in "$@"; do if [ "$a" = prune ]; then exit 0; fi; done\nexec /usr/bin/git "$@"\n'); await chmod(lax, 0o755)
  await assert.rejects(new OwnedCheckoutAllocator({ root: f.root, git: lax }).allocate(f.policy(), new AbortController().signal), code('relay_checkout_invalid'))
  assert.deepEqual(await readdir(f.root), [], 'the refused allocation was removed')
  // And a git that adds one unreachable object of its own.
  const sneaky = join(wrapper, 'git-sneaky')
  await writeFile(sneaky, '#!/bin/sh\nfor a in "$@"; do if [ "$a" = prune ]; then /usr/bin/git "$@" || exit 1; echo unreachable | /usr/bin/git hash-object -w --stdin >/dev/null; exit 0; fi; done\nexec /usr/bin/git "$@"\n'); await chmod(sneaky, 0o755)
  await assert.rejects(new OwnedCheckoutAllocator({ root: f.root, git: sneaky }).allocate(f.policy(), new AbortController().signal), code('relay_checkout_invalid'))
  assert.deepEqual(await readdir(f.root), [])
})
