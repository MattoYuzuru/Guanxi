import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveConfig } from '../../src/config.ts'
import { ensureService } from '../../src/service/handshake.ts'
import type { HandshakeDeps } from '../../src/service/handshake.ts'
import type { ExitInfo, SpawnedService } from '../../src/service/launcher.ts'
import { SpawnFailedError } from '../../src/service/launcher.ts'
import { ServiceMissingError } from '../../src/service/locate.ts'
import type { ServiceCommand } from '../../src/service/locate.ts'
import type { ProbeResult } from '../../src/service/probe.ts'

const config = resolveConfig({ GUANXI_API_PORT: '4441', GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '1000', GUANXI_DESKTOP_POLL_INTERVAL_MS: '100' }, '/h')
const command: ServiceCommand = { command: '/bin/electron', args: ['bin.js'], env: {}, entry: '/app/service/bin.js' }
const READY: ProbeResult = { kind: 'ready', version: '9.9.9' }

interface World {
  deps: HandshakeDeps
  clock: { now: number }
  calls: string[]
  killed: string[]
  exit(info: ExitInfo): void
}

/** `script` is consumed one probe at a time; the last entry repeats. Time only moves when the handshake sleeps. */
function world(script: ProbeResult[], overrides: Partial<HandshakeDeps> = {}): World {
  const clock = { now: 0 }
  const calls: string[] = []
  const killed: string[] = []
  let index = 0
  let resolveExit: (info: ExitInfo) => void = () => undefined
  const child: SpawnedService = {
    pid: 4242,
    exited: new Promise((accept) => { resolveExit = accept }),
    kill: (signal) => { killed.push(signal ?? 'SIGTERM') },
  }
  const deps: HandshakeDeps = {
    config,
    logPath: '/data/desktop/service.log',
    probe: async () => { calls.push('probe'); return script[Math.min(index++, script.length - 1)]! },
    locate: () => { calls.push('locate'); return command },
    spawn: async () => { calls.push('spawn'); return child },
    sleep: async (ms) => { clock.now += ms },
    now: () => clock.now,
    ...overrides,
  }
  return { deps, clock, calls, killed, exit: (info) => resolveExit(info) }
}

describe('ensureService', () => {
  it('attaches to a running service without starting anything', async () => {
    const w = world([READY])
    assert.deepEqual(await ensureService(w.deps), { ok: true, origin: 'http://127.0.0.1:4441', attached: true, version: '9.9.9', pid: null })
    assert.deepEqual(w.calls, ['probe'])
  })

  it('starts a service when the port is closed, then waits for it', async () => {
    const w = world([{ kind: 'closed' }, { kind: 'closed' }, { kind: 'hung' }, READY])
    const started: Array<[number, string]> = []
    const phases: string[] = []
    const result = await ensureService({ ...w.deps, onStarted: (pid, c) => started.push([pid, c.entry]), onPhase: (p) => phases.push(p) })
    assert.deepEqual(result, { ok: true, origin: 'http://127.0.0.1:4441', attached: false, version: '9.9.9', pid: 4242 })
    assert.deepEqual(w.calls.filter((c) => c !== 'probe'), ['locate', 'spawn'])
    assert.deepEqual(started, [[4242, '/app/service/bin.js']])
    assert.deepEqual(phases, ['checking', 'starting', 'waiting'])
    assert.deepEqual(w.killed, [], 'a healthy service is never signalled')
  })

  it('port_busy: something else answers; nothing is located, spawned or killed', async () => {
    const w = world([{ kind: 'foreign' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
    assert.deepEqual(w.calls, ['probe'])
  })

  it('port_busy: a foreign listener wins the race after our spawn; our child is removed', async () => {
    const w = world([{ kind: 'closed' }, { kind: 'foreign' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'port_busy', port: 4441 })
    assert.deepEqual(w.killed, ['SIGTERM'])
  })

  it('health_timeout: a listener that does not answer is reported, never spawned beside or killed', async () => {
    const w = world([{ kind: 'hung' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'health_timeout', port: 4441, timeoutMs: config.probeTimeoutMs, startedByShell: false })
    assert.deepEqual(w.calls, ['probe'])
    assert.deepEqual(w.killed, [])
  })

  it('health_timeout: a started service that never becomes healthy is stopped at the deadline', async () => {
    const w = world([{ kind: 'closed' }])
    const result = await ensureService(w.deps)
    assert.deepEqual(result, { ok: false, code: 'health_timeout', port: 4441, timeoutMs: 1000, startedByShell: true })
    assert.deepEqual(w.killed, ['SIGTERM'])
    assert.ok(w.clock.now >= 1000 && w.clock.now < 1300, `waited about the deadline, not longer (${w.clock.now})`)
  })

  it('service_missing: the entry does not exist', async () => {
    const w = world([{ kind: 'closed' }], { locate: () => { throw new ServiceMissingError('/app/service/bin.js') } })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'service_missing', entry: '/app/service/bin.js' })
    assert.ok(!w.calls.includes('spawn'))
  })

  it('service_missing: the runtime cannot be executed (spawn error carries the system message)', async () => {
    const w = world([{ kind: 'closed' }], { spawn: async () => { throw new SpawnFailedError('spawn ENOENT', 'ENOENT') } })
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'service_missing', entry: '/app/service/bin.js', detail: 'spawn ENOENT' })
  })

  it('service_exited: the child ends before it is healthy; exit code and log path are reported', async () => {
    const w = world([{ kind: 'closed' }])
    const run = ensureService({ ...w.deps, sleep: async (ms) => { w.exit({ code: 3, signal: null }); await new Promise((r) => setImmediate(r)); w.clock.now += ms } })
    assert.deepEqual(await run, { ok: false, code: 'service_exited', exitCode: 3, signal: null, logPath: '/data/desktop/service.log' })
    assert.deepEqual(w.killed, [])
  })

  it('attaches when the child exits cleanly because another starter already won (the CLI does this)', async () => {
    const w = world([{ kind: 'closed' }, { kind: 'closed' }, { kind: 'closed' }, READY])
    const result = await ensureService({ ...w.deps, sleep: async (ms) => { w.exit({ code: 0, signal: null }); await new Promise((r) => setImmediate(r)); w.clock.now += ms } })
    assert.deepEqual(result, { ok: true, origin: 'http://127.0.0.1:4441', attached: true, version: '9.9.9', pid: null })
  })

  it('ui_missing: reported for an existing service and for one we just started', async () => {
    assert.deepEqual(await ensureService(world([{ kind: 'ui_missing', version: '1' }]).deps), { ok: false, code: 'ui_missing', port: 4441 })
    const w = world([{ kind: 'closed' }, { kind: 'ui_missing', version: '1' }])
    assert.deepEqual(await ensureService(w.deps), { ok: false, code: 'ui_missing', port: 4441 })
    assert.deepEqual(w.killed, [], 'a service that answers is left running')
  })
})
