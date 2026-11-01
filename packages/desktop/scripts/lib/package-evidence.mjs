import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

/** Do not follow symlinks: framework links are part of the package, not extra traversal roots. */
export async function appInventory(root) {
  const entries = []
  async function visit(path) {
    const stat = await lstat(path)
    const name = relative(root, path)
    if (stat.isSymbolicLink()) {
      const target = await readlink(path)
      const destination = relative(root, resolve(path, '..', target))
      assert.ok(!isAbsolute(target) && destination !== '..' && !destination.startsWith('../'), 'app symlink must stay inside its bundle')
      entries.push({ name, type: 'link', target })
    } else if (stat.isDirectory()) {
      entries.push({ name, type: 'directory', executable: stat.mode & 0o111 })
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else {
      assert.ok(stat.isFile(), 'app must contain only regular files, directories and internal symlinks')
      entries.push({ name, type: 'file', executable: stat.mode & 0o111, size: stat.size, sha256: await fileDigest(path) })
    }
  }
  await visit(root)
  return entries
}

export async function compareApps(left, right) {
  assert.deepEqual(await appInventory(right), await appInventory(left), 'ZIP and DMG must contain identical app files, links and executable bits')
}

export const noticePaths = ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'service/node/LICENSE']
export async function verifyNotices(resources) {
  for (const name of noticePaths) {
    const path = join(resources, name)
    assert.ok((await lstat(path)).isFile(), `notice must be a regular file: ${name}`)
    assert.ok((await readFile(path)).length > 0, `notice must not be empty: ${name}`)
  }
  // D-223 is build-only, including in the separately staged production dependency tree.
  const modules = join(resources, 'service', 'node_modules')
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.notEqual(entry.name, 'truncate-utf8-bytes', 'D-223 build-only dependency must not ship')
      if (entry.isDirectory()) await inspect(join(path, entry.name))
    }
  }
  await inspect(modules)
}

export async function artifactEvidence({ files, commit, tree, version, appId, architecture }) {
  assert.match(commit, /^[a-f0-9]{40}$/)
  assert.match(tree, /^[a-f0-9]{40}$/)
  assert.ok(version && appId && architecture)
  const assets = []
  for (const path of files) {
    const stat = await lstat(path)
    assert.ok(stat.isFile(), 'artifact must be a regular file')
    assets.push({ name: path.split('/').at(-1), size: stat.size, sha256: await fileDigest(path) })
  }
  return { schema: 1, commit, tree, version, appId, architecture, signing: 'ad-hoc', notarized: false, assets }
}

export async function verifyBuildEvidence(receipt, identity, files) {
  const actual = await artifactEvidence({ files, ...identity })
  assert.deepEqual(receipt, actual, 'package bytes must match the clean build-time source receipt')
  return actual
}
