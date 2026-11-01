import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { appInventory, artifactEvidence, compareApps, noticePaths, verifyBuildEvidence, verifyNotices } from '../../scripts/lib/package-evidence.mjs'
import { inspectService } from '../../scripts/lib/package-process.mjs'
import { ZIP_PREFLIGHT } from '../../scripts/verify-package.mjs'
import { isFailedUiResponse, reloadDocument } from '../../scripts/lib/renderer-cdp.mjs'
import { packageLaunchArguments } from '../../scripts/lib/package-launch.mjs'

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
    await symlink('.', join(right, 'link'))
    await assert.rejects(compareApps(left, right), /identical app/)
    await rm(join(right, 'link'))
    await symlink('../outside', join(right, 'link'))
    await assert.rejects(appInventory(right), /symlink must stay/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('packaged smoke isolates Chromium Keychain access and debugging to its temporary process', () => {
  assert.deepEqual(packageLaunchArguments('/temporary/profile', 12345), [
    '--user-data-dir=/temporary/profile', '--use-mock-keychain', '--password-store=basic',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=12345',
  ])
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
    await verifyBuildEvidence(receipt, identity, [file])
    for (const mismatch of [{ commit: 'c'.repeat(40) }, { tree: 'c'.repeat(40) }, { version: '0.2.0' }, { appId: 'wrong.app' }]) {
      await assert.rejects(verifyBuildEvidence(receipt, { ...identity, ...mismatch }, [file]), /build-time source receipt/)
    }
    await writeFile(file, 'changed')
    await assert.rejects(verifyBuildEvidence(receipt, identity, [file]), /build-time source receipt/)
    await symlink('test.dmg', join(dir, 'link'))
    await assert.rejects(artifactEvidence({ files: [join(dir, 'link')], ...identity }), /regular file/)
    await assert.rejects(artifactEvidence({ files: [file], ...identity, commit: 'bad' }), /match/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('process cleanup distinguishes owned, gone, foreign and unobservable identities', () => {
  const deps = { probe: () => {}, command: () => '501 /app/node /app/bin.js --data-dir /tmp/test --no-open', uid: 501,
    executable: '/app/node', entry: '/app/bin.js', dataDir: '/tmp/test' }
  assert.equal(inspectService(10, deps), 'owned')
  assert.equal(inspectService(10, { ...deps, command: () => { throw new Error('ps unavailable') } }), 'unknown')
  assert.equal(inspectService(10, { ...deps, probe: () => { throw Object.assign(new Error(), { code: 'EPERM' }) } }), 'unknown')
  assert.equal(inspectService(10, { ...deps, probe: () => { throw Object.assign(new Error(), { code: 'ESRCH' }) } }), 'gone')
  assert.equal(inspectService(10, { ...deps, uid: 502 }), 'other')
  assert.equal(inspectService(10, { ...deps, executable: '/other/node' }), 'other')
  assert.equal(inspectService(1, deps), 'unknown')
})

test('ZIP preflight rejects traversal, extra roots, duplicate entries and escaping symlinks before extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'package-zip-'))
  try {
    const zip = join(dir, 'test.zip')
    const create = `import zipfile,sys,json,stat\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name,target in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(name)\n  if target is not None:i.create_system=3;i.external_attr=(stat.S_IFLNK | 0o777)<<16\n  z.writestr(i,target or 'file')`
    for (const entries of [
      [['App.app/Contents/file', null]], [['../outside', null]], [['Other.app/file', null]],
      [['App.app/../outside', null]], [['App.app/file', null], ['App.app/file', null]], [['App.app/link', '../../outside']],
    ]) {
      assert.equal(spawnSync('python3', ['-c', create, zip, JSON.stringify(entries)]).status, 0)
      const result = spawnSync('python3', ['-c', ZIP_PREFLIGHT, zip, 'App.app'])
      assert.equal(result.status === 0, entries.length === 1 && entries[0]![0] === 'App.app/Contents/file')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('packaged reload waits for a new main-frame loader, and UI HTTP errors fail resource checks', async () => {
  let listener: ((event: object) => void) | undefined
  let removed = false
  const send = async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'old' } } }
    if (method === 'Page.reload') {
      assert.ok(listener, 'observer must be registered before reload')
      listener({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'main', loaderId: 'old' } })
      listener({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'child', loaderId: 'new' } })
    }
    return {}
  }
  let completed = false
  const loading = reloadDocument(send, (callback: (event: object) => void) => { listener = callback; return () => { removed = true } }).then(() => { completed = true })
  await new Promise(done => setTimeout(done, 0))
  assert.equal(completed, false, 'old-document and subframe loads must not complete main-frame reload')
  assert.ok(listener)
  listener({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'main', loaderId: 'new' } })
  await loading
  assert.equal(removed, true)
  for (const type of ['Document', 'Script', 'Stylesheet', 'Font', 'Image']) {
    assert.equal(isFailedUiResponse({ method: 'Network.responseReceived', params: { type, response: { status: 404 } } }), true)
    assert.equal(isFailedUiResponse({ method: 'Network.responseReceived', params: { type, response: { status: 200 } } }), false)
  }
  assert.equal(isFailedUiResponse({ method: 'Network.responseReceived', params: { type: 'Fetch', response: { status: 503 } } }), false)
})
