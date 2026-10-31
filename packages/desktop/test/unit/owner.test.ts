import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { readManifest, servicePaths, writeManifest } from '../../src/service/launcher.ts'
import { judgeOwner, liveManifestPid, lookupListeners, matchesManifest, parseLsof, processInfo } from '../../src/service/owner.ts'
import type { ProcessInfo } from '../../src/service/owner.ts'

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
    assert.deepEqual(seen, [['/usr/sbin/lsof', '-b', '-nP', '-iTCP:4441', '-sTCP:LISTEN', '-Fpu']])
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

describe('processInfo', () => {
  it('reads start time and command line from ps (absolute path)', async () => {
    const seen: string[][] = []
    const info = await processInfo(9, async (file, args) => {
      seen.push([file, ...args])
      return { stdout: 'Sat Nov  1 01:19:22 2026 /n/node /s/bin.js --port 4441 --host 127.0.0.1\n', code: 0 }
    })
    assert.deepEqual(seen, [['/bin/ps', '-p', '9', '-o', 'lstart=,command=']])
    assert.equal(info.state, 'found')
    if (info.state === 'found') {
      assert.equal(info.command, '/n/node /s/bin.js --port 4441 --host 127.0.0.1')
      assert.equal(info.startedAt?.getFullYear(), 2026)
    }
  })
  it('exit 1 with no output is a process that is gone; a failure or timeout is unknown, never gone', async () => {
    assert.deepEqual(await processInfo(9, async () => ({ stdout: '', code: 1 })), { state: 'gone' })
    assert.deepEqual(await processInfo(9, async () => ({ stdout: '', code: null })), { state: 'unknown' })
    assert.deepEqual(await processInfo(9, async () => ({ stdout: '', code: 'ENOENT' })), { state: 'unknown' })
    assert.deepEqual(await processInfo(9, async () => ({ stdout: '', code: 0 })), { state: 'unknown' })
  })
  it('the real ps describes this very process', async () => {
    const info = await processInfo(process.pid)
    assert.equal(info.state, 'found')
    if (info.state === 'found') {
      assert.ok(info.command.includes('node'))
      assert.ok(info.startedAt !== null && Math.abs(info.startedAt.getTime() - (Date.now() - process.uptime() * 1000)) < 5_000)
    }
  })
})

describe('matchesManifest (whole arguments, port, start time)', () => {
  const manifest = { entry: '/app/service/bin.js', port: 4441, startedAt: '2026-11-01T01:19:22.000Z' }
  const found = (command: string, startedAt: Date | null = new Date(manifest.startedAt)): ProcessInfo => ({ state: 'found', command, startedAt })
  const good = '/app/service/node/bin/node /app/service/bin.js --port 4441 --host 127.0.0.1 --no-open'

  it('matches the service: entry and --port as arguments, start time close', () => {
    assert.equal(matchesManifest(found(good), manifest), 'match')
    assert.equal(matchesManifest(found(good, new Date(Date.parse(manifest.startedAt) + 3_000)), manifest), 'match')
    assert.equal(matchesManifest(found(good, null), manifest), 'match', 'no start time from ps: the other checks decide')
  })
  it('a substring is not an argument: a longer path, another port', () => {
    assert.equal(matchesManifest(found('/x/node /app/service/bin.js.bak --port 4441'), manifest), 'mismatch')
    assert.equal(matchesManifest(found('/x/node /old/app/service/bin.js --port 4441'), manifest), 'mismatch')
    assert.equal(matchesManifest(found('/x/node /app/service/bin.js --port 44410'), manifest), 'mismatch')
    assert.equal(matchesManifest(found('/x/node /app/service/bin.js --port 4442'), manifest), 'mismatch')
    assert.equal(matchesManifest(found('/x/node /app/service/bin.js'), manifest), 'mismatch')
  })
  it('a start time far from the manifest’s is a different process (pid reuse by the same program)', () => {
    assert.equal(matchesManifest(found(good, new Date(Date.parse(manifest.startedAt) + 3_600_000)), manifest), 'mismatch')
    assert.equal(matchesManifest(found(good, new Date(Date.parse(manifest.startedAt) - 3_600_000)), manifest), 'mismatch')
  })
  it('gone is a mismatch; a failed ps is unknown', () => {
    assert.equal(matchesManifest({ state: 'gone' }, manifest), 'mismatch')
    assert.equal(matchesManifest({ state: 'unknown' }, manifest), 'unknown')
  })
})

describe('liveManifestPid (a stale manifest must not outlive its process, a transient failure must not erase a live one)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guanxi-owner-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const setup = (port = 4441) => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, { pid: 4242, port, startedAt: '2026-11-01T01:19:22.000Z', entry: '/app/service/bin.js' })
    return paths
  }
  const info = (command: string): ProcessInfo => ({ state: 'found', command, startedAt: new Date('2026-11-01T01:19:23.000Z') })

  it('returns the pid while it is alive and still the described service', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => true, processInfo: async () => info('/app/node /app/service/bin.js --port 4441') }), 4242)
    assert.notEqual(readManifest(paths), null)
  })
  it('removes the manifest when the pid is dead', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => false, processInfo: async () => ({ state: 'gone' }) }), null)
    assert.equal(readManifest(paths), null)
  })
  it('removes the manifest when the pid was reused by an unrelated process', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => true, processInfo: async () => info('/usr/bin/vim notes.txt') }), null)
    assert.equal(readManifest(paths), null)
  })
  it('KEEPS the manifest and reports "unverified" when ps fails or times out', async () => {
    const paths = setup()
    assert.equal(await liveManifestPid(4441, { paths, alive: () => true, processInfo: async () => ({ state: 'unknown' }) }), 'unverified')
    assert.notEqual(readManifest(paths), null)
  })
  it('leaves the manifest of a service on another port alone', async () => {
    const paths = setup(5555)
    assert.equal(await liveManifestPid(4441, { paths, alive: () => false, processInfo: async () => ({ state: 'gone' }) }), null)
    assert.notEqual(readManifest(paths), null)
  })
})
