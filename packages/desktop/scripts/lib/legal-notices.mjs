import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** @type {Array<[string, string]>} */
export const REQUIRED_NOTICES = [
  ['LICENSE', 'project/LICENSE'],
  ['NOTICE', 'project/NOTICE'],
  ['THIRD_PARTY_NOTICES.md', 'project/THIRD_PARTY_NOTICES.md'],
  ['packages/ui/fonts/sans/OFL.txt', 'fonts/sans/OFL.txt'],
  ['packages/ui/fonts/mono/OFL.txt', 'fonts/mono/OFL.txt'],
  ['packages/server/src/connections/metadata/LICENSE.models.dev', 'metadata/LICENSE.models.dev'],
]
export const COLLECTION_SCOPE = 'Legal-text superset of installed lock-derived npm build/runtime inputs; inventory is not evidence that every package ships.'
const README = `# Bundled legal notices\n\nRepository, IBM Plex font and models.dev metadata notices are preserved byte-for-byte.\n\n${COLLECTION_SCOPE}\nOnly available top-level LICENSE, LICENCE, NOTICE and COPYING texts are collected.\nPackages with no such text or unavailable for this platform remain explicit in manifest.json.\nWorkspace links and non-root-node_modules lock paths are excluded from npm collection.\nElectron/Chromium and Node.js original notices also remain at their original bundle paths.\n`
const LEGAL_NAME = /^(?:LICEN[CS]E|NOTICE|COPYING)(?:[._-][A-Za-z0-9_-]+)*$/i
const MAX_TEXT = 4 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
const keys = (value, names) => assert.deepEqual(sorted(Object.keys(value)), sorted(names), 'unexpected notice manifest fields')

function safeRelative(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'unsafe notice path')
  return path
}

export function modulePath(path) {
  safeRelative(path)
  const parts = path.split('/')
  const name = value => typeof value === 'string' && /^[A-Za-z0-9_~][A-Za-z0-9._~-]*$/.test(value)
  let i = 0
  while (i < parts.length) {
    assert.equal(parts[i++], 'node_modules', 'unsafe npm lock path')
    if (parts[i]?.startsWith('@')) assert.ok(name(parts[i++].slice(1)), 'unsafe npm scope')
    assert.ok(name(parts[i++]), 'unsafe npm package name')
  }
  return path
}

/** Inspect every component before reading; never traverse an installed workspace link. */
async function confined(root, path) {
  safeRelative(path)
  assert.ok((await lstat(root)).isDirectory(), 'notice root must be a real directory')
  let current = root
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    const entry = await lstat(current)
    assert.ok(!entry.isSymbolicLink(), 'notice source must not contain symlinks')
    if (i < parts.length - 1) assert.ok(entry.isDirectory(), 'notice parent must be a directory')
  }
  return current
}

async function text(root, path) {
  const source = await confined(root, path)
  assert.ok((await lstat(source)).isFile(), 'notice text must be a regular file')
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    assert.ok(info.isFile() && info.nlink === 1, 'notice text must be a regular single-link file')
    assert.ok(info.size > 0 && info.size <= MAX_TEXT, 'notice text size is invalid')
    const bytes = await file.readFile()
    assert.ok(bytes.length === info.size && bytes.length <= MAX_TEXT, 'notice text changed during read')
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    assert.ok(!decoded.includes('\0'), 'notice must be text')
    const after = await file.stat()
    assert.ok(after.ino === info.ino && after.dev === info.dev && after.size === info.size && after.mtimeMs === info.mtimeMs, 'notice text changed during read')
    await confined(root, path)
    return bytes
  } finally { await file.close() }
}

function metadata(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid package metadata')
  const field = (key, max) => {
    const result = value[key]
    assert.ok(typeof result === 'string' && result.length > 0 && result.length <= max && !/[\x00-\x1f\x7f]/.test(result), 'invalid package metadata')
    return result
  }
  return { name: field('name', 214), version: field('version', 128), license: value.license === undefined || value.license === null ? null : field('license', 512) }
}

/** Writes a new owned directory; it never removes or merges an existing collection. */
export async function collectLegalNotices({ repository, destination, lock }) {
  assert.ok(lock?.packages !== null && typeof lock?.packages === 'object' && !Array.isArray(lock.packages), 'invalid npm lock inventory')
  const rootPaths = sorted(Object.keys(lock.packages).filter(path => path.startsWith('node_modules/') || path === 'node_modules'))
  // Preflight paths even for entries that will be skipped, before copying any npm text.
  for (const path of rootPaths) modulePath(path)
  await mkdir(destination)
  const files = []
  const packages = []
  const put = async (path, bytes, source) => {
    safeRelative(path)
    await mkdir(dirname(join(destination, path)), { recursive: true })
    await writeFile(join(destination, path), bytes, { flag: 'wx', mode: 0o644 })
    files.push({ path, size: bytes.length, sha256: digest(bytes), source })
  }
  for (const [source, output] of REQUIRED_NOTICES) await put(output, await text(repository, source), { kind: 'repository', path: source })
  await put('README.md', Buffer.from(README), { kind: 'collection' })
  for (const path of rootPaths) {
    const entry = lock.packages[path]
    assert.ok(entry !== null && typeof entry === 'object', 'invalid npm lock entry')
    if (entry.link === true) { packages.push({ path, status: 'workspace-link', notices: [] }); continue }
    let directory
    try { directory = await confined(repository, path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      packages.push({ path, status: 'not-installed', notices: [] }); continue
    }
    assert.ok((await lstat(directory)).isDirectory(), 'npm package must be a directory')
    const fields = metadata(JSON.parse((await text(repository, `${path}/package.json`)).toString('utf8')))
    assert.equal(fields.version, entry.version, 'installed npm version must match the lock')
    const notices = []
    for (const name of sorted(await readdir(directory))) {
      if (!LEGAL_NAME.test(name)) continue
      const output = `npm/${path}/${name}`
      await put(output, await text(repository, `${path}/${name}`), { kind: 'npm', packagePath: path, path: name })
      notices.push(output)
    }
    packages.push({ path, status: 'installed', ...fields, notices })
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const manifest = { schema: 1, scope: COLLECTION_SCOPE, files, packages }
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  return manifest
}

/** Verify copied bytes and the required source texts, not just manifest presence. */
export async function verifyLegalNotices(directory, repository) {
  const manifest = JSON.parse((await text(directory, 'manifest.json')).toString('utf8'))
  keys(manifest, ['schema', 'scope', 'files', 'packages'])
  assert.equal(manifest.schema, 1, 'unsupported notice manifest')
  assert.equal(manifest.scope, COLLECTION_SCOPE, 'notice collection scope must remain explicit')
  assert.ok(Array.isArray(manifest.files) && Array.isArray(manifest.packages), 'invalid notice manifest')
  const entries = new Map()
  for (const file of manifest.files) {
    keys(file, ['path', 'size', 'sha256', 'source'])
    safeRelative(file.path)
    assert.ok(!entries.has(file.path) && file.path !== 'manifest.json', 'duplicate notice path')
    const bytes = await text(directory, file.path)
    assert.equal(bytes.length, file.size, 'notice size mismatch')
    assert.equal(digest(bytes), file.sha256, 'notice digest mismatch')
    entries.set(file.path, file)
  }
  for (const [source, output] of REQUIRED_NOTICES) {
    assert.deepEqual(entries.get(output)?.source, { kind: 'repository', path: source }, 'required notice missing from manifest')
    assert.deepEqual(await text(directory, output), await text(repository, source), 'required notice must preserve repository bytes')
    entries.delete(output)
  }
  assert.deepEqual(entries.get('README.md')?.source, { kind: 'collection' })
  assert.equal((await text(directory, 'README.md')).toString('utf8'), README)
  entries.delete('README.md')
  const seen = new Set()
  for (const pkg of manifest.packages) {
    keys(pkg, pkg.status === 'installed' ? ['path', 'status', 'name', 'version', 'license', 'notices'] : ['path', 'status', 'notices'])
    modulePath(pkg.path)
    assert.ok(!seen.has(pkg.path), 'duplicate notice package')
    seen.add(pkg.path)
    assert.ok(['installed', 'not-installed', 'workspace-link'].includes(pkg.status) && Array.isArray(pkg.notices), 'invalid notice package')
    if (pkg.status === 'installed') assert.deepEqual(metadata(pkg), { name: pkg.name, version: pkg.version, license: pkg.license })
    else assert.equal(pkg.notices.length, 0, 'unavailable package cannot have notices')
    for (const output of pkg.notices) {
      const name = output.slice(`npm/${pkg.path}/`.length)
      assert.ok(LEGAL_NAME.test(name) && output === `npm/${pkg.path}/${name}`, 'unsafe npm notice output')
      assert.deepEqual(entries.get(output)?.source, { kind: 'npm', packagePath: pkg.path, path: name }, 'npm notice not bound to package')
      entries.delete(output)
    }
  }
  assert.equal(entries.size, 0, 'unbound notice files')
  const actual = []
  async function visit(path = '') {
    for (const entry of await readdir(path ? join(directory, path) : directory, { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name
      assert.ok(entry.isDirectory() || entry.isFile(), 'notice collection must not contain symlinks or special files')
      if (entry.isDirectory()) await visit(child)
      else actual.push(child)
    }
  }
  await visit()
  assert.deepEqual(sorted(actual), sorted(['manifest.json', ...manifest.files.map(file => file.path)]), 'unexpected or missing notice files')
  return manifest
}
