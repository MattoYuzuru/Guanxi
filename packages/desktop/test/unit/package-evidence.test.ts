import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appInventory, artifactEvidence, compareApps, noticePaths, verifyNotices } from '../../scripts/lib/package-evidence.mjs'

test('app comparison detects missing/extra/changed files and executable or symlink changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'package-evidence-'))
  try {
    const left = join(dir, 'left'); const right = join(dir, 'right')
    await mkdir(left); await mkdir(right)
    for (const app of [left, right]) {
      await writeFile(join(app, 'binary'), 'same')
      await chmod(join(app, 'binary'), 0o755)
      await symlink('binary', join(app, 'link'))
    }
    await compareApps(left, right)
    await writeFile(join(right, 'binary'), 'changed')
    await assert.rejects(compareApps(left, right), /identical app/)
    await writeFile(join(right, 'binary'), 'same')
    await chmod(join(right, 'binary'), 0o644)
    await assert.rejects(compareApps(left, right), /identical app/)
    await chmod(join(right, 'binary'), 0o755)
    await writeFile(join(right, 'extra'), '')
    await assert.rejects(compareApps(left, right), /identical app/)
    await rm(join(right, 'extra'))
    await rm(join(right, 'link'))
    await assert.rejects(compareApps(left, right), /identical app/)
    await symlink('../outside', join(right, 'link'))
    await assert.rejects(appInventory(right), /symlink must stay/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('every required bundled notice must exist and be nonempty; build-only exception cannot ship', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'package-notices-'))
  try {
    await mkdir(join(dir, 'service/node'), { recursive: true })
    await mkdir(join(dir, 'service/node_modules'), { recursive: true })
    for (const name of noticePaths) await writeFile(join(dir, name), 'notice')
    await verifyNotices(dir)
    for (const name of noticePaths) {
      await writeFile(join(dir, name), '')
      await assert.rejects(verifyNotices(dir), /notice must not be empty/)
      await rm(join(dir, name))
      await assert.rejects(verifyNotices(dir), /ENOENT/)
      await writeFile(join(dir, name), 'notice')
    }
    await mkdir(join(dir, 'service/node_modules/truncate-utf8-bytes'))
    await assert.rejects(verifyNotices(dir), /build-only dependency/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('artifact receipt binds regular file bytes to exact source identity and ad-hoc status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'package-assets-'))
  try {
    const file = join(dir, 'test.dmg')
    await writeFile(file, 'abc')
    const identity = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), version: '0.1.0', appId: 'example.app', architecture: 'arm64' }
    const receipt = await artifactEvidence({ files: [file], ...identity })
    assert.deepEqual(receipt, { schema: 1, ...identity, signing: 'ad-hoc', notarized: false,
      assets: [{ name: 'test.dmg', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] })
    await symlink('test.dmg', join(dir, 'link'))
    await assert.rejects(artifactEvidence({ files: [join(dir, 'link')], ...identity }), /regular file/)
    await assert.rejects(artifactEvidence({ files: [file], ...identity, commit: 'bad' }), /match/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
