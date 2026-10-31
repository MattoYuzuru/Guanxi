import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { readManifest, servicePaths, writeManifest } from '../../src/service/launcher.ts'
import { commandOf, judgeOwner, liveManifestPid, lookupListeners, parseLsof } from '../../src/service/owner.ts'

describe('parseLsof', () => {
  it('reads pid and uid per process, ignoring file descriptor lines', () => {
    assert.deepEqual(parseLsof('p123\nu501\nf12\np456\nu0\nf9\nf10\n'), [{ pid: 123, uid: 501 }, { pid: 456, uid: 0 }])
  })
  it('returns nothing for empty or malformed output', () => {
    assert.deepEqual(parseLsof(''), [])
    assert.deepEqual(parseLsof('pabc\nu501\nu7\n'), [])
  })
})

describe('lookupListeners', () => {
  it('asks lsof for TCP listeners on the loopback port and parses the answer', async () => {
    const seen: string[][] = []
    const listeners = await lookupListeners(4441, async (file, args) => { seen.push([file, ...args]); return { stdout: 'p9\nu501\n', code: 0 } })
    assert.deepEqual(listeners, [{ pid: 9, uid: 501 }])
    assert.deepEqual(seen, [['lsof', '-nP', '-iTCP:4441', '-sTCP:LISTEN', '-Fpu']])
  })
  it('exit 1 (nothing matched) is an answer: no listeners this user can see', async () => {
    assert.deepEqual(await lookupListeners(4441, async () => ({ stdout: '', code: 1 })), [])
  })
  it('a missing or failing lsof is "unknown", not "nobody"', async () => {
    assert.equal(await lookupListeners(4441, async () => ({ stdout: '', code: 'ENOENT' })), null)
    assert.equal(await lookupListeners(4441, async () => ({ stdout: '', code: 2 })), null)
  })
})

describe('judgeOwner', () => {
  const me = 501
  it('accepts this user’s listener, and the expected pid when one is expected', () => {
    assert.deepEqual(judgeOwner([{ pid: 1, uid: me }], me, null), { ok: true })
    assert.deepEqual(judgeOwner([{ pid: 7, uid: me }], me, 7), { ok: true })
  })
  it('refuses another user, an invisible listener, any foreign uid among several', () => {
    for (const listeners of [[{ pid: 1, uid: 0 }], [], [{ pid: 1, uid: me }, { pid: 2, uid: 0 }]]) {
      assert.deepEqual(judgeOwner(listeners, me, null), { ok: false, code: 'port_owned_by_other_user' })
    }
  })
  it('refuses a listener that is not the expected pid', () => {
    assert.deepEqual(judgeOwner([{ pid: 8, uid: me }], me, 7), { ok: false, code: 'port_busy' })
    assert.deepEqual(judgeOwner([{ pid: 7, uid: me }, { pid: 8, uid: me }], me, 7), { ok: false, code: 'port_busy' })
  })
  it('an unknown owner is refused as unverified', () => {
    assert.deepEqual(judgeOwner(null, me, null), { ok: false, code: 'port_unverified' })
  })
})

describe('commandOf', () => {
  it('returns the trimmed command line, or null when ps finds nothing', async () => {
    assert.equal(await commandOf(9, async (file, args) => (assert.deepEqual([file, ...args], ['ps', '-p', '9', '-o', 'command=']), { stdout: '/n/node /s/bin.js --port 1\n', code: 0 })), '/n/node /s/bin.js --port 1')
    assert.equal(await commandOf(9, async () => ({ stdout: '', code: 1 })), null)
  })
})

describe('liveManifestPid (a stale manifest must not outlive its process)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guanxi-owner-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const setup = (port = 4441) => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, { pid: 4242, port, startedAt: 'x', entry: '/app/service/bin.js' })
    return paths
  }

  it('returns the pid while it is alive and its command line names the entry', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => true, commandOf: async () => '/app/node /app/service/bin.js --port 4441' }), 4242)
    assert.notEqual(readManifest(paths), null)
  })
  it('removes the manifest when the pid is dead', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => false, commandOf: async () => null }), null)
    assert.equal(readManifest(paths), null)
  })
  it('removes the manifest when the pid was reused by an unrelated process', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => true, commandOf: async () => '/usr/bin/vim notes.txt' }), null)
    assert.equal(readManifest(paths), null)
  })
  it('removes the manifest when the command line cannot be read', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => true, commandOf: async () => null }), null)
    assert.equal(readManifest(paths), null)
  })
  it('leaves the manifest of a service on another port alone', async () => {
    const paths = setup(5555)
    assert.equal(await liveManifestPid(4441, { paths, alive: () => false, commandOf: async () => null }), null)
    assert.notEqual(readManifest(paths), null)
  })
})
