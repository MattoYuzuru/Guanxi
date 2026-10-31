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
    writeManifest(paths, { pid: 4242, port: 4441, startedAt: 'x', entry: 'y' })
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
      writeManifest(paths, { pid: 4242, port: 4441, startedAt: 'x', entry: 'y' })
      const killed: number[] = []
      const result = await stopService(deps(paths, { ...scenario, kill: (pid) => void killed.push(pid) }))
      assert.equal(result.ok, false)
      assert.deepEqual(killed, [])
    }
  })

  it('reports a service that does not stop in time instead of claiming success', async () => {
    const paths = servicePaths(join(dir, 'data'))
    mkdirSync(paths.directory, { recursive: true })
    writeManifest(paths, { pid: 4242, port: 4441, startedAt: 'x', entry: 'y' })
    assert.deepEqual(await stopService(deps(paths)), { ok: false, reason: 'not_stopped', pid: 4242 })
    assert.notEqual(readManifest(paths), null)
  })
})
