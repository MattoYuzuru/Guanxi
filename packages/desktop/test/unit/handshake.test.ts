import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveConfig } from '../../src/config.ts'
import { ensureService } from '../../src/service/handshake.ts'
import type { HandshakeDeps } from '../../src/service/handshake.ts'
import type { ExitInfo, SpawnedService } from '../../src/service/launcher.ts'
import { SpawnFailedError } from '../../src/service/launcher.ts'
import { ServiceMissingError } from '../../src/service/locate.ts'
import type { ServiceCommand } from '../../src/service/locate.ts'
import type { Listener } from '../../src/service/owner.ts'
import type { ProbeResult } from '../../src/service/probe.ts'

const config = resolveConfig({ GUANXI_API_PORT: '4441', GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '1000', GUANXI_DESKTOP_POLL_INTERVAL_MS: '100' }, '/h')
const command: ServiceCommand = { command: '/app/node', args: ['bin.js'], env: {}, entry: '/app/service/bin.js' }
const READY: ProbeResult = { kind: 'ready', version: '9.9.9' }
const ME = 501
const CHILD_PID = 4242

interface World {
  deps: HandshakeDeps
  clock: { now: number }
  calls: string[]
  killed: string[]
  forgotten: number[]
  exit(info: ExitInfo): void
}

interface Options {
  /** Listeners the OS reports; `'child'` means "the process we spawned, owned by this user". */
  listeners?: Listener[] | null | 'child'
  expected?: number | null
  stubborn?: boolean
  overrides?: Partial<HandshakeDeps>
}

/** `script` is consumed one probe at a time; the last entry repeats. Time only moves when the handshake sleeps. */
function world(script: ProbeResult[], options: Options = {}): World {
  const clock = { now: 0 }
  const calls: string[] = []
  const killed: string[] = []
  const forgotten: number[] = []
  let index = 0
  let resolveExit: (info: ExitInfo) => void = () => undefined
  const child: SpawnedService = {
    pid: CHILD_PID,
    exited: new Promise((accept) => { resolveExit = accept }),
    kill: (signal) => { killed.push(signal ?? 'SIGTERM') },
    terminate: async () => { killed.push(options.stubborn ? 'SIGTERM+SIGKILL (still alive)' : 'SIGTERM'); return !options.stubborn },
  }
  const listeners = options.listeners === undefined ? 'child' : options.listeners
  const deps: HandshakeDeps = {
    config,
    logPath: '/data/desktop/service.log',
    probe: async () => { calls.push('probe'); return script[Math.min(index++, script.length - 1)]! },
    selfUid: ME,
    listeners: async () => (listeners === 'child' ? [{ pid: calls.includes('spawn') ? CHILD_PID : 7777, uid: ME }] : listeners),
    expectedPid: async () => options.expected ?? null,
    forgetManifest: () => { forgotten.push(clock.now) },
    locate: () => { calls.push('locate'); return command },
    spawn: async () => { calls.push('spawn'); return child },
    sleep: async (ms) => { clock.now += ms },
    now: () => clock.now,
    ...options.overrides,
  }
  return { deps, clock, calls, killed, forgotten, exit: (info) => resolveExit(info) }
}

describe('ensureService', () => {
  it('attaches to a running service of this user without starting anything', async () => {
    const w = world([READY])
    assert.deepEqual(await ensureService(w.deps), { ok: true, origin: 'http://127.0.0.1:4441', attached: true, version: '9.9.9', pid: null })
    assert.deepEqual(w.calls, ['probe'])
  })

  it('starts a service when the port is closed, then waits for it', async () => {
    const w = world([{ kind: 'closed' }, { kind: 'closed' }, { kind: 'hung' }, READY])
    const started: Array<[number, string]> = []
    const phases: string[] = []
    const result = await ensureService({ ...w.deps, onStarted: (pid, c) => started.push([pid, c.entry]), onPhase: (p) => phases.push(p) })
    assert.deepEqual(result, { ok: true, origin: 'http://127.0.0.1:4441', attached: false, version: '9.9.9', pid: CHILD_PID })
    assert.deepEqual(w.calls.filter((c) => c !== 'probe'), ['locate', 'spawn'])
    assert.deepEqual(started, [[CHILD_PID, '/app/service/bin.js']])
    assert.deepEqual(phases, ['checking', 'starting', 'waiting'])
    assert.deepEqual(w.killed, [], 'a healthy service is never signalled')
    assert.deepEqual(w.forgotten, [], 'its manifest stays')
  })

  it('port_busy: something else answers; nothing is located, spawned or killed', async () => {
    const w = world([{ kind: 'foreign' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
    assert.deepEqual(w.calls, ['probe'])
  })

  it('port_busy: a foreign listener wins the race after our spawn; our child is terminated and the manifest dropped', async () => {
    const w = world([{ kind: 'closed' }, { kind: 'foreign' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
    assert.deepEqual(w.killed, ['SIGTERM'])
    assert.equal(w.forgotten.length, 1)
  })

  it('health_timeout: a listener that does not answer is reported, never spawned beside or killed', async () => {
    const w = world([{ kind: 'hung' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'health_timeout', port: 4441, timeoutMs: config.probeTimeoutMs, startedByShell: false, stopped: true })
    assert.deepEqual(w.calls, ['probe'])
    assert.deepEqual(w.killed, [])
  })

  it('health_timeout: a started service that never becomes healthy is terminated at the deadline and the manifest dropped', async () => {
    const w = world([{ kind: 'closed' }])
    const result = await ensureService(w.deps)
    assert.deepEqual(result, { ok: false, code: 'health_timeout', port: 4441, timeoutMs: 1000, startedByShell: true, stopped: true })
    assert.deepEqual(w.killed, ['SIGTERM'])
    assert.equal(w.forgotten.length, 1)
    assert.ok(w.clock.now >= 1000 && w.clock.now < 1300, `waited about the deadline, not longer (${w.clock.now})`)
  })

  it('health_timeout: a child that survives SIGTERM and SIGKILL is reported as not stopped, with its pid, and the manifest is kept', async () => {
    const w = world([{ kind: 'closed' }], { stubborn: true })
    const result = await ensureService(w.deps)
    assert.deepEqual(result, { ok: false, code: 'health_timeout', port: 4441, timeoutMs: 1000, startedByShell: true, stopped: false, pid: CHILD_PID })
    assert.deepEqual(w.forgotten, [], 'the shell still owns a process it could not stop')
  })

  it('service_missing: the entry or the Node does not exist', async () => {
    const w = world([{ kind: 'closed' }], { overrides: { locate: () => { throw new ServiceMissingError('/app/service/node/bin/node') } } })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'service_missing', entry: '/app/service/node/bin/node' })
    assert.ok(!w.calls.includes('spawn'))
  })

  it('service_missing: the runtime cannot be executed (spawn error carries the system message)', async () => {
    const w = world([{ kind: 'closed' }], { overrides: { spawn: async () => { throw new SpawnFailedError('spawn ENOENT', 'ENOENT') } } })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'service_missing', entry: '/app/service/bin.js', detail: 'spawn ENOENT' })
  })

  it('service_exited: the child ends before it is healthy; exit code and log path are reported, the manifest dropped', async () => {
    const w = world([{ kind: 'closed' }])
    const run = ensureService({ ...w.deps, sleep: async (ms) => { w.exit({ code: 3, signal: null }); await new Promise((r) => setImmediate(r)); w.clock.now += ms } })
    assert.deepEqual(await run, { ok: false, code: 'service_exited', exitCode: 3, signal: null, logPath: '/data/desktop/service.log' })
    assert.deepEqual(w.killed, [])
    assert.equal(w.forgotten.length, 1, 'a dead child must not stay in the manifest (its pid can be reused)')
  })

  it('attaches when the child exits cleanly because another starter already won; the manifest no longer names our dead child', async () => {
    const w = world([{ kind: 'closed' }, { kind: 'closed' }, { kind: 'closed' }, READY], { listeners: [{ pid: 9001, uid: ME }] })
    const result = await ensureService({ ...w.deps, sleep: async (ms) => { w.exit({ code: 0, signal: null }); await new Promise((r) => setImmediate(r)); w.clock.now += ms } })
    assert.deepEqual(result, { ok: true, origin: 'http://127.0.0.1:4441', attached: true, version: '9.9.9', pid: null })
    assert.equal(w.forgotten.length, 1)
  })

  it('ui_missing: reported for an existing service and for one we just started', async () => {
    assert.deepEqual(await ensureService(world([{ kind: 'ui_missing', version: '1' }]).deps), { ok: false, code: 'ui_missing', port: 4441 })
    const w = world([{ kind: 'closed' }, { kind: 'ui_missing', version: '1' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'ui_missing', port: 4441 })
    assert.deepEqual(w.killed, [], 'a service that answers is left running')
  })
})

describe('ensureService: who owns the port (an answer shaped like Guanxi is not enough)', () => {
  it('refuses a listener owned by another user, and never starts or kills anything', async () => {
    const w = world([READY], { listeners: [{ pid: 123, uid: 0 }] })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_owned_by_other_user', port: 4441 })
    assert.deepEqual(w.calls, ['probe'])
  })

  it('refuses an answering port whose listener this user cannot see (lsof shows own sockets only)', async () => {
    const w = world([READY], { listeners: [] })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_owned_by_other_user', port: 4441 })
  })

  it('refuses when ownership cannot be established (lookup failed)', async () => {
    const w = world([READY], { listeners: null })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_unverified', port: 4441 })
  })

  it('a service the shell started must be the manifest pid: a same-user squatter beside it is refused', async () => {
    const w = world([READY], { listeners: [{ pid: 7777, uid: ME }], expected: 5150 })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
  })

  it('a service the shell started and that is still the manifest pid is attached', async () => {
    const w = world([READY], { listeners: [{ pid: 5150, uid: ME }], expected: 5150 })
    assert.deepEqual(await ensureService(w.deps), { ok: true, origin: 'http://127.0.0.1:4441', attached: true, version: '9.9.9', pid: 5150 })
  })

  it('after our own spawn, the answering listener must be the child we started', async () => {
    const w = world([{ kind: 'closed' }, READY], { listeners: [{ pid: 7777, uid: ME }] })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
    assert.deepEqual(w.killed, ['SIGTERM'])
    assert.equal(w.forgotten.length, 1)
  })

  it('after our own spawn, another user answering is refused and our child removed', async () => {
    const w = world([{ kind: 'closed' }, READY], { listeners: [{ pid: CHILD_PID, uid: 0 }] })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_owned_by_other_user', port: 4441 })
    assert.deepEqual(w.killed, ['SIGTERM'])
  })

  it('without a uid on the platform the uid test is skipped but the pid test still applies', async () => {
    const w = world([READY], { listeners: [{ pid: 7777, uid: 0 }], expected: 5150, overrides: { selfUid: null } })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
  })
})
