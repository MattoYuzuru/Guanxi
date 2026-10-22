import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import type { Connections } from '../../server/src/connections/service.ts'
import { privateProcessRecordPath, reapPrivateProcessRecord, runPrivateTrial,
  type PrivateProcessPolicy, type PrivateTrialHost, type PrivateTrialResult } from '../src/private-process.ts'
import type { PublicAssistantMessage } from '../src/public-projection.ts'
import { createTrialBinding, nonceHash, trialBindingTag, type TrialBinding } from '../src/trial-binding.ts'

type CompletionResult = Awaited<ReturnType<Connections['complete']>>
const clientScript = fileURLToPath(new URL('./fixtures/private-client.mjs', import.meta.url))
const supervisorScript = fileURLToPath(new URL('../src/private-supervisor.mjs', import.meta.url))
const launcherScript = fileURLToPath(new URL('../src/private-client-launcher.mjs', import.meta.url))
const cwd = fileURLToPath(new URL('../', import.meta.url))
const sentinels = ['fixture-account-sentinel', 'fixture-connection-sentinel',
  'fixture-provider-sentinel', 'fixture-model-sentinel', 'fixture-experiment-sentinel',
  'fixture-task-sentinel', 'fixture-arm-sentinel']

function setup(mode = 'two') {
  const root = mkdtempSync(join(tmpdir(), 'b1-private-'))
  chmodSync(root, 0o700)
  const recordDirectory = join(root, 'records')
  mkdirSync(recordDirectory, { mode: 0o700 })
  const report = join(root, 'report.json')
  const policy: PrivateProcessPolicy = {
    clientScript, cwd, recordDirectory,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? root,
      TMPDIR: root, LANG: 'C.UTF-8', BENCH_FIXTURE_REPORT: report, BENCH_FIXTURE_MODE: mode,
    },
    startupTimeoutMs: 3_000, shutdownGraceMs: 1_000, killGraceMs: 150,
    maximumControlBytes: 8_192, maximumRecordBytes: 16_384,
    channel: { maximumPayloadBytes: 65_536, maximumRequests: 4, requestTimeoutMs: 10_000,
      maximumInputChunkBytes: 65_536, outputTimeoutMs: 10_000 },
  }
  const binding = createTrialBinding({
    experimentId: 'fixture-experiment-sentinel', taskId: 'fixture-task-sentinel',
    armId: 'fixture-arm-sentinel', seed: 0, runId: 'run-1', attemptId: 'attempt-1',
    sessionId: 'session-1', accountId: 'fixture-account-sentinel',
    connectionId: 'fixture-connection-sentinel', provider: 'fixture-provider-sentinel',
    model: 'fixture-model-sentinel', modelApi: 'openai-completions', outputTokenLimit: 32,
    toolSource: 'builtin', attempt: { id: 'attempt-1', run_id: 'run-1' },
  })
  return { root, recordDirectory, report, policy, binding }
}

function result(): CompletionResult {
  return {
    role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture-model-sentinel',
    content: [
      { type: 'thinking', thinking: 'host private reasoning', thinkingSignature: 'host-private-signature' },
      { type: 'text', text: 'private host text' },
    ],
    stopReason: 'stop', timestamp: 1_800_000_000_000,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as CompletionResult
}

function hostFixture(options: { blockRetention?: boolean } = {}) {
  let calls = 0, retained = 0, retentionStarted = false
  let releaseGate: (() => void) | undefined, rejectGate: ((error: Error) => void) | undefined
  let gate: Promise<void> | undefined
  if (options.blockRetention) {
    gate = new Promise<void>((resolvePromise, reject) => { releaseGate = resolvePromise; rejectGate = reject })
  }
  const host: PrivateTrialHost = {
    model: { api: 'openai-completions', provider: 'fixture-provider-sentinel', id: 'fixture-model-sentinel' },
    gateway: {
      async complete() { calls++; return { requestId: `request-${calls}`, result: result() } },
    },
    async retain() { throw new Error('old retain must not be used by the process host') },
    async retainAndProject(requestId): Promise<PublicAssistantMessage> {
      retentionStarted = true; retained++
      if (gate) await gate
      return { text: `public-${requestId}`, toolCalls: [], stopReason: 'stop' }
    },
  }
  return {
    host, calls: () => calls, retained: () => retained,
    started: () => retentionStarted,
    release() { releaseGate?.() },
    reject() { rejectGate?.(Object.assign(new Error('fixture private retention rejection'), { code: 'retention_failed' })) },
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolvePromise()
        if (Date.now() >= deadline) return reject(new Error('fixture timeout'))
        setTimeout(tick, 20)
      } catch (error) { reject(error) }
    }
    tick()
  })
}
function alive(pid: number | null): boolean {
  if (!pid || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
async function waitGone(pid: number): Promise<void> {
  await waitFor(() => !alive(pid), 5_000)
}
function readJson(path: string): any { return JSON.parse(readFileSync(path, 'utf8')) }
function cleanup(root: string, pids: (number | null | undefined)[] = []): void {
  for (const pid of pids) {
    if (pid && pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
  rmSync(root, { recursive: true, force: true })
}
async function groupedHolder(t: TestContext, root: string, suffix = '') {
  const groupFile = join(root, `group${suffix}.json`)
  const holderScript = `const {spawn}=require('node:child_process');` +
    `const fs=require('node:fs');` +
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `fs.writeFileSync(process.argv[1],JSON.stringify({client:child.pid}));` +
    `setInterval(()=>{},1000)`
  const supervisor = spawn(process.execPath, ['-e', holderScript, groupFile], { detached: true, stdio: 'ignore' })
  let clientPid: number | undefined
  let cleaned = false
  const cleanupGroup = async () => {
    if (cleaned) return
    cleaned = true
    if (supervisor.pid) {
      try { process.kill(-supervisor.pid, 'SIGKILL') } catch { /* already gone */ }
      try { process.kill(supervisor.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (clientPid) { try { process.kill(clientPid, 'SIGKILL') } catch { /* already gone */ } }
    if (supervisor.pid) await waitGone(supervisor.pid).catch(() => undefined)
    if (clientPid) await waitGone(clientPid).catch(() => undefined)
  }
  // Register ownership before setup/record validation can throw.
  t.after(cleanupGroup)
  await waitFor(() => typeof supervisor.pid === 'number' && existsSync(groupFile))
  clientPid = readJson(groupFile).client as number
  return { supervisor, clientPid, cleanup: cleanupGroup }
}
function v2Record(x: ReturnType<typeof setup>, supervisorPid: number, clientPid: number, token: string): string {
  const recordPath = privateProcessRecordPath(x.binding, x.policy)
  writeFileSync(recordPath, JSON.stringify({
    version: 2, bindingTag: trialBindingTag(x.binding), nonceHash: nonceHash(x.binding),
    supervisorPid, pgid: supervisorPid, clientPid, clientExitCode: null,
    clientTokenHash: createHash('sha256').update(token).digest('hex'),
    clientScript: x.policy.clientScript, startedAt: Date.now(),
  }), { mode: 0o600 })
  return recordPath
}
function v1Record(x: ReturnType<typeof setup>, supervisorPid: number, clientPid: number | null): string {
  const recordPath = privateProcessRecordPath(x.binding, x.policy)
  writeFileSync(recordPath, JSON.stringify({
    version: 1, bindingTag: trialBindingTag(x.binding), nonceHash: nonceHash(x.binding),
    supervisorPid, pgid: supervisorPid, clientPid, clientExitCode: null,
    clientScript: x.policy.clientScript, startedAt: Date.now(),
  }), { mode: 0o600 })
  return recordPath
}
function supervisorCommand(x: ReturnType<typeof setup>, recordPath: string): string {
  return [process.execPath, supervisorScript,
    x.policy.clientScript, recordPath, String(x.policy.killGraceMs),
    trialBindingTag(x.binding), nonceHash(x.binding)].join(' ')
}

test('actual OS fixture uses fds 3/4 for two sequential public completions with no private identity in argv, env or frames', { timeout: 20_000 }, async () => {
  const x = setup()
  const h = hostFixture()
  try {
    const outcome = await runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy })
    assert.equal(outcome.reason, 'channel_input_ended')
    assert.equal(outcome.responsesDelivered, 2)
    assert.equal(outcome.childExitCode, 0)
    assert.equal(outcome.retentionConfirmed, true)
    assert.equal(outcome.cleanupConfirmed, true)
    assert.equal(h.calls(), 2); assert.equal(h.retained(), 2)
    const report = readJson(x.report)
    assert.equal(report.fd5Pipe, false)
    assert.equal(report.fd6Pipe, false)
    assert.equal(report.fd3Socket, true)
    assert.equal(report.fd4Socket, true)
    assert.equal(report.protocolError, null)
    assert.equal(report.responses.length, 2)
    assert.deepEqual(report.responseKeys, [
      ['id', 'message', 'requestId', 'status', 'version'],
      ['id', 'message', 'requestId', 'status', 'version'],
    ])
    assert.deepEqual(report.messageKeys, [
      ['stopReason', 'text', 'toolCalls'],
      ['stopReason', 'text', 'toolCalls'],
    ])
    assert.equal(report.responses[0].message.text, 'public-request-1')
    assert.equal(report.responses[1].message.text, 'public-request-2')
    const observable = JSON.stringify([report.argv, report.env, report.requests, report.responses])
    for (const sentinel of sentinels) assert.equal(observable.includes(sentinel), false, sentinel)
    assert.equal(observable.includes(x.binding.nonce), false)
    assert.equal(existsSync(privateProcessRecordPath(x.binding, x.policy)), false)
  } finally { cleanup(x.root) }
})

test('abort kills the owned group immediately but the run stays pending until the real retention ACK; late fulfil and reject are consumed', { timeout: 25_000 }, async () => {
  for (const late of ['fulfil', 'reject']) {
    const x = setup()
    const h = hostFixture({ blockRetention: true })
    const controller = new AbortController()
    const keepAlive = setInterval(() => {}, 1_000)
    let unhandled = 0
    const onUnhandled = () => { unhandled++ }
    process.on('unhandledRejection', onUnhandled)
    try {
      const pending = runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy, signal: controller.signal })
      await waitFor(() => h.started())
      const recordPath = privateProcessRecordPath(x.binding, x.policy)
      await waitFor(() => existsSync(recordPath))
      const record = readJson(recordPath)
      assert.equal(typeof record.clientPid, 'number')
      assert.equal(alive(record.clientPid), true)
      assert.equal(statSync(recordPath).mode & 0o077, 0)
      assert.equal(statSync(x.recordDirectory).mode & 0o077, 0)
      controller.abort()
      await waitGone(record.pgid)
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      assert.equal(controller.signal.aborted, true)
      assert.equal(settled, false, 'no timer may settle pending retention')
      assert.equal(existsSync(recordPath), true, 'record survives until the parent can verify ESRCH and finish ownership')
      if (late === 'fulfil') h.release(); else h.reject()
      const outcome: PrivateTrialResult = await pending
      assert.equal(outcome.cleanupConfirmed, true)
      assert.equal(outcome.retentionConfirmed, late === 'fulfil')
      assert.equal(outcome.reason, late === 'fulfil' ? 'channel_aborted' : 'retention_failed')
      assert.equal(existsSync(recordPath), false)
      await new Promise(resolvePromise => setImmediate(resolvePromise))
      assert.equal(unhandled, 0)
    } finally {
      clearInterval(keepAlive)
      process.off('unhandledRejection', onUnhandled)
      cleanup(x.root)
    }
  }
})

test('record exists while child and grandchild are alive; after forced supervisor death the reaper validates identity, removes only after ESRCH', { timeout: 25_000 }, async () => {
  const x = setup('descendant')
  const h = hostFixture({ blockRetention: true })
  const controller = new AbortController()
  let record: any
  try {
    const pending = runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy, signal: controller.signal })
    await waitFor(() => h.started())
    await waitFor(() => existsSync(x.report))
    const report = readJson(x.report)
    const recordPath = privateProcessRecordPath(x.binding, x.policy)
    await waitFor(() => existsSync(recordPath))
    record = readJson(recordPath)
    assert.equal(record.version, 2)
    assert.equal(record.pgid, record.supervisorPid)
    assert.equal(record.clientTokenHash,
      createHash('sha256').update(report.argv[3]).digest('hex'))
    const recordText = readFileSync(recordPath, 'utf8')
    assert.equal(recordText.includes(report.argv[3]), false, 'the durable record stores only the cleanup-token hash')
    for (const sentinel of sentinels) assert.equal(recordText.includes(sentinel), false, sentinel)
    assert.equal(recordText.includes(x.binding.nonce), false)
    assert.equal(alive(report.descendantPid), true)
    assert.equal(alive(record.clientPid), true)
    assert.equal(existsSync(recordPath), true)
    process.kill(record.supervisorPid, 'SIGKILL')
    await waitFor(() => !alive(record.supervisorPid))
    assert.equal(alive(record.clientPid), true)
    assert.equal(alive(report.descendantPid), true)
    assert.equal(existsSync(recordPath), true, 'supervisor must not unlink its record on death')
    const removed = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => pid === record.clientPid
        ? { pid, pgid: record.pgid, state: 'S', command: report.argv.slice(0, 4).join(' ') }
        : null,
    })
    assert.equal(removed, 'removed')
    assert.equal(existsSync(recordPath), false)
    await waitGone(record.pgid)
    await waitGone(report.descendantPid)
    controller.abort(); h.release()
    const outcome = await pending
    assert.equal(outcome.cleanupConfirmed, true)
  } finally {
    cleanup(x.root, [record?.clientPid, x.report && existsSync(x.report) ? readJson(x.report).descendantPid : undefined])
  }
})

test('nested descendants in the owned group are killed and cleanup is explicitly group-scoped', { timeout: 20_000 }, async () => {
  const x = setup('descendant')
  const h = hostFixture({ blockRetention: true })
  const controller = new AbortController()
  let report: any
  try {
    const pending = runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy, signal: controller.signal })
    await waitFor(() => h.started())
    await waitFor(() => existsSync(x.report))
    report = readJson(x.report)
    assert.equal(alive(report.descendantPid), true)
    controller.abort(); h.release()
    const outcome = await pending
    assert.equal(outcome.cleanupConfirmed, true)
    await waitGone(report.descendantPid)
    assert.equal(alive(report.descendantPid), false)
    assert.equal(existsSync(privateProcessRecordPath(x.binding, x.policy)), false)
  } finally { cleanup(x.root, [report?.descendantPid]) }
})

test('a detached descendant is outside the group proof, survives group cleanup and is cleaned by its explicit PID', { timeout: 20_000 }, async () => {
  const x = setup('detached')
  const h = hostFixture({ blockRetention: true })
  const controller = new AbortController()
  let report: any
  try {
    const pending = runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy, signal: controller.signal })
    await waitFor(() => h.started())
    await waitFor(() => existsSync(x.report))
    report = readJson(x.report)
    assert.equal(alive(report.descendantPid), true)
    controller.abort(); h.release()
    const outcome = await pending
    assert.equal(outcome.cleanupConfirmed, true, 'the supervisor group itself is gone')
    assert.equal(alive(report.descendantPid), true, 'setsid descendant is outside the group proof')
    // The test owns this escaped PID explicitly; it never claims full-tree cleanup.
    process.kill(report.descendantPid, 'SIGKILL')
    await waitGone(report.descendantPid)
    assert.equal(alive(report.descendantPid), false)
  } finally { cleanup(x.root, [report?.descendantPid]) }
})

test('a bad executable fixture fails as child_exit_failed with zero gateway calls, no record and a gone group', { timeout: 20_000 }, async () => {
  const x = setup('bad')
  const h = hostFixture()
  try {
    const outcome = await runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy })
    assert.equal(outcome.reason, 'child_exit_failed')
    assert.equal(outcome.responsesDelivered, 0)
    assert.equal(outcome.childExitCode, 1)
    assert.equal(outcome.retentionConfirmed, false)
    assert.equal(outcome.cleanupConfirmed, true)
    assert.equal(h.calls(), 0)
    assert.equal(existsSync(privateProcessRecordPath(x.binding, x.policy)), false)
  } finally { cleanup(x.root) }
})

test('malformed and foreign-selector frames reach no gateway, no retention and still clean the owned group', { timeout: 25_000 }, async () => {
  for (const [mode, expected] of [['malformed', 'channel_frame_invalid'], ['selector', 'channel_request_invalid']] as const) {
    const x = setup(mode)
    const h = hostFixture()
    try {
      const outcome = await runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy })
      assert.equal(outcome.reason, expected)
      assert.equal(outcome.responsesDelivered, 0)
      assert.equal(outcome.cleanupConfirmed, true)
      assert.equal(h.calls(), 0); assert.equal(h.retained(), 0)
      assert.equal(existsSync(privateProcessRecordPath(x.binding, x.policy)), false)
    } finally { cleanup(x.root) }
  }
})

test('the same binding cannot start a second owned process while the first owns it', { timeout: 20_000 }, async () => {
  const x = setup('two')
  const h = hostFixture({ blockRetention: true })
  const controller = new AbortController()
  try {
    const first = runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy, signal: controller.signal })
    await waitFor(() => h.started())
    const second = await runPrivateTrial({ binding: x.binding, host: h.host, policy: x.policy })
    assert.equal(second.reason, 'binding_busy')
    controller.abort(); h.release()
    const outcome = await first
    assert.equal(outcome.cleanupConfirmed, true)
  } finally { cleanup(x.root) }
})

test('reaper refuses to kill or unlink a record whose live process identity does not match', { timeout: 10_000 }, async () => {
  const x = setup()
  const recordPath = privateProcessRecordPath(x.binding, x.policy)
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  try {
    await waitFor(() => typeof holder.pid === 'number')
    const pgid = holder.pid!
    writeFileSync(recordPath, JSON.stringify({
      version: 1, bindingTag: trialBindingTag(x.binding), nonceHash: nonceHash(x.binding),
      supervisorPid: holder.pid, pgid, clientPid: null, clientExitCode: null,
      clientScript: x.policy.clientScript, startedAt: Date.now(),
    }), { mode: 0o600 })
    const nearMiss = `${process.execPath} ${supervisorScript}.bak ` +
      `${x.policy.clientScript} ${recordPath} 150 ${trialBindingTag(x.binding)} ${nonceHash(x.binding)}`
    const result = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => pid === holder.pid ? { pid, pgid, state: 'S', command: nearMiss } : null,
    })
    assert.equal(result, 'cleanup_unconfirmed')
    assert.equal(existsSync(recordPath), true)
    assert.equal(alive(pgid), true)
  } finally {
    try { process.kill(holder.pid!, 'SIGKILL') } catch { /* already gone */ }
    await waitGone(holder.pid!).catch(() => undefined)
    cleanup(x.root)
  }
})

test('a live mismatched supervisor quarantines instead of falling through to a shared client identity', { timeout: 10_000 }, async () => {
  const x = setup()
  const recordPath = privateProcessRecordPath(x.binding, x.policy)
  const groupFile = join(x.root, 'group.json')
  const holderScript = `const {spawn}=require('node:child_process');` +
    `const fs=require('node:fs');` +
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `fs.writeFileSync(process.argv[1],JSON.stringify({client:child.pid}));` +
    `setInterval(()=>{},1000)`
  const supervisor = spawn(process.execPath, ['-e', holderScript, groupFile], { detached: true, stdio: 'ignore' })
  try {
    await waitFor(() => typeof supervisor.pid === 'number' && existsSync(groupFile))
    const clientPid = readJson(groupFile).client as number
    const pgid = supervisor.pid!
    writeFileSync(recordPath, JSON.stringify({
      version: 1, bindingTag: trialBindingTag(x.binding), nonceHash: nonceHash(x.binding),
      supervisorPid: supervisor.pid, pgid, clientPid, clientExitCode: null,
      clientScript: x.policy.clientScript, startedAt: Date.now(),
    }), { mode: 0o600 })
    let clientObserved = false
    const result = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => {
        if (pid === supervisor.pid) {
          return { pid, pgid, state: 'S', command:
            `${process.execPath} ${supervisorScript}.bak ` +
            `${x.policy.clientScript} ${recordPath} 150 ${trialBindingTag(x.binding)} ${nonceHash(x.binding)}` }
        }
        if (pid === clientPid) {
          clientObserved = true
          return { pid, pgid, state: 'S',
            command: [process.execPath, launcherScript, x.policy.clientScript].join(' ') }
        }
        return null
      },
    })
    assert.equal(result, 'cleanup_unconfirmed')
    assert.equal(clientObserved, false, 'no client fallback after a live mismatched supervisor')
    assert.equal(existsSync(recordPath), true)
    assert.equal(alive(supervisor.pid!), true)
    assert.equal(alive(clientPid), true)
  } finally {
    try { process.kill(-supervisor.pid!, 'SIGKILL') } catch { /* already gone */ }
    try { process.kill(supervisor.pid!, 'SIGKILL') } catch { /* already gone */ }
    await waitGone(supervisor.pid!).catch(() => undefined)
    cleanup(x.root)
  }
})



test('a v2 live mismatched supervisor quarantines before any client-token fallback', { timeout: 10_000 }, async t => {
  const x = setup()
  const holder = await groupedHolder(t, x.root)
  const token = randomBytes(32).toString('base64url')
  const recordPath = v2Record(x, holder.supervisor.pid!, holder.clientPid, token)
  try {
    let clientObserved = false
    const result = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => {
        if (pid === holder.supervisor.pid) {
          return { pid, pgid: holder.supervisor.pid!, state: 'S',
            command: `${process.execPath} ${supervisorScript}.bak` }
        }
        if (pid === holder.clientPid) clientObserved = true
        return null
      },
    })
    assert.equal(result, 'cleanup_unconfirmed')
    assert.equal(clientObserved, false)
    assert.equal(existsSync(recordPath), true)
    assert.equal(alive(holder.supervisor.pid!), true)
    assert.equal(alive(holder.clientPid), true)
  } finally {
    await holder.cleanup()
    cleanup(x.root)
  }
})

test('v2 unknown supervisor observation preserves the record and never inspects the client', { timeout: 10_000 }, async t => {
  const x = setup()
  const holder = await groupedHolder(t, x.root)
  const token = randomBytes(32).toString('base64url')
  const recordPath = v2Record(x, holder.supervisor.pid!, holder.clientPid, token)
  try {
    let clientObserved = false
    const result = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => {
        if (pid === holder.supervisor.pid) return { status: 'unknown' }
        if (pid === holder.clientPid) clientObserved = true
        return null
      },
    })
    assert.equal(result, 'cleanup_unconfirmed')
    assert.equal(clientObserved, false)
    assert.equal(existsSync(recordPath), true)
    assert.equal(alive(holder.supervisor.pid!), true)
    assert.equal(alive(holder.clientPid), true)
  } finally {
    await holder.cleanup()
    cleanup(x.root)
  }
})

test('v2 observed-zombie supervisor falls through only to the exact recorded client generation', { timeout: 10_000 }, async t => {
  const x = setup()
  const holder = await groupedHolder(t, x.root)
  const token = randomBytes(32).toString('base64url')
  const recordPath = v2Record(x, holder.supervisor.pid!, holder.clientPid, token)
  try {
    const result = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => {
        if (pid === holder.supervisor.pid) {
          return { pid, pgid: holder.supervisor.pid!, state: 'Z',
            command: `${process.execPath} ${supervisorScript}.bak` }
        }
        if (pid === holder.clientPid) {
          return { pid, pgid: holder.supervisor.pid!, state: 'S',
            command: [process.execPath, launcherScript,
              x.policy.clientScript, token].join(' ') }
        }
        return null
      },
    })
    assert.equal(result, 'removed')
    assert.equal(existsSync(recordPath), false)
    await waitGone(holder.supervisor.pid!)
    await waitGone(holder.clientPid)
  } finally {
    await holder.cleanup()
    cleanup(x.root)
  }
})

test('v2 observed-zombie supervisor with a wrong client token quarantines and does not signal', { timeout: 10_000 }, async t => {
  const x = setup()
  const holder = await groupedHolder(t, x.root)
  const token = randomBytes(32).toString('base64url')
  const wrong = randomBytes(32).toString('base64url')
  const recordPath = v2Record(x, holder.supervisor.pid!, holder.clientPid, token)
  try {
    const result = await reapPrivateProcessRecord(x.binding, x.policy, {
      observe: async pid => {
        if (pid === holder.supervisor.pid) {
          return { pid, pgid: holder.supervisor.pid!, state: 'Z', command: 'zombie supervisor' }
        }
        if (pid === holder.clientPid) {
          return { pid, pgid: holder.supervisor.pid!, state: 'S',
            command: [process.execPath, launcherScript,
              x.policy.clientScript, wrong].join(' ') }
        }
        return null
      },
    })
    assert.equal(result, 'cleanup_unconfirmed')
    assert.equal(existsSync(recordPath), true)
    assert.equal(alive(holder.supervisor.pid!), true)
    assert.equal(alive(holder.clientPid), true)
  } finally {
    await holder.cleanup()
    cleanup(x.root)
  }
})

test('documented macOS and Linux live supervisor states permit exact-identity reaper cleanup', { timeout: 30_000 }, async t => {
  const x = setup()
  const liveStates: Array<{ state: string | undefined; label: string }> = [
    { state: undefined, label: 'legacy omitted state' },
    { state: 'S', label: 'macOS/BSD sleeping primary' },
    { state: 'Ss', label: 'macOS session leader' },
    { state: 'SN', label: 'macOS reduced priority (nice)' },
    { state: 'SS', label: 'macOS FIFO page replacement' },
    { state: 'S<s', label: 'macOS raised priority session leader' },
    { state: 'RWNA', label: 'macOS documented example with W/N/A' },
    { state: 'R+', label: 'Linux foreground process group' },
    { state: 'Ssl', label: 'Linux session leader and multithreaded' },
    { state: 'D', label: 'Linux uninterruptible sleep' },
    { state: 't', label: 'Linux debugger stop' },
    { state: 'U', label: 'macOS uninterruptible wait' },
  ]
  try {
    for (const [index, { state, label }] of liveStates.entries()) {
      const holder = await groupedHolder(t, x.root, `-live-${index}`)
      const recordPath = v1Record(x, holder.supervisor.pid!, holder.clientPid)
      try {
        assert.equal(alive(holder.supervisor.pid!), true, label)
        assert.equal(alive(holder.clientPid), true, label)
        const result = await reapPrivateProcessRecord(x.binding, x.policy, {
          observe: async pid => pid === holder.supervisor.pid
            ? { pid, pgid: holder.supervisor.pid!, state, command: supervisorCommand(x, recordPath) }
            : null,
        })
        assert.equal(result, 'removed', label)
        assert.equal(existsSync(recordPath), false, label)
        await waitGone(holder.supervisor.pid!)
        await waitGone(holder.clientPid)
      } finally {
        await holder.cleanup()
      }
    }
  } finally { cleanup(x.root) }
})

test('zombie, dead/obsolete and malformed supervisor states quarantine without signal or unlink', { timeout: 15_000 }, async t => {
  const x = setup()
  const holder = await groupedHolder(t, x.root)
  const recordPath = privateProcessRecordPath(x.binding, x.policy)
  const negativeStates = [
    ['Z', 'zombie'], ['Zs', 'zombie with modifier'], ['Z9', 'zombie with malformed modifier'],
    ['X', 'Linux dead primary'], ['W', 'obsolete Linux paging primary'], ['z', 'lowercase zombie primary'],
    ['Q', 'unknown primary'], ['S9', 'unknown modifier'], ['Sq', 'unknown letter modifier'],
    ['S++', 'duplicate modifier'], ['SSS', 'duplicate FIFO modifier'],
    ['??', 'punctuation'], ['S garbage', 'whitespace'], ['', 'empty'],
  ] as const
  try {
    assert.equal(alive(holder.supervisor.pid!), true)
    assert.equal(alive(holder.clientPid), true)
    for (const [state, label] of negativeStates) {
      v1Record(x, holder.supervisor.pid!, holder.clientPid)
      const result = await reapPrivateProcessRecord(x.binding, x.policy, {
        observe: async pid => pid === holder.supervisor.pid
          ? { pid, pgid: holder.supervisor.pid!, state, command: supervisorCommand(x, recordPath) }
          : null,
      })
      assert.equal(result, 'cleanup_unconfirmed', label)
      assert.equal(existsSync(recordPath), true, label)
      assert.equal(alive(holder.supervisor.pid!), true, label)
      assert.equal(alive(holder.clientPid), true, label)
    }
  } finally {
    await holder.cleanup()
    cleanup(x.root)
  }
})

test('a v1 record is unlinked without a signal only when its recorded group is actually ESRCH', { timeout: 10_000 }, async t => {
  const x = setup()
  const holder = await groupedHolder(t, x.root)
  const recordPath = privateProcessRecordPath(x.binding, x.policy)
  try {
    const supervisorPid = holder.supervisor.pid!
    const clientPid = holder.clientPid
    process.kill(-supervisorPid, 'SIGKILL')
    await waitGone(supervisorPid)
    await waitGone(clientPid)
    writeFileSync(recordPath, JSON.stringify({
      version: 1, bindingTag: trialBindingTag(x.binding), nonceHash: nonceHash(x.binding),
      supervisorPid, pgid: supervisorPid, clientPid, clientExitCode: null,
      clientScript: x.policy.clientScript, startedAt: Date.now(),
    }), { mode: 0o600 })
    const result = await reapPrivateProcessRecord(x.binding, x.policy, { observe: async () => null })
    assert.equal(result, 'removed')
    assert.equal(existsSync(recordPath), false)
  } finally {
    await holder.cleanup()
    cleanup(x.root)
  }
})

test('process policy rejects a symlinked or permissive record directory before spawn', { timeout: 10_000 }, async () => {
  const x = setup()
  const link = join(x.root, 'records-link')
  try {
    symlinkSync(x.recordDirectory, link)
    const outcome = await runPrivateTrial({
      binding: x.binding, host: hostFixture().host,
      policy: { ...x.policy, recordDirectory: link },
    })
    assert.equal(outcome.reason, 'process_policy_invalid')
    chmodSync(x.recordDirectory, 0o755)
    const permissive = await runPrivateTrial({ binding: x.binding, host: hostFixture().host, policy: x.policy })
    assert.equal(permissive.reason, 'process_policy_invalid')
    chmodSync(x.recordDirectory, 0o700)
    const unsafeEnv = await runPrivateTrial({ binding: x.binding, host: hostFixture().host,
      policy: { ...x.policy, env: { ...x.policy.env, NODE_OPTIONS: '--inspect' } } })
    assert.equal(unsafeEnv.reason, 'process_policy_invalid')
  } finally { cleanup(x.root) }
})
