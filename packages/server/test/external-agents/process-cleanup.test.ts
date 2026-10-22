import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EgressScrubber } from '../../src/egress/types.ts'
import { AgentProcess, awaitOwnedGroupEmpty, startClaudeAuthStatus } from '../../src/external-agents/process.ts'

const scrubber = { isReady: () => true, scrub: <T>(value: T) => value } as unknown as EgressScrubber
async function scratch(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-cleanup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function until(check: () => Promise<boolean> | boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Fixture did not reach the expected lifecycle point')
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }

test('AgentProcess.close returns one cached group-empty acknowledgement after the primary close', async t => {
  const dir = await scratch(t)
  const script = join(dir, 'adapter.mjs')
  const childPidFile = join(dir, 'child.pid')
  await writeFile(script, `
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
    writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1000)
  `)
  const processObject = new AgentProcess(process.execPath, [script], { PATH: process.env.PATH ?? '' }, dir, scrubber, new AbortController().signal, 1024)
  try {
    await until(async () => { try { return (await readFile(childPidFile, 'utf8')).length > 0 } catch { return false } })
    const childPid = Number(await readFile(childPidFile, 'utf8'))
    const first = await processObject.close()
    assert.deepEqual(first, { confirmed: true, reason: 'group_empty' })
    const second = await processObject.close()
    assert.equal(second, first)
    await until(() => gone(childPid))
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
  } finally {
    try { const pid = Number(await readFile(childPidFile, 'utf8')); process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

test('startClaudeAuthStatus settles its result and proves the probe group empty before close resolves', async t => {
  const dir = await scratch(t)
  const script = join(dir, 'auth-status')
  const pidFile = join(dir, 'pids.json')
  const marker = join(dir, 'late-write')
  await writeFile(script, `#!${process.execPath}
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1000);setInterval(()=>{},1000)`)}], { stdio: 'ignore' })
    writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }))
    setInterval(() => {}, 1000)
  `)
  await chmod(script, 0o700)
  const controller = new AbortController()
  const probe = startClaudeAuthStatus(script, { PATH: process.env.PATH ?? '' }, dir, controller.signal, 1024)
  await until(async () => { try { return (await readFile(pidFile, 'utf8')).length > 0 } catch { return false } })
  const pids = JSON.parse(await readFile(pidFile, 'utf8'))
  controller.abort()
  const result = await probe.result
  assert.deepEqual(result, { ok: false, error: 'cancelled' })
  const cleanup = await probe.close()
  assert.equal(cleanup.confirmed, true)
  await until(() => gone(pids.parent) && gone(pids.child))
  await new Promise(resolve => setTimeout(resolve, 1200))
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('a missing executable yields a settled auth result with a confirmed no-child cleanup', async t => {
  const dir = await scratch(t)
  const probe = startClaudeAuthStatus(join(dir, 'missing'), { PATH: process.env.PATH ?? '' }, dir, new AbortController().signal, 1024)
  const result = await probe.result
  assert.equal(result.ok, false)
  const cleanup = await probe.close()
  assert.equal(cleanup.confirmed, true)
  assert.ok(cleanup.confirmed && ['no_child', 'spawn_failed'].includes(cleanup.reason))
})

test('missing-executable AgentProcess close observes no child instead of probing a numeric row', async t => {
  const dir = await scratch(t)
  const processObject = new AgentProcess(join(dir, 'missing'), [], { PATH: process.env.PATH ?? '' }, dir, scrubber, new AbortController().signal, 1024)
  const cleanup = await processObject.close()
  assert.deepEqual(cleanup, { confirmed: true, reason: 'no_child' })
})

test('Windows reports unsupported group confirmation instead of falsely releasing', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    assert.deepEqual(await awaitOwnedGroupEmpty(42, Promise.resolve(), 100), { confirmed: false, reason: 'unsupported_platform' })
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

test('group acknowledgement maps ESRCH, EPERM and close failure to stable outcomes', async t => {
  assert.deepEqual(await awaitOwnedGroupEmpty(undefined, Promise.resolve()), { confirmed: true, reason: 'no_child' })
  assert.deepEqual(await awaitOwnedGroupEmpty(42, Promise.reject(new Error('close failed'))), { confirmed: false, reason: 'close_error' })
  assert.deepEqual(await awaitOwnedGroupEmpty(42, new Promise(() => undefined), 30), { confirmed: false, reason: 'group_timeout' })
  const missing = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  assert.deepEqual(await awaitOwnedGroupEmpty(42, Promise.resolve(), 100), { confirmed: true, reason: 'group_empty' })
  missing.mock.restore()
  const denied = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  assert.deepEqual(await awaitOwnedGroupEmpty(42, Promise.resolve(), 80), { confirmed: false, reason: 'permission_denied' })
  denied.mock.restore()
})
