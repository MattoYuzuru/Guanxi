import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fsp, { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { fixture, owner, nodeId } from './helpers.ts'
import { ExternalAgents } from '../../src/external-agents/service.ts'
import { ExternalStore } from '../../src/external-agents/store.ts'
import { admissionPolicyDigest } from '../../src/external-agents/admission.ts'
import { AgentProcess } from '../../src/external-agents/process.ts'
import { MIGRATIONS, openDb } from '../../src/store/db.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'
import type { AgentInstallation, ExternalPolicy } from '../../src/external-agents/types.ts'

const scrubber = { isReady: () => true, scrub: <T>(value: T) => value } as unknown as EgressScrubber
const workerPath = fileURLToPath(new URL('./admission-worker.ts', import.meta.url))

async function until(check: () => Promise<boolean> | boolean, message = 'Fixture did not reach the expected lifecycle point', ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

const gone = (pid: number) => { try { process.kill(pid, 0); return false } catch { return true } }

function peer(f: Awaited<ReturnType<typeof fixture>>, policy: Partial<ExternalPolicy> = {}) {
  const store = new ExternalStore(join(f.dir, 'external-agents.sqlite'), f.kernel.scrubber)
  const agents = new ExternalAgents(f.connections, f.kernel.sessionLog!, f.kernel.scrubber, f.dir, store, {
    nodeId: f.installations[0]!.nodeId, installations: f.installations, ...policy,
  })
  let closed = false
  return { store, agents, close: async () => { if (closed) return; closed = true; await agents.close(); store.close() } }
}

type Settled<T> = { status: 'ok'; value: T } | { status: 'error'; error: { code?: string } } | { status: 'timeout' }
async function settled<T>(promise: Promise<T>, ms = 2000): Promise<Settled<T>> {
  return Promise.race([promise.then(value => ({ status: 'ok' as const, value }), error => ({ status: 'error' as const, error })),
    new Promise<{ status: 'timeout' }>(resolve => setTimeout(() => resolve({ status: 'timeout' as const }), ms))])
}

interface AdmissionRow {
  holder_id: string
  instance_id: string
  owner: string
  adapter: string
  billing_account: string
  kind: string
  policy_digest: string
  created_at: string
  state: string
  cleanup_reason: string | null
}
function rowsAt(path: string): AdmissionRow[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT holder_id,instance_id,owner,adapter,billing_account,kind,policy_digest,created_at,state,cleanup_reason FROM k5_admission ORDER BY created_at,holder_id').all() as unknown as AdmissionRow[] } finally { db.close() }
}
function sqlAt<T>(path: string, sql: string): T[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all() as unknown as T[] } finally { db.close() }
}
function execAt(path: string, sql: string) {
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA busy_timeout=5000'); db.exec(sql) } finally { db.close() }
}
function waitRows(path: string, count: number) {
  return until(() => { try { return rowsAt(path).length === count } catch { return false } }, `expected ${count} admission rows`)
}

function installFor(connectionId: string, executable: string, overrides: Partial<AgentInstallation> = {}): AgentInstallation {
  return { adapter: 'codex', connectionId, ownerAccountId: owner, nodeId, billingAccount: 'worker-account',
    executable, version: '0.163.0', concurrency: 1, ...overrides }
}

function workerConfig(config: Record<string, unknown>, path: string) {
  return writeFile(path, JSON.stringify(config)).then(() => path)
}

function startWorker(configPath: string): ChildProcess {
  return spawn(process.execPath, [workerPath, configPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
}

function waitMessage(child: ChildProcess, types: readonly string[], ms = 20_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for worker message ${types.join('/')}`)) }, ms)
    const onMessage = (message: Record<string, any>) => { if (types.includes(message.type)) { cleanup(); resolve(message) } }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => { cleanup(); reject(new Error(`Worker exited ${code ?? 'null'}/${signal ?? 'null'} before ${types.join('/')}`)) }
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage); child.on('exit', onExit)
  })
}
function waitExit(child: ChildProcess, ms = 10_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => reject(new Error('Timed out waiting for worker exit')), ms)
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
}
async function killGroup(pid: number | null | undefined) {
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  await until(() => gone(pid), 'process group did not disappear', 3000).catch(() => undefined)
}
async function prepareWorkerFixture(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  const dir = join(f.dir, `worker-${label}`)
  await mkdir(dir, { recursive: true })
  const executable = join(dir, 'fixture-agent.mjs')
  await writeFile(executable, `#!${process.execPath}\n` + await readFile(new URL('./fixture-process.mjs', import.meta.url), 'utf8'))
  await chmod(executable, 0o700)
  await writeFile(join(dir, 'scenario.json'), JSON.stringify({ tape: f.tapes.get('codex'), scenario: 'hang', secret: f.secret }))
  return { dir, executable, tracePath: join(dir, 'trace.json'), adapterPidPath: join(dir, 'adapter.pid') }
}

test('two K5 services sharing one sidecar cannot exceed the same account ceiling', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f)
  t.after(second.close)
  await f.scenario('codex', { scenario: 'hang' })
  const firstAbort = new AbortController()
  const first = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: firstAbort.signal })
  const firstSettled = first.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  const secondAbort = new AbortController()
  const outcome = await settled(second.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
    role: 'lead', prompt: 'hello', signal: secondAbort.signal }))
  secondAbort.abort(); firstAbort.abort(); await firstSettled; await second.close()
  assert.notEqual(outcome.status, 'timeout', 'the second service must settle instead of starting a child')
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.status === 'error' ? outcome.error.code : '', 'account_busy')
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('a login held by one service is exclusive with every run and login in the same group across services', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f)
  t.after(second.close)
  await f.scenario('codex', { scenario: 'login-hang' })
  let shown!: () => void
  const urlShown = new Promise<void>(resolve => { shown = resolve })
  const abort = new AbortController()
  const login = f.service().signInWithChatGPT(owner, owner, binding.connectionId, () => shown(), abort.signal)
  const loginSettled = login.then(() => 'succeeded', error => error.code)
  await urlShown
  const run = await settled(second.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
    role: 'lead', prompt: 'hello', signal: AbortSignal.timeout(2000) }))
  const otherLogin = await settled(second.agents.signInWithChatGPT(owner, owner, binding.connectionId, () => undefined,
    AbortSignal.timeout(2000)))
  abort.abort(); await loginSettled; await second.close()
  assert.notEqual(run.status, 'timeout')
  assert.equal(run.status, 'error')
  assert.equal(run.status === 'error' ? run.error.code : '', 'account_busy')
  assert.notEqual(otherLogin.status, 'timeout')
  assert.equal(otherLogin.status, 'error')
  assert.equal(otherLogin.status === 'error' ? otherLogin.error.code : '', 'account_busy')
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('a run held by one service blocks login', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.scenario('codex', { scenario: 'hang' })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
  const runSettled = run.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  await assert.rejects(f.service().signInWithChatGPT(owner, owner, binding.connectionId, () => undefined, AbortSignal.timeout(1000)), /account_busy/)
  abort.abort(); await runSettled
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('ceilings 2 and 3 admit exactly that many same-group runs in one service and refuse the next', async t => {
  for (const ceiling of [2, 3] as const) {
    const f = await fixture(t)
    const install = f.installations[0]!
    await f.reload({ installations: [{ ...install, concurrency: ceiling }] })
    const binding = f.bindings[0]!
    f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
    await f.scenario('codex', { scenario: 'hang' })
    const aborts = Array.from({ length: ceiling }, () => new AbortController())
    const runs = aborts.map(signal => f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
      role: 'lead', prompt: 'hello', signal: signal.signal }).then(() => undefined, () => undefined))
    assert.equal(f.service().limits(owner, binding.connectionId).durableLocalOccupancy.total, ceiling)
    await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'extra' }), /account_busy/)
    assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, ceiling)
    for (const abort of aborts) abort.abort()
    await Promise.all(runs)
    assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  }
})

test('connection IDs do not create a second slot while a different billing account is isolated', async t => {
  const f = await fixture(t)
  const first = f.installations[0]!
  const secondConnection = f.connections.create(owner, { name: 'codex second', kind: 'agent', provider: 'codex', auth: 'cli_login' })
  const thirdConnection = f.connections.create(owner, { name: 'codex other account', kind: 'agent', provider: 'codex', auth: 'cli_login' })
  const second = { ...first, connectionId: secondConnection.id }
  const third = { ...first, connectionId: thirdConnection.id, billingAccount: 'another-account' }
  await f.reload({ installations: [first, second, third] })
  await f.scenario('codex', { scenario: 'hang' })
  const firstAbort = new AbortController()
  const firstRun = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'one',
    sessionRoles: { lead: { backend: 'codex', connectionId: first.connectionId, model: 'model-fixture', params: {} } }, signal: firstAbort.signal })
  const firstSettled = firstRun.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'two',
    sessionRoles: { lead: { backend: 'codex', connectionId: second.connectionId, model: 'model-fixture', params: {} } } }), /account_busy/)
  const otherAbort = new AbortController()
  const other = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'other',
    sessionRoles: { lead: { backend: 'codex', connectionId: third.connectionId, model: 'model-fixture', params: {} } }, signal: otherAbort.signal })
  const otherSettled = other.then(() => undefined, () => undefined)
  assert.equal(f.service().limits(owner, third.connectionId).durableLocalOccupancy.total, 1)
  firstAbort.abort(); otherAbort.abort(); await firstSettled; await otherSettled
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('different adapters for the same owner are isolated groups', async t => {
  const f = await fixture(t, ['codex', 'copilot'])
  const codex = f.installations.find(i => i.adapter === 'codex')!
  const copilot = f.installations.find(i => i.adapter === 'copilot')!
  await f.scenario('codex', { scenario: 'hang' })
  await f.scenario('copilot', { scenario: 'hang' })
  const codexAbort = new AbortController()
  const copilotAbort = new AbortController()
  const codexRun = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'codex',
    sessionRoles: { lead: { backend: 'codex', connectionId: codex.connectionId, model: 'model-fixture', params: {} } }, signal: codexAbort.signal })
  const copilotRun = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'copilot',
    sessionRoles: { lead: { backend: 'copilot', connectionId: copilot.connectionId, model: 'model-fixture', params: {} } }, signal: copilotAbort.signal })
  const both = Promise.all([codexRun.then(() => undefined, () => undefined), copilotRun.then(() => undefined, () => undefined)])
  await until(() => rowsAt(join(f.dir, 'external-agents.sqlite')).length === 2)
  assert.equal(f.service().limits(owner, codex.connectionId).durableLocalOccupancy.total, 1)
  assert.equal(f.service().limits(owner, copilot.connectionId).durableLocalOccupancy.total, 1)
  codexAbort.abort(); copilotAbort.abort(); await both
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('a different configured ceiling for an occupied group is refused as a policy conflict', async t => {
  const f = await fixture(t)
  const install = f.installations[0]!
  await f.reload({ installations: [{ ...install, concurrency: 3 }] })
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f, { installations: [{ ...install, concurrency: 1 }] })
  t.after(second.close)
  await f.scenario('codex', { scenario: 'hang' })
  const firstAbort = new AbortController()
  const first = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: firstAbort.signal })
  const firstSettled = first.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  const secondAbort = new AbortController()
  const outcome = await settled(second.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p',
    role: 'lead', prompt: 'hello', signal: secondAbort.signal }))
  secondAbort.abort(); firstAbort.abort(); await firstSettled; await second.close()
  assert.notEqual(outcome.status, 'timeout')
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.status === 'error' ? outcome.error.code : '', 'account_policy_conflict')
  // Once the group is genuinely quiescent, the new digest is accepted with no tombstone.
  const third = peer(f, { installations: [{ ...install, concurrency: 1 }] })
  t.after(third.close)
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.scenario('codex', {})
  const result = await third.agents.run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  assert.match(result.text, /fixture completed/)
  await third.close()
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('effective_bare stays unknown after a successful logged-in Claude fixture', async t => {
  const f = await fixture(t, ['claude-code'])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  const facts = f.connections.store.get(owner, binding.connectionId).facts
  assert.deepEqual(facts.effective_bare, { value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' })
  assert.equal(facts.bare?.value, null)
  assert.match(facts.bare?.source ?? '', /:node_launch_policy$/)
})

test('explicit bare refuses before spawn while false and omitted stay unknown observations', async t => {
  const f = await fixture(t, ['claude-code'])
  const install = f.installations[0]!
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const run = () => f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  await f.reload({ installations: [{ ...install, claudeBare: true }] })
  await assert.rejects(run(), /bare_subscription_unavailable/)
  let facts = f.connections.store.get(owner, binding.connectionId).facts
  assert.equal(facts.bare?.value, true)
  assert.deepEqual(facts.effective_bare, { value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' })
  await assert.rejects(readFile(join(f.dir, 'claude-code', 'trace.json')), { code: 'ENOENT' })
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  await f.reload({ installations: [{ ...install, claudeBare: false }] })
  await f.scenario('claude-code', {})
  await run()
  facts = f.connections.store.get(owner, binding.connectionId).facts
  assert.equal(facts.bare?.value, false)
  assert.deepEqual(facts.effective_bare, { value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' })
  assert.equal(facts.subscription_login?.value, true)
})

test('K3 payment refusal creates zero rows and zero launches', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const result = await settled(f.service().run({ ownerAccountId: owner, actorAccountId: 'editor', projectId: 'p', role: 'lead', prompt: 'hello' }))
  assert.equal(result.status, 'error')
  assert.match(String(result.status === 'error' ? result.error : ''), /Connection cannot pay/)
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  await assert.rejects(readFile(join(f.dir, 'codex', 'trace.json')), { code: 'ENOENT' })
})

test('abort during a delayed filesystem preflight releases the holder and starts no child', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const { syncBuiltinESMExports } = await import('node:module')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = fsp.realpath.bind(fsp)
  const mock = t.mock.method(fsp, 'realpath', async (...args: Parameters<typeof fsp.realpath>) => {
    if (String(args[0]).includes('fixture-agent.mjs')) await gate
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
    .then(() => 'ok', error => error.code)
  await waitRows(join(f.dir, 'external-agents.sqlite'), 1)
  abort.abort()
  release()
  assert.equal(await run, 'cancelled')
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  await assert.rejects(readFile(join(f.dir, 'codex', 'trace.json')), { code: 'ENOENT' })
})

test('abort after the auth-status preflight cleans the probe group and never starts the primary child', async t => {
  const f = await fixture(t, ['claude-code'])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.scenario('claude-code', { scenario: 'auth-descendant' })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
    .then(() => 'ok', error => error.code)
  await until(async () => { try { return (await readFile(join(f.dir, 'claude-code', 'auth-ready'), 'utf8')) === 'ready' } catch { return false } })
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 1)
  abort.abort()
  assert.equal(await run, 'cancelled')
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  await assert.rejects(readFile(join(f.dir, 'claude-code', 'trace.json')), { code: 'ENOENT' })
})

test('a deferred close keeps the durable row held until the acknowledgement, then admits exactly once', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const original = AgentProcess.prototype.close
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const mock = t.mock.method(AgentProcess.prototype, 'close', async function (this: AgentProcess) {
    await gate
    return original.call(this)
  })
  await f.scenario('codex', { scenario: 'hang' })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
  let runSettled = false
  const settledRun = run.then(() => { runSettled = true }, () => { runSettled = true })
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite'))[0]?.state, 'held')
  abort.abort()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(runSettled, false)
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite'))[0]?.state, 'held')
  release()
  await settledRun
  mock.mock.restore()
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  await f.scenario('codex', {})
  const result = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'again' })
  assert.match(result.text, /fixture completed/)
  assert.equal((await f.trace('codex')).filter(frame => frame.method === 'turn/start').length, 1)
})

test('unconfirmed cleanup retains occupancy, surfaces cleanup_unconfirmed and starts no replacement', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  const install = f.installations[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const original = AgentProcess.prototype.close
  const mock = t.mock.method(AgentProcess.prototype, 'close', async function (this: AgentProcess) {
    await original.call(this)
    return { confirmed: false as const, reason: 'group_timeout' as const }
  })
  await f.scenario('codex', { scenario: 'hang' })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
  const outcome = run.then(() => 'ok', error => error.code)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  abort.abort()
  assert.equal(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('stalled'), 5000))]), 'cleanup_unconfirmed')
  mock.mock.restore()
  const rows = rowsAt(join(f.dir, 'external-agents.sqlite'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.state, 'cleanup_unconfirmed')
  assert.equal(rows[0]!.cleanup_reason, 'group_timeout')
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  assert.deepEqual(f.service().limits(owner, binding.connectionId).durableLocalOccupancy, { held: 0, cleanupUnconfirmed: 1, total: 1 })
  await f.reload()
  await f.scenario('codex', {})
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'replacement' }), /account_busy/)
  await assert.rejects(readFile(join(f.dir, 'codex', 'trace.json')), { code: 'ENOENT' })
  await f.reload({ installations: [{ ...install, concurrency: 2 }] })
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'new policy' }), /account_policy_conflict/)
})

test('a same-group descendant is ESRCH before the exact row is released', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.scenario('codex', { scenario: 'orphan' })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
  const runSettled = run.then(() => 'ok', error => error.code)
  const pidFile = join(f.dir, 'codex', 'orphan.pid')
  await until(async () => {
    try {
      const trace = await f.trace('codex')
      const pid = await readFile(pidFile, 'utf8')
      return trace.some(frame => frame.method === 'turn/start') && pid.length > 0
    } catch { return false }
  })
  const pid = Number(await readFile(pidFile, 'utf8'))
  const original = ExternalStore.prototype.release
  let descendantGoneAtRelease: boolean | undefined
  const mock = t.mock.method(ExternalStore.prototype, 'release', function (this: ExternalStore, holder: { holderId: string; instanceId: string }) {
    descendantGoneAtRelease = gone(pid)
    return original.call(this, holder)
  })
  try {
    abort.abort()
    assert.equal(await Promise.race([runSettled, new Promise(resolve => setTimeout(() => resolve('stalled'), 10_000))]), 'cancelled')
  } finally { mock.mock.restore() }
  assert.equal(descendantGoneAtRelease, true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
})

test('an exact release cannot delete another holder and duplicate exact release is idempotent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-exact-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'external-agents.sqlite')
  const store = new ExternalStore(path, scrubber)
  t.after(() => { try { store.close() } catch { /* already closed */ } })
  const install = installFor(randomUUID(), '/bin/true')
  const request = { instanceId: randomUUID(), owner, adapter: install.adapter, billingAccount: install.billingAccount,
    kind: 'run' as const, policyDigest: admissionPolicyDigest(install), ceiling: 1 }
  const first = store.acquire(request)
  assert.equal(store.release(first.holder).released, true)
  const second = store.acquire(request)
  assert.equal(store.release({ holderId: first.holder.holderId, instanceId: first.holder.instanceId }).released, false)
  assert.equal(store.release({ holderId: second.holder.holderId, instanceId: 'other-instance' }).released, false)
  assert.equal(store.occupancy(owner, 'codex', install.billingAccount).total, 1)
  assert.equal(store.release(second.holder).released, true)
  assert.equal(store.occupancy(owner, 'codex', install.billingAccount).total, 0)
  const otherOwnerInstall = { ...install, ownerAccountId: 'other-owner' }
  const otherOwner = store.acquire({ ...request, instanceId: randomUUID(), owner: 'other-owner', policyDigest: admissionPolicyDigest(otherOwnerInstall) })
  assert.equal(store.occupancy('other-owner', 'codex', install.billingAccount).total, 1)
  assert.equal(store.release(otherOwner.holder).released, true)
})

test('release and marking SQL faults surface admission_release_failed and retain the row', async t => {
  const releaseFault = await fixture(t)
  const releaseBinding = releaseFault.bindings[0]!
  releaseFault.service().setProjectRoles(owner, owner, 'p', { lead: releaseBinding })
  const releasePath = join(releaseFault.dir, 'external-agents.sqlite')
  execAt(releasePath, "CREATE TRIGGER fixture_abort_delete BEFORE DELETE ON k5_admission BEGIN SELECT RAISE(ABORT,'fixture'); END;")
  const releaseOutcome = await settled(releaseFault.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }))
  assert.equal(releaseOutcome.status, 'error')
  assert.equal(releaseOutcome.status === 'error' ? releaseOutcome.error.code : '', 'admission_release_failed')
  let rows = rowsAt(releasePath)
  assert.equal(rows.length, 1); assert.equal(rows[0]!.state, 'held')
  execAt(releasePath, 'DROP TRIGGER fixture_abort_delete;')
  const direct = new ExternalStore(releasePath, releaseFault.kernel.scrubber)
  assert.equal(direct.release({ holderId: rows[0]!.holder_id, instanceId: rows[0]!.instance_id }).released, true)
  direct.close()

  const markFault = await fixture(t)
  const markBinding = markFault.bindings[0]!
  markFault.service().setProjectRoles(owner, owner, 'p', { lead: markBinding })
  const markPath = join(markFault.dir, 'external-agents.sqlite')
  const original = AgentProcess.prototype.close
  const mock = t.mock.method(AgentProcess.prototype, 'close', async function (this: AgentProcess) {
    await original.call(this)
    return { confirmed: false as const, reason: 'group_timeout' as const }
  })
  execAt(markPath, "CREATE TRIGGER fixture_abort_update BEFORE UPDATE ON k5_admission BEGIN SELECT RAISE(ABORT,'fixture'); END;")
  await markFault.scenario('codex', { scenario: 'hang' })
  const abort = new AbortController()
  const markRun = markFault.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
  const markSettled = markRun.then(() => 'ok', error => error.code)
  await until(async () => { try { return (await markFault.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  abort.abort()
  const markCode = await Promise.race([markSettled, new Promise(resolve => setTimeout(() => resolve('stalled'), 5000))])
  assert.equal(markCode, 'admission_release_failed')
  mock.mock.restore()
  rows = rowsAt(markPath)
  assert.equal(rows.length, 1); assert.equal(rows[0]!.state, 'held')
  execAt(markPath, 'DROP TRIGGER fixture_abort_update;')
  const markDirect = new ExternalStore(markPath, markFault.kernel.scrubber)
  assert.equal(markDirect.markCleanupUnconfirmed({ holderId: rows[0]!.holder_id, instanceId: rows[0]!.instance_id }, 'group_timeout').marked, true)
  markDirect.close()
})

test('a closed database surfaces release failure and the on-disk row survives reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-closed-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'external-agents.sqlite')
  const store = new ExternalStore(path, scrubber)
  const install = installFor(randomUUID(), '/bin/true')
  const grant = store.acquire({ instanceId: randomUUID(), owner, adapter: install.adapter, billingAccount: install.billingAccount,
    kind: 'run', policyDigest: admissionPolicyDigest(install), ceiling: 1 })
  store.close()
  assert.throws(() => store.release(grant.holder), /admission_release_failed/)
  const reopened = new ExternalStore(path, scrubber)
  assert.equal(reopened.occupancy(owner, 'codex', install.billingAccount).total, 1)
  assert.equal(reopened.release(grant.holder).released, true)
  reopened.close()
})

test('v1 sidecar upgrade appends v2 once, preserves every v1 row, user_version and private permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-v1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'external-agents.sqlite')
  await chmod(dir, 0o700)
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE k5_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE project_roles(owner TEXT NOT NULL, project TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,project));
    CREATE TABLE editor_grants(owner TEXT NOT NULL, connection TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(owner,connection,actor));
    CREATE TABLE quota_reports(owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, node TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,account,adapter,node));
    CREATE TABLE concurrency(owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, successful INTEGER, rejected INTEGER, observed_at TEXT NOT NULL, PRIMARY KEY(owner,account,adapter));
    INSERT INTO k5_migrations VALUES(1);
    INSERT INTO project_roles VALUES('v1-owner','v1-project','{}');
    INSERT INTO editor_grants VALUES('v1-owner','v1-connection','v1-editor');
    INSERT INTO quota_reports VALUES('v1-owner','v1-account','codex','v1-node','{}');
    INSERT INTO concurrency VALUES('v1-owner','v1-account','codex',2,3,'2026-10-20T00:00:00.000Z');
    PRAGMA user_version = 7;`)
  db.close()
  await chmod(path, 0o600)
  const store = new ExternalStore(path, scrubber)
  const version = sqlAt<{ user_version: number }>(path, 'PRAGMA user_version')[0]!.user_version
  assert.equal(version, 7)
  assert.deepEqual(sqlAt<{ version: number }>(path, 'SELECT version FROM k5_migrations ORDER BY version').map(row => row.version), [1, 2, 3])
  assert.equal(sqlAt<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM project_roles')[0]!.n, 1)
  assert.equal(sqlAt<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM editor_grants')[0]!.n, 1)
  assert.equal(sqlAt<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM quota_reports')[0]!.n, 1)
  assert.equal(sqlAt<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM concurrency')[0]!.n, 1)
  assert.equal(sqlAt<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM k5_admission')[0]!.n, 0)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  for (const file of [path, `${path}-wal`, `${path}-shm`]) assert.equal((await stat(file)).mode & 0o777, 0o600)
  store.close()
  const reopened = new ExternalStore(path, scrubber)
  assert.deepEqual(sqlAt<{ version: number }>(path, 'SELECT version FROM k5_migrations ORDER BY version').map(row => row.version), [1, 2, 3])
  reopened.close()
})

test('a fresh sidecar creates v1 and v2 atomically without consuming the main database user_version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-global-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const mainPath = join(dir, 'node.sqlite')
  const main = openDb(mainPath)
  const before = Number(sqlAt<{ user_version: number }>(mainPath, 'PRAGMA user_version')[0]!.user_version)
  const migrationCount = MIGRATIONS.length
  const sidecar = new ExternalStore(join(dir, 'external-agents.sqlite'), scrubber)
  assert.equal(Number(sqlAt<{ user_version: number }>(mainPath, 'PRAGMA user_version')[0]!.user_version), before)
  assert.equal(MIGRATIONS.length, migrationCount)
  assert.deepEqual(sqlAt<{ version: number }>(join(dir, 'external-agents.sqlite'), 'SELECT version FROM k5_migrations ORDER BY version').map(row => row.version), [1, 2, 3])
  assert.equal(Number(sqlAt<{ user_version: number }>(join(dir, 'external-agents.sqlite'), 'PRAGMA user_version')[0]!.user_version), 0)
  sidecar.close(); main.close()
})

test('two workers migrate a v1 sidecar and claim one slot without losing occupancy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-race-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'external-agents.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE k5_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO k5_migrations VALUES(1);
    CREATE TABLE project_roles(owner TEXT NOT NULL, project TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,project));
    CREATE TABLE editor_grants(owner TEXT NOT NULL, connection TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(owner,connection,actor));
    CREATE TABLE quota_reports(owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, node TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,account,adapter,node));
    CREATE TABLE concurrency(owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, successful INTEGER, rejected INTEGER, observed_at TEXT NOT NULL, PRIMARY KEY(owner,account,adapter));`)
  db.close()
  const install = installFor(randomUUID(), '/bin/true')
  const workers: ChildProcess[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const configPath = join(dir, `worker-${index}.json`)
      await workerConfig({ mode: 'migrate-claim', dbPath: path, rootDir: dir, owner, adapter: install.adapter,
        billingAccount: install.billingAccount, connectionId: randomUUID(), nodeId, executable: '/bin/true', version: install.version,
        concurrency: 1, instanceId: randomUUID(), policyDigest: admissionPolicyDigest(install) }, configPath)
      workers.push(startWorker(configPath))
    }
    const messages = await Promise.all(workers.map(child => waitMessage(child, ['held', 'busy', 'failed'])))
    assert.equal(messages.filter(message => message.type === 'held').length, 1)
    assert.equal(messages.filter(message => message.type === 'busy').length, 1)
    const winner = workers[messages.findIndex(message => message.type === 'held')]!
    winner.send('release')
    await waitMessage(winner, ['released'])
    await Promise.all(workers.map(child => waitExit(child)))
    assert.deepEqual(sqlAt<{ version: number }>(path, 'SELECT version FROM k5_migrations ORDER BY version').map(row => row.version), [1, 2, 3])
    assert.equal(rowsAt(path).length, 0)
  } finally {
    for (const child of workers) { try { child.kill('SIGKILL') } catch { /* already exited */ } }
  }
})

test('actual worker processes sharing one sidecar obey ceilings 1, 2 and 3', async t => {
  for (const ceiling of [1, 2, 3]) {
    const f = await fixture(t, ['codex'])
    const workers: { child: ChildProcess; fixture: Awaited<ReturnType<typeof prepareWorkerFixture>> }[] = []
    try {
      for (let index = 0; index <= ceiling; index++) {
        const prepared = await prepareWorkerFixture(f, `${ceiling}-${index}`)
        const connectionId = randomUUID()
        const install = installFor(connectionId, prepared.executable, { billingAccount: 'worker-account', concurrency: ceiling })
        const configPath = join(prepared.dir, 'worker.json')
        await workerConfig({ mode: 'service', dbPath: join(f.dir, 'external-agents.sqlite'), rootDir: join(f.dir, 'worker-root'),
          owner, adapter: 'codex', billingAccount: install.billingAccount, connectionId, nodeId, executable: prepared.executable,
          version: install.version, concurrency: ceiling, tracePath: prepared.tracePath, adapterPidPath: prepared.adapterPidPath,
          instanceId: randomUUID(), policyDigest: admissionPolicyDigest(install) }, configPath)
        const child = startWorker(configPath)
        workers.push({ child, fixture: prepared })
      }
      const messages = await Promise.all(workers.map(worker => waitMessage(worker.child, ['admitted', 'busy', 'failed'])))
      assert.equal(messages.filter(message => message.type === 'admitted').length, ceiling, `ceiling ${ceiling} admitted workers`)
      assert.equal(messages.filter(message => message.type === 'busy').length, 1, `ceiling ${ceiling} refused workers`)
      assert.equal(messages.filter(message => message.type === 'failed').length, 0, `ceiling ${ceiling} worker failures`)
      for (const [index, message] of messages.entries()) {
        const worker = workers[index]!
        if (message.type === 'admitted') {
          assert.ok(Number(message.adapterPid) > 0)
          worker.child.send('release')
          await waitMessage(worker.child, ['released'])
        } else {
          await assert.rejects(stat(worker.fixture.adapterPidPath), { code: 'ENOENT' })
          await assert.rejects(stat(worker.fixture.tracePath), { code: 'ENOENT' })
        }
        await waitExit(worker.child)
      }
      assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
    } finally {
      for (const worker of workers) {
        try { worker.child.kill('SIGKILL') } catch { /* already exited */ }
        try { await killGroup(Number(await readFile(worker.fixture.adapterPidPath, 'utf8'))) } catch { /* never spawned */ }
      }
    }
  }
})

test('a crash-retained holder blocks its own service, and a restart reconciles it only because its owner and group are proven gone', async t => {
  const f = await fixture(t)
  const install = f.installations[0]!
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await f.scenario('codex', { scenario: 'hang' })
  const prepared = await prepareWorkerFixture(f, 'crash')
  const configPath = join(prepared.dir, 'worker.json')
  await workerConfig({ mode: 'service', dbPath: join(f.dir, 'external-agents.sqlite'), rootDir: f.dir, owner,
    adapter: 'codex', billingAccount: install.billingAccount, connectionId: install.connectionId, nodeId,
    executable: prepared.executable, version: install.version, concurrency: 1, tracePath: prepared.tracePath,
    adapterPidPath: prepared.adapterPidPath, instanceId: randomUUID(), policyDigest: admissionPolicyDigest(install) }, configPath)
  const child = startWorker(configPath)
  try {
    const admitted = await waitMessage(child, ['admitted', 'busy', 'failed'])
    assert.equal(admitted.type, 'admitted')
    const adapterPid = Number(admitted.adapterPid)
    child.kill('SIGKILL')
    await waitExit(child)
    await killGroup(adapterPid)
    const path = join(f.dir, 'external-agents.sqlite')
    assert.equal(rowsAt(path).length, 1)
    assert.equal(rowsAt(path)[0]!.state, 'held')
    execAt(path, "UPDATE k5_admission SET created_at='2025-01-01T00:00:00.000Z'")
    // The service that was already running never sweeps: there is no TTL and no age predicate.
    const first = await settled(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'resume?' }))
    assert.equal(first.status, 'error')
    assert.equal(first.status === 'error' ? first.error.code : '', 'account_busy')
    assert.equal(rowsAt(path)[0]!.created_at, '2025-01-01T00:00:00.000Z')
    // A restarted service finds the owner process dead and the recorded group empty: the holder is released and one child is admitted.
    await f.reload()
    const abort = new AbortController()
    const running = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'resume?', signal: abort.signal })
    const second = await settled(running)
    assert.equal(second.status, 'timeout', 'admitted and running (the fixture hangs), not refused with account_busy')
    assert.equal(rowsAt(path).length, 1, 'exactly the new holder')
    abort.abort()
    assert.equal((await settled(running, 8000)).status, 'error')
    assert.equal(rowsAt(path).length, 0)
    await f.scenario('codex', {})
    const result = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'new work' })
    assert.match(result.text, /fixture completed/)
  } finally {
    try { child.kill('SIGKILL') } catch { /* already exited */ }
    try { await killGroup(Number(await readFile(prepared.adapterPidPath, 'utf8'))) } catch { /* never spawned */ }
  }
})

test('prepareLogin owns no child and creates no admission row', async t => {
  const f = await fixture(t, ['claude-code'])
  const binding = f.bindings[0]!
  const before = f.service().limits(owner, binding.connectionId)
  const descriptor = await f.service().prepareLogin(owner, owner, binding.connectionId)
  assert.deepEqual(descriptor.args, ['auth', 'login'])
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  const after = f.service().limits(owner, binding.connectionId)
  assert.equal(after.activeOnThisNode, before.activeOnThisNode)
  assert.equal(after.durableLocalOccupancy.total, 0)
  await assert.rejects(readFile(join(f.dir, 'claude-code', 'trace.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(f.dir, 'claude-code', 'adapter.pid')), { code: 'ENOENT' })
})

test('activeOnThisNode stays instance-local while durableLocalOccupancy reports the shared row', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const second = peer(f)
  t.after(second.close)
  await f.scenario('codex', { scenario: 'hang' })
  const abort = new AbortController()
  const run = f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello', signal: abort.signal })
  const runSettled = run.then(() => undefined, () => undefined)
  await until(async () => { try { return (await f.trace('codex')).some(frame => frame.method === 'turn/start') } catch { return false } })
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 1)
  assert.deepEqual(f.service().limits(owner, binding.connectionId).durableLocalOccupancy, { held: 1, cleanupUnconfirmed: 0, total: 1 })
  assert.equal(second.agents.limits(owner, binding.connectionId).activeOnThisNode, 0)
  assert.deepEqual(second.agents.limits(owner, binding.connectionId).durableLocalOccupancy, { held: 1, cleanupUnconfirmed: 0, total: 1 })
  abort.abort(); await runSettled; await second.close()
  assert.deepEqual(f.service().limits(owner, binding.connectionId).durableLocalOccupancy, { held: 0, cleanupUnconfirmed: 0, total: 0 })
})

test('spawn/preflight executable failure releases the exact holder with zero child starts', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  await rm(f.installations[0]!.executable)
  const outcome = await settled(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }))
  assert.equal(outcome.status, 'error')
  assert.equal(rowsAt(join(f.dir, 'external-agents.sqlite')).length, 0)
  assert.equal(f.service().limits(owner, binding.connectionId).activeOnThisNode, 0)
  await assert.rejects(readFile(join(f.dir, 'codex', 'trace.json')), { code: 'ENOENT' })
})

test('registered canary is absent from the schema, all sidecar data, raw WAL, events, errors and diagnostics', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const result = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: `secret ${f.secret}` })
  const path = join(f.dir, 'external-agents.sqlite')
  const columns = sqlAt<{ name: string }>(path, 'PRAGMA table_info(k5_admission)').map(row => row.name)
  assert.deepEqual(columns, ['holder_id', 'instance_id', 'owner', 'adapter', 'billing_account', 'kind', 'policy_digest', 'created_at', 'state', 'cleanup_reason'])
  assert.equal(columns.some(name => /pid|pgid|argv|environment|auth|email|org/i.test(name)), false)
  const tables = sqlAt<{ name: string }>(path, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name)
  for (const table of tables) assert.equal(JSON.stringify(sqlAt(path, `SELECT * FROM ${table}`)).includes(f.secret), false, table)
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try { assert.equal((await readFile(file)).includes(f.secret), false, file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  assert.equal(JSON.stringify(f.kernel.sessionLog!.readAll(result.sessionId, 'person')).includes(f.secret), false)
  assert.equal(JSON.stringify(f.service().limits(owner, binding.connectionId)).includes(f.secret), false)
  assert.equal(JSON.stringify(f.service().limits(owner, binding.connectionId)).includes('holder_id'), false)
  const admissionSource = await readFile(new URL('../../src/external-agents/admission.ts', import.meta.url), 'utf8')
  const storeSource = await readFile(new URL('../../src/external-agents/store.ts', import.meta.url), 'utf8')
  const serviceSource = await readFile(new URL('../../src/external-agents/service.ts', import.meta.url), 'utf8')
  for (const source of [admissionSource, storeSource, serviceSource]) assert.equal(/process\.kill\s*\(/.test(source), false)
  // Boot reconciliation facts (v3) live only in their own table; the holder table and the service never carry a PID or an expiry.
  const withoutBootFacts = storeSource.replace(/const MIGRATION_V3[\s\S]*?VALUES \(3\);`/, '')
  for (const source of [withoutBootFacts, serviceSource]) assert.equal(/expires_at|pid\s+INTEGER|pgid\s+INTEGER/i.test(source), false)
  assert.deepEqual(sqlAt<{ name: string }>(path, 'PRAGMA table_info(k5_admission_process)').map(row => row.name),
    ['holder_id', 'owner_pid', 'boot_ms', 'phase', 'group_id', 'group_started_at'])
})
