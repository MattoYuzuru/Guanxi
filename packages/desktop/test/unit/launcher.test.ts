import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  SpawnFailedError,
  isProcessAlive,
  readManifest,
  removeManifest,
  servicePaths,
  spawnDetachedService,
  writeManifest,
} from '../../src/service/launcher.ts'
import type { SpawnedService } from '../../src/service/launcher.ts'
import { stopService } from '../../src/service/stop.ts'
import type { StopDeps } from '../../src/service/stop.ts'

let dir: string
const children: SpawnedService[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guanxi-launcher-')) })
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

const sleeper = (extra = '') => ({ command: process.execPath, args: ['-e', `console.log('hello from service'); ${extra} setInterval(() => {}, 1000)`], env: { PATH: process.env['PATH'] ?? '' }, entry: 'inline' })
const pgid = (pid: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim()

describe('spawnDetachedService', () => {
  it('starts a process of its own: separate process group, output in a private log file, not a pipe', async () => {
    const paths = servicePaths(join(dir, 'data'))
    const child = await spawnDetachedService(sleeper(), paths)
    children.push(child)
    assert.ok(isProcessAlive(child.pid))
    assert.notEqual(pgid(child.pid), pgid(process.pid), 'its own process group: a signal to the shell group does not reach it')
    assert.equal(pgid(child.pid), String(child.pid), 'it leads its own group')
    for (let i = 0; i < 50 && !existsSync(paths.log); i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 200))
    assert.match(readFileSync(paths.log, 'utf8'), /hello from service/)
    assert.equal(statSync(paths.log).mode & 0o777, 0o600)
    assert.equal(statSync(paths.directory).mode & 0o777, 0o700)
  })

  it('reports the exit of the child without throwing', async () => {
    const child = await spawnDetachedService({ ...sleeper(), args: ['-e', 'process.exit(7)'] }, servicePaths(join(dir, 'data')))
    assert.deepEqual(await child.exited, { code: 7, signal: null })
  })

  it('rejects with SpawnFailedError when the executable does not exist', async () => {
    await assert.rejects(
      spawnDetachedService({ ...sleeper(), command: join(dir, 'no-such-binary') }, servicePaths(join(dir, 'data'))),
      (error: unknown) => error instanceof SpawnFailedError && error.code === 'ENOENT',
    )
  })

  it('rotates a log that grew past the cap instead of growing without bound', async () => {
    const paths = servicePaths(join(dir, 'data'))
    const first = await spawnDetachedService({ ...sleeper(), args: ['-e', 'process.exit(0)'] }, paths)
    await first.exited
    writeFileSync(paths.log, Buffer.alloc(6 * 1024 * 1024))
    const second = await spawnDetachedService({ ...sleeper(), args: ['-e', 'console.log("fresh"); process.exit(0)'] }, paths)
    await second.exited
    assert.ok(existsSync(`${paths.log}.1`))
    assert.ok(statSync(paths.log).size < 1024)
  })
})

describe('terminate (SIGTERM, then SIGKILL, on the service process group)', () => {
  it('a child that exits on SIGTERM is confirmed gone', async () => {
    const child = await spawnDetachedService(sleeper(), servicePaths(join(dir, 'data')))
    children.push(child)
    assert.equal(await child.terminate(2000, 1000), true)
    assert.equal(isProcessAlive(child.pid), false)
  })

  it('a child that ignores SIGTERM is killed with SIGKILL and then confirmed gone', async () => {
    const child = await spawnDetachedService(sleeper("process.on('SIGTERM', () => {});"), servicePaths(join(dir, 'data')))
    children.push(child)
    await new Promise((r) => setTimeout(r, 300))
    const started = Date.now()
    assert.equal(await child.terminate(400, 2000), true)
    assert.ok(Date.now() - started >= 350, 'SIGTERM was given its grace period first')
    assert.equal(isProcessAlive(child.pid), false)
  })

  it('never signals a reaped child’s pid (the OS may have given it to someone else)', async () => {
    const calls: Array<[number, string]> = []
    const child = await spawnDetachedService({ ...sleeper(), args: ['-e', 'process.exit(0)'] }, servicePaths(join(dir, 'data')), { kill: (pid, signal) => void calls.push([pid, signal]) })
    await child.exited
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(await child.terminate(200, 200), true, 'an exited child counts as stopped')
    child.kill()
    assert.deepEqual(calls, [])
  })

  it('falls back from the group to the pid only while the child is still ours', async () => {
    const calls: Array<[number, string]> = []
    const child = await spawnDetachedService(sleeper(), servicePaths(join(dir, 'data')), {
      kill: (pid, signal) => {
        calls.push([pid, signal])
        if (pid < 0) throw Object.assign(new Error('no such group'), { code: 'ESRCH' })
        process.kill(pid, signal)
      },
    })
    children.push(child)
    assert.equal(await child.terminate(2000, 1000), true)
    assert.deepEqual(calls.map(([pid]) => (pid < 0 ? 'group' : 'pid')), ['group', 'pid'])
  })

  it('reaches what the child started (its process group), not only the child', async () => {
    const paths = servicePaths(join(dir, 'data'))
    const pidFile = join(dir, 'grandchild.pid')
    const child = await spawnDetachedService(
      sleeper(`const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`),
      paths,
    )
    children.push(child)
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50))
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(isProcessAlive(grandchild))
    assert.equal(await child.terminate(2000, 1000), true)
    for (let i = 0; i < 40 && isProcessAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(isProcessAlive(grandchild), false)
  })
})

describe('manifest', () => {
  it('round-trips and rejects malformed content', () => {
    const paths = servicePaths(join(dir, 'data'))
    const manifest = { pid: 4242, port: 4441, startedAt: '2026-11-01T00:00:00.000Z', entry: '/x/bin.js' }
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, manifest)
    assert.deepEqual(readManifest(paths), manifest)
    assert.equal(statSync(paths.manifest).mode & 0o777, 0o600)
    for (const bad of ['', 'null', '[]', '{"pid":"1"}', '{"pid":0,"port":1,"startedAt":"x","entry":"y"}', '{"pid":1,"port":1,"startedAt":"x","entry":"y"}', 'not json']) {
      writeFileSync(paths.manifest, bad)
      assert.equal(readManifest(paths), null, bad)
    }
    removeManifest(paths)
    assert.equal(readManifest(paths), null)
  })
})

describe('stopService (explicit user action only)', () => {
  const deps = (paths: ReturnType<typeof servicePaths>, overrides: Partial<StopDeps> = {}): StopDeps => ({
    paths,
    probe: async () => ({ kind: 'ready', version: '1' }),
    kill: () => undefined,
    alive: () => true,
    processInfo: async () => ({ state: 'found', command: '/app/node /app/service/bin.js --port 4441', startedAt: new Date('2026-11-01T01:19:23.000Z') }),
    listeners: async () => [{ pid: 4242, uid: 501 }],
    sleep: async () => undefined,
    now: (() => { let t = 0; return () => (t += 100) })(),
    timeoutMs: 1000,
    ...overrides,
  })

  it('does nothing for a service the shell did not start (no manifest)', async () => {
    const killed: number[] = []
    const result = await stopService(deps(servicePaths(join(dir, 'data')), { kill: (pid) => void killed.push(pid) }))
    assert.deepEqual(result, { ok: false, reason: 'not_managed' })
    assert.deepEqual(killed, [])
  })

  it('stops the manifest pid only while its port still answers as Guanxi', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, { pid: 4242, port: 4441, startedAt: '2026-11-01T01:19:22.000Z', entry: '/app/service/bin.js' })
    const killed: Array<[number, string]> = []
    let alive = true
    const result = await stopService(deps(paths, { kill: (pid, signal) => { killed.push([pid, signal]); alive = false }, alive: () => alive }))
    assert.deepEqual(result, { ok: true, pid: 4242 })
    assert.deepEqual(killed, [[4242, 'SIGTERM']])
    assert.equal(readManifest(paths), null)
  })

  it('never signals a recycled pid: a dead service or a port that is not Guanxi leaves the process alone', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    for (const scenario of [{ alive: () => false }, { probe: async () => ({ kind: 'closed' as const }) }, { probe: async () => ({ kind: 'foreign' as const }) }]) {
      writeManifest(paths, { pid: 4242, port: 4441, startedAt: '2026-11-01T01:19:22.000Z', entry: '/app/service/bin.js' })
      const killed: number[] = []
      const result = await stopService(deps(paths, { ...scenario, kill: (pid) => void killed.push(pid) }))
      assert.equal(result.ok, false)
      assert.deepEqual(killed, [])
    }
  })

  const manifest = { pid: 4242, port: 4441, startedAt: '2026-11-01T01:19:22.000Z', entry: '/app/service/bin.js' }
  const found = (command: string, startedAt = '2026-11-01T01:19:23.000Z') => async () => ({ state: 'found' as const, command, startedAt: new Date(startedAt) })

  it('never signals a pid that is not the described service (pid reuse); the stale manifest is removed', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    const reused = [
      found('/usr/bin/vim notes.txt'),
      found('/other/node /app/service/bin.js.bak --port 4441'), // a longer path is not the entry
      found('/app/node /app/service/bin.js --port 5555'), // same program, another port
      found('/app/node /app/service/bin.js --port 4441', '2026-11-01T05:00:00.000Z'), // same program, started hours later
      async () => ({ state: 'gone' as const }),
    ]
    for (const processInfo of reused) {
      writeManifest(paths, manifest)
      const killed: number[] = []
      const result = await stopService(deps(paths, { processInfo, kill: (pid) => void killed.push(pid) }))
      assert.deepEqual(result, { ok: false, reason: 'not_running' })
      assert.deepEqual(killed, [])
      assert.equal(readManifest(paths), null)
    }
  })

  it('a failed or timed-out ps is "unverified": nothing is signalled and the manifest is KEPT', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, manifest)
    const killed: number[] = []
    const result = await stopService(deps(paths, { processInfo: async () => ({ state: 'unknown' }), kill: (pid) => void killed.push(pid) }))
    assert.deepEqual(result, { ok: false, reason: 'unverified' })
    assert.deepEqual(killed, [])
    assert.deepEqual(readManifest(paths), manifest)
  })

  it('the port’s listener must be the manifest pid: another listener, no listener or a failed lsof signals nothing and keeps the manifest', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    for (const listeners of [async () => [{ pid: 9999, uid: 501 }], async () => [{ pid: 4242, uid: 501 }, { pid: 9999, uid: 501 }], async () => [], async () => null]) {
      writeManifest(paths, manifest)
      const killed: number[] = []
      const result = await stopService(deps(paths, { listeners, kill: (pid) => void killed.push(pid) }))
      assert.deepEqual(result, { ok: false, reason: 'unverified' })
      assert.deepEqual(killed, [])
      assert.deepEqual(readManifest(paths), manifest)
    }
  })

  it('an EPERM from the system is a reported result, not an exception', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, { pid: 4242, port: 4441, startedAt: '2026-11-01T01:19:22.000Z', entry: '/app/service/bin.js' })
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    assert.deepEqual(await stopService(deps(paths, { kill: () => { throw eperm } })), { ok: false, reason: 'not_permitted', pid: 4242 })
    assert.notEqual(readManifest(paths), null)
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' })
    assert.deepEqual(await stopService(deps(paths, { kill: () => { throw esrch } })), { ok: false, reason: 'not_running' })
    assert.equal(readManifest(paths), null)
  })

  it('reports a service that does not stop in time instead of claiming success', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, { pid: 4242, port: 4441, startedAt: '2026-11-01T01:19:22.000Z', entry: '/app/service/bin.js' })
    assert.deepEqual(await stopService(deps(paths)), { ok: false, reason: 'not_stopped', pid: 4242 })
    assert.notEqual(readManifest(paths), null)
  })
})
