import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectTaskDirectory, stageTaskDirectory, verifyTaskDirectory, type TaskManifest } from '../src/staging.ts'

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-staging-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

async function put(root: string, relative: string, data: string | Buffer): Promise<void> {
  const target = join(root, ...relative.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function revisionOf(files: { path: string; sha256: string }[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))) {
    hash.update(file.path, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(Buffer.from(file.sha256, 'hex'))
  }
  return hash.digest('hex')
}

async function refuses(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as Error).message, code)
    return true
  })
}

async function assertNoPublication(directory: string): Promise<void> {
  let entries: string[]
  try { entries = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  assert.deepEqual(entries, [])
}

async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777
}

async function fixture(t: TestContext): Promise<{ root: string; source: string; manifest: TaskManifest; contents: Map<string, string> }> {
  const root = await workspace(t)
  const source = join(root, 'source')
  const contents = new Map([
    ['Z-upper.txt', 'upper'],
    ['a/nested.txt', 'nested'],
    ['a.txt', 'directory-prefix sibling'],
    ['z-last.txt', 'last'],
    ['данные/файл.txt', 'кириллица'],
    ['日本/ファイル.txt', '日本語'],
  ])
  for (const [relative, data] of [...contents].reverse()) await put(source, relative, data)
  return { root, source, manifest: await inspectTaskDirectory(source), contents }
}

test('inspection reports nested non-ASCII files in UTF-8 byte order with a reproducible revision', async (t) => {
  const { root, source, manifest, contents } = await fixture(t)
  assert.equal(manifest.version, 1)
  assert.match(manifest.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.files.map(file => file.path), ['Z-upper.txt', 'a.txt', 'a/nested.txt', 'z-last.txt', 'данные/файл.txt', '日本/ファイル.txt'])
  for (const file of manifest.files) {
    const data = contents.get(file.path)!
    assert.equal(file.sha256, sha256(data))
    assert.equal(file.bytes, Buffer.byteLength(data))
    assert.ok(Number.isSafeInteger(file.bytes))
  }
  assert.equal(manifest.revision, revisionOf(manifest.files))
  assert.deepEqual(await verifyTaskDirectory({ path: source, revision: manifest.revision }), manifest)

  const second = join(root, 'second-source')
  for (const [relative, data] of contents) await put(second, relative, data)
  const reordered = await inspectTaskDirectory(second)
  assert.deepEqual(reordered.files, manifest.files)
  assert.equal(reordered.revision, manifest.revision)
})

test('staging publishes an exact private copy with the required modes and accepts an identical destination idempotently', async (t) => {
  const { root, source, manifest, contents } = await fixture(t)
  const destinationRoot = join(root, 'published')
  const first = await stageTaskDirectory(source, destinationRoot, manifest.revision)
  assert.equal(first.path, join(destinationRoot, manifest.revision))
  assert.deepEqual(first.manifest, manifest)
  assert.equal(await modeOf(destinationRoot), 0o700)
  assert.equal(await modeOf(first.path), 0o700)
  for (const directory of ['a', 'данные', '日本']) assert.equal(await modeOf(join(first.path, directory)), 0o700)
  for (const [relative, expected] of contents) {
    const target = join(first.path, ...relative.split('/'))
    assert.equal(await readFile(target, 'utf8'), expected)
    assert.equal(await modeOf(target), 0o600)
  }
  assert.deepEqual(await readdir(destinationRoot), [manifest.revision])

  const before = await stat(first.path, { bigint: true })
  const second = await stageTaskDirectory(source, destinationRoot, manifest.revision)
  const after = await stat(first.path, { bigint: true })
  assert.equal(second.path, first.path)
  assert.deepEqual(second.manifest, manifest)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.deepEqual(await readdir(destinationRoot), [manifest.revision])
})

test('tampered bytes and stale expected digests are refused without publishing anything', async (t) => {
  const { root, source, manifest } = await fixture(t)
  await writeFile(join(source, 'a', 'nested.txt'), 'nestEd')
  await refuses(verifyTaskDirectory({ path: source, revision: manifest.revision }), 'revision_mismatch')
  const destinationRoot = join(root, 'published')
  await refuses(stageTaskDirectory(source, destinationRoot, manifest.revision), 'expected_revision_mismatch')
  await assertNoPublication(destinationRoot)
  await put(source, 'a/added.txt', 'added')
  await refuses(verifyTaskDirectory({ path: source, revision: manifest.revision }), 'revision_mismatch')
})

test('malformed or non-SHA-256 revisions are refused before any filesystem write', async (t) => {
  const { root, source } = await fixture(t)
  const destinationRoot = join(root, 'published')
  for (const revision of ['', 'a'.repeat(40), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    await refuses(verifyTaskDirectory({ path: source, revision }), 'invalid_revision')
    await refuses(stageTaskDirectory(source, destinationRoot, revision), 'invalid_revision')
  }
  await assertNoPublication(destinationRoot)
})

test('source roots and entries must be ordinary, non-symlinked files and directories', async (t) => {
  const root = await workspace(t)
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'private')
  const real = join(root, 'real')
  await put(real, 'ok.txt', 'ok')
  const rootLink = join(root, 'root-link')
  await symlink(real, rootLink)
  await refuses(inspectTaskDirectory(rootLink), 'symlink_refused')
  await refuses(inspectTaskDirectory(`${rootLink}/`), 'symlink_refused')
  await refuses(inspectTaskDirectory(`${rootLink}/.`), 'invalid_path')
  await refuses(inspectTaskDirectory(`${rootLink}/..`), 'invalid_path')
  await refuses(inspectTaskDirectory(outside), 'not_a_directory')

  const source = join(root, 'source')
  await put(source, 'ok.txt', 'ok')
  const fileLink = join(source, 'a-link')
  await symlink(outside, fileLink)
  await refuses(inspectTaskDirectory(source), 'symlink_refused')
  await unlink(fileLink)

  const outsideDirectory = join(root, 'outside-directory')
  await put(outsideDirectory, 'hidden.txt', 'hidden')
  const directoryLink = join(source, 'b-link')
  await symlink(outsideDirectory, directoryLink)
  await refuses(inspectTaskDirectory(source), 'symlink_refused')
  await unlink(directoryLink)

  execFileSync('mkfifo', [join(source, 'c-pipe')], { stdio: 'ignore' })
  await refuses(inspectTaskDirectory(source), 'nonregular_refused')
})

test('source paths with internal dot components are refused instead of hashing a lexical sibling', async (t) => {
  const root = await workspace(t)
  const a = join(root, 'a')
  const b = join(root, 'b')
  await mkdir(a, { recursive: true })
  await mkdir(join(b, 'child', 'sub'), { recursive: true })
  await symlink(join('..', 'b', 'child'), join(a, 'link'))
  await put(a, 'source/item.txt', 'LEXICAL')
  await put(b, 'source/item.txt', 'ACTUAL')

  const lexical = await inspectTaskDirectory(join(a, 'source'))
  const actual = await inspectTaskDirectory(join(b, 'source'))
  assert.deepEqual(lexical.files.map(file => [file.path, file.sha256, file.bytes]), [['item.txt', sha256('LEXICAL'), 7]])
  assert.deepEqual(actual.files.map(file => [file.path, file.sha256, file.bytes]), [['item.txt', sha256('ACTUAL'), 6]])
  assert.notEqual(lexical.revision, actual.revision)

  const variants = [
    `${a}/link/../source`,
    `${a}/link/./../source`,
    `${a}/./link/../source`,
    `${a}/link/sub/../../source`,
    `${a}/link/../source/`,
    `${a}/link/../source/../source`,
  ]
  for (const [index, variant] of variants.entries()) {
    await refuses(inspectTaskDirectory(variant), 'invalid_path')
    await refuses(verifyTaskDirectory({ path: variant, revision: lexical.revision }), 'invalid_path')
    const destinationRoot = join(root, `published-${index}`)
    await refuses(stageTaskDirectory(variant, destinationRoot, lexical.revision), 'invalid_path')
    await assertNoPublication(destinationRoot)
  }
  assert.equal(await readFile(join(a, 'source', 'item.txt'), 'utf8'), 'LEXICAL')
  assert.equal(await readFile(join(b, 'source', 'item.txt'), 'utf8'), 'ACTUAL')
})

test('inspection refuses bytes changed while it is hashing', async (t) => {
  const root = await workspace(t)
  const source = join(root, 'source')
  await mkdir(source)
  const changing = join(source, 'changing.bin')
  await writeFile(changing, '')
  await truncate(changing, 64 * 1024 * 1024)
  const handle = await open(changing, 'r+')
  let tick = 0
  const timer = setInterval(() => {
    void handle.write(Buffer.from([tick++ % 2 ? 0x41 : 0x42]), 0, 1, 0).catch(() => {})
  }, 1)
  t.after(async () => { clearInterval(timer); await handle.close() })
  await new Promise(resolve => setTimeout(resolve, 10))
  await refuses(inspectTaskDirectory(source), 'source_changed')
})

test('inspection refuses a mutated ancestor identity during traversal', async (t) => {
  const root = await workspace(t)
  const source = join(root, 'source')
  const directory = join(source, 'a')
  await mkdir(directory, { recursive: true })
  const payload = join(directory, 'payload.bin')
  await writeFile(payload, '')
  await truncate(payload, 128 * 1024 * 1024)
  const moved = join(root, 'source-moved')
  const timer = setTimeout(() => {
    void (async () => {
      await rename(source, moved)
      await symlink(moved, source)
    })().catch(() => {})
  }, 10)
  t.after(() => { clearTimeout(timer) })
  await refuses(inspectTaskDirectory(source), 'source_changed')
  assert.equal((await lstat(source)).isSymbolicLink(), true)
  assert.equal((await lstat(moved)).isDirectory(), true)
})

test('destination roots inside the source, including through symlinks, are refused before any write', async (t) => {
  const { root, source, manifest } = await fixture(t)
  const inside = join(source, 'published')
  await refuses(stageTaskDirectory(source, inside, manifest.revision), 'destination_inside_source')
  await assert.rejects(lstat(inside))
  const link = join(root, 'destination-link')
  await symlink(source, link)
  await refuses(stageTaskDirectory(source, link, manifest.revision), 'destination_inside_source')
  const nestedLink = join(root, 'nested-link')
  await symlink(join(source, 'a'), nestedLink)
  await refuses(stageTaskDirectory(source, `${nestedLink}/../published`, manifest.revision), 'destination_inside_source')
  await assert.rejects(lstat(join(source, 'published')))
  await refuses(stageTaskDirectory(source, source, manifest.revision), 'destination_inside_source')
  await refuses(stageTaskDirectory(source, `${root}/missing/../published-outside`, manifest.revision), 'destination_path_ambiguous')
  await assert.rejects(lstat(join(root, 'published-outside')))
})

test('existing published content is reverified and never replaced on mismatch', async (t) => {
  const { root, source, manifest } = await fixture(t)
  const destinationRoot = join(root, 'published')
  const first = await stageTaskDirectory(source, destinationRoot, manifest.revision)
  const target = join(first.path, 'a', 'nested.txt')
  await writeFile(target, 'tamper')
  const before = await stat(target, { bigint: true })
  await refuses(stageTaskDirectory(source, destinationRoot, manifest.revision), 'destination_conflict')
  const after = await stat(target, { bigint: true })
  assert.equal(await readFile(target, 'utf8'), 'tamper')
  assert.equal(after.ino, before.ino)
  assert.deepEqual(await readdir(destinationRoot), [manifest.revision])

  const otherRoot = join(root, 'other')
  const wrong = join(otherRoot, manifest.revision)
  await mkdir(wrong, { recursive: true })
  await writeFile(join(wrong, 'wrong.txt'), 'preserve me')
  await refuses(stageTaskDirectory(source, otherRoot, manifest.revision), 'destination_conflict')
  assert.equal(await readFile(join(wrong, 'wrong.txt'), 'utf8'), 'preserve me')
  assert.deepEqual(await readdir(otherRoot), [manifest.revision])
})

test('concurrent identical publication yields an exact winner without destroying it', async (t) => {
  const { root, source, manifest } = await fixture(t)
  await put(source, 'bulk.bin', Buffer.alloc(4 * 1024 * 1024, 9))
  const revision = (await inspectTaskDirectory(source)).revision
  const destinationRoot = join(root, 'published')
  const results = await Promise.allSettled([
    stageTaskDirectory(source, destinationRoot, revision),
    stageTaskDirectory(source, destinationRoot, revision),
  ])
  const successes = results.filter((result): result is PromiseFulfilledResult<{ path: string; manifest: TaskManifest }> => result.status === 'fulfilled')
  assert.ok(successes.length >= 1)
  for (const result of results) {
    if (result.status === 'rejected') assert.equal((result.reason as Error).message, 'publish_busy')
  }
  assert.equal(successes[0]!.value.path, join(destinationRoot, revision))
  assert.deepEqual(await verifyTaskDirectory({ path: successes[0]!.value.path, revision }), successes[0]!.value.manifest)
  assert.deepEqual(await readdir(destinationRoot), [revision])
})

test('a lost publication reservation leaves no partial published state and removes its temporary copy', async (t) => {
  const { root, source, manifest } = await fixture(t)
  const destinationRoot = join(root, 'published')
  await mkdir(destinationRoot)
  const lock = join(destinationRoot, `.publish-${manifest.revision}.lock`)
  await writeFile(lock, 'held by another publisher')
  await refuses(stageTaskDirectory(source, destinationRoot, manifest.revision), 'publish_busy')
  assert.deepEqual(await readdir(destinationRoot), [`.publish-${manifest.revision}.lock`])
  assert.equal(await readFile(lock, 'utf8'), 'held by another publisher')
  await assert.rejects(lstat(join(destinationRoot, manifest.revision)))
})
