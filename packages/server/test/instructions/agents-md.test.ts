import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadInstructions, readInstructionFile } from '../../src/instructions/agents-md.ts'

async function baseDir(t: { after(callback: () => unknown): void }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'p1a-instructions-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeAt(root: string, relative: string, text: string): Promise<string> {
  const path = join(root, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}

async function link(target: string, path: string, type: 'dir' | 'file'): Promise<boolean> {
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

test('loads project root first and the nearest directory last', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const cwd = join(projectRoot, 'sub/deep')
  await writeAt(projectRoot, 'AGENTS.md', 'root rules\n')
  await writeAt(projectRoot, 'sub/AGENTS.md', 'sub rules\n')
  await writeAt(projectRoot, 'sub/deep/AGENTS.md', 'deep rules\n')

  const result = await loadInstructions({ projectRoot, cwd, budgetBytes: 1000 })
  assert.deepEqual(result.files.map(file => file.path), ['AGENTS.md', 'sub/AGENTS.md', 'sub/deep/AGENTS.md'])
  assert.ok(result.files.every(file => file.included))
  assert.equal(result.overflow, null)
  assert.equal(result.text.indexOf('## AGENTS.md'), 0)
  assert.ok(result.text.indexOf('## sub/AGENTS.md') < result.text.indexOf('## sub/deep/AGENTS.md'))
  assert.ok(result.text.indexOf('root rules') < result.text.indexOf('sub rules'))
  assert.ok(result.text.indexOf('sub rules') < result.text.indexOf('deep rules'))
})

test('a cwd equal to the project root loads exactly one level', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  await writeAt(projectRoot, 'AGENTS.md', 'only rules')
  const result = await loadInstructions({ projectRoot, cwd: projectRoot, budgetBytes: 100 })
  assert.deepEqual(result.files, [{ path: 'AGENTS.md', bytes: 10, included: true }])
  assert.equal(result.text, '## AGENTS.md\nonly rules')
  assert.equal(result.overflow, null)
})

test('includes whole files while they fit and reports the rest as overflow', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const cwd = join(projectRoot, 'sub/deep')
  await writeAt(projectRoot, 'AGENTS.md', 'r'.repeat(20))
  await writeAt(projectRoot, 'sub/AGENTS.md', 's'.repeat(20))
  await writeAt(projectRoot, 'sub/deep/AGENTS.md', 'd'.repeat(20))

  const result = await loadInstructions({ projectRoot, cwd, budgetBytes: 25 })
  assert.deepEqual(result.files.map(file => [file.path, file.bytes, file.included]), [
    ['AGENTS.md', 20, false],
    ['sub/AGENTS.md', 20, false],
    ['sub/deep/AGENTS.md', 20, true],
  ])
  assert.equal(result.text, `## sub/deep/AGENTS.md\n${'d'.repeat(20)}\n\nOmitted instruction files: AGENTS.md, sub/AGENTS.md (budget 25 bytes; 60 bytes found).`)
  assert.doesNotMatch(result.text, /r{20}|s{20}/)
  assert.deepEqual(result.overflow, {
    totalBytes: 60,
    budgetBytes: 25,
    omitted: ['AGENTS.md', 'sub/AGENTS.md'],
  })
})

test('a budget too small for any file returns only the omission report', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  await writeAt(projectRoot, 'AGENTS.md', '0123456789')
  const result = await loadInstructions({ projectRoot, cwd: projectRoot, budgetBytes: 5 })
  assert.deepEqual(result.files, [{ path: 'AGENTS.md', bytes: 10, included: false }])
  assert.equal(result.text, 'Omitted instruction files: AGENTS.md (budget 5 bytes; 10 bytes found).')
  assert.deepEqual(result.overflow, { totalBytes: 10, budgetBytes: 5, omitted: ['AGENTS.md'] })
})

test('cwd outside the project root throws TypeError after realpath', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const outside = join(base, 'outside')
  await writeAt(projectRoot, 'AGENTS.md', 'root')
  await mkdir(outside, { recursive: true })
  await assert.rejects(
    loadInstructions({ projectRoot, cwd: outside, budgetBytes: 100 }),
    (error: unknown) => error instanceof TypeError && /outside/.test(error.message),
  )
  await assert.rejects(
    loadInstructions({ projectRoot, cwd: join(projectRoot, 'missing'), budgetBytes: 100 }),
    (error: unknown) => error instanceof TypeError && /outside/.test(error.message),
  )
})

test('a symlinked instruction file outside the project root is skipped and reported', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const cwd = join(projectRoot, 'sub')
  await writeAt(projectRoot, 'AGENTS.md', 'root safe')
  const outside = await writeAt(base, 'outside.md', 'outside secret')
  await mkdir(cwd, { recursive: true })
  if (!await link(outside, join(cwd, 'AGENTS.md'), 'file')) {
    t.skip('symlinks are unavailable')
    return
  }

  const result = await loadInstructions({ projectRoot, cwd, budgetBytes: 1000 })
  assert.deepEqual(result.files.map(file => [file.path, file.bytes, file.included]), [
    ['AGENTS.md', 9, true],
    ['sub/AGENTS.md', 14, false],
  ])
  assert.doesNotMatch(result.text, /outside secret/)
  assert.match(result.text, /^## AGENTS\.md\nroot safe\n\nSkipped instruction files outside the project root: sub\/AGENTS\.md\.$/)
  assert.equal(result.overflow, null)
})

test('a symlink resolving inside the project root is loaded under its lexical path', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const cwd = join(projectRoot, 'sub')
  await writeAt(projectRoot, 'AGENTS.md', 'root rules')
  const shared = await writeAt(projectRoot, 'rules/AGENTS.md', 'linked rules')
  await mkdir(cwd, { recursive: true })
  if (!await link(shared, join(cwd, 'AGENTS.md'), 'file')) {
    t.skip('symlinks are unavailable')
    return
  }

  const result = await loadInstructions({ projectRoot, cwd, budgetBytes: 1000 })
  assert.deepEqual(result.files.map(file => [file.path, file.included]), [
    ['AGENTS.md', true],
    ['sub/AGENTS.md', true],
  ])
  assert.match(result.text, /## sub\/AGENTS\.md\nlinked rules$/)
  assert.equal(result.overflow, null)
})

test('CLAUDE.md is opt-in and keeps fileNames order inside each directory', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const cwd = join(projectRoot, 'sub')
  await writeAt(projectRoot, 'AGENTS.md', 'root agents')
  await writeAt(projectRoot, 'CLAUDE.md', 'root claude')
  await writeAt(projectRoot, 'sub/CLAUDE.md', 'sub claude')

  const defaults = await loadInstructions({ projectRoot, cwd, budgetBytes: 1000 })
  assert.deepEqual(defaults.files.map(file => file.path), ['AGENTS.md'])
  assert.doesNotMatch(defaults.text, /claude/)

  const both = await loadInstructions({ projectRoot, cwd, budgetBytes: 1000, fileNames: ['AGENTS.md', 'CLAUDE.md'] })
  assert.deepEqual(both.files.map(file => file.path), ['AGENTS.md', 'CLAUDE.md', 'sub/CLAUDE.md'])
  assert.ok(both.text.indexOf('root agents') < both.text.indexOf('root claude'))
  assert.ok(both.text.indexOf('root claude') < both.text.indexOf('sub claude'))
  assert.equal(both.overflow, null)
})

test('an empty instruction tree returns empty text and no overflow', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  await mkdir(join(projectRoot, 'sub'), { recursive: true })
  const result = await loadInstructions({ projectRoot, cwd: join(projectRoot, 'sub'), budgetBytes: 0 })
  assert.deepEqual(result.files, [])
  assert.equal(result.text, '')
  assert.equal(result.overflow, null)
})

test('CLAUDE.md symlinked to AGENTS.md is included once by real path', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  await writeAt(projectRoot, 'AGENTS.md', 'rules\n')
  if (!await link('AGENTS.md', join(projectRoot, 'CLAUDE.md'), 'file')) {
    t.skip('symlinks are unavailable')
    return
  }

  const result = await loadInstructions({
    projectRoot,
    cwd: projectRoot,
    budgetBytes: 100,
    fileNames: ['AGENTS.md', 'CLAUDE.md'],
  })
  assert.deepEqual(result.files, [{ path: 'AGENTS.md', bytes: 6, included: true }])
  assert.equal(result.text, '## AGENTS.md\nrules\n')
  assert.equal(result.text.match(/rules/g)?.length, 1)
})

test('a nearer overflow still omits a farther file that would fit', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const cwd = join(projectRoot, 'sub/deep')
  await writeAt(projectRoot, 'AGENTS.md', 'r'.repeat(10))
  await writeAt(projectRoot, 'sub/deep/AGENTS.md', 'd'.repeat(100))

  const result = await loadInstructions({ projectRoot, cwd, budgetBytes: 50 })
  assert.deepEqual(result.files.map(file => [file.path, file.bytes, file.included]), [
    ['AGENTS.md', 10, false],
    ['sub/deep/AGENTS.md', 100, false],
  ])
  assert.deepEqual(result.overflow, {
    totalBytes: 110,
    budgetBytes: 50,
    omitted: ['AGENTS.md', 'sub/deep/AGENTS.md'],
  })
  assert.equal(result.text, 'Omitted instruction files: AGENTS.md, sub/deep/AGENTS.md (budget 50 bytes; 110 bytes found).')
})

test('a file that grows past its stat size is reported as changed', async t => {
  const base = await baseDir(t)
  const path = await writeAt(base, 'AGENTS.md', '0123456789')
  assert.deepEqual(await readInstructionFile(path, 9), { problem: 'changed' })
  assert.deepEqual(await readInstructionFile(path, 10), { text: '0123456789' })
})

test('an unreadable instruction file is skipped and reported', async t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root can read chmod 000 files')
    return
  }
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  const path = await writeAt(projectRoot, 'AGENTS.md', 'secret rules')
  await chmod(path, 0o000)
  t.after(() => chmod(path, 0o644).catch(() => undefined))

  const result = await loadInstructions({ projectRoot, cwd: projectRoot, budgetBytes: 1000 })
  assert.deepEqual(result.files, [{ path: 'AGENTS.md', bytes: 12, included: false }])
  assert.deepEqual(result.unreadable, ['AGENTS.md'])
  assert.equal(result.text, 'Unreadable instruction files: AGENTS.md.')
  assert.equal(result.overflow, null)
})

test('non-finite and negative budgets are rejected with TypeError', async t => {
  const base = await baseDir(t)
  const projectRoot = join(base, 'project')
  await writeAt(projectRoot, 'AGENTS.md', 'rules')
  for (const budgetBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      loadInstructions({ projectRoot, cwd: projectRoot, budgetBytes }),
      TypeError,
    )
  }
})
