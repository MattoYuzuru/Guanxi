import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Hono } from 'hono'
import { apiErrorSchema, type SessionEvent } from '@guanxi/contract'
import { CONNECTIONS_SERVICE, connectionsPlugin } from '../../src/connections/plugin.ts'
import { piModels } from '../../src/connections/pi.ts'
import type { Connections } from '../../src/connections/service.ts'
import { redactionMarker, type SecretRef } from '../../src/egress/types.ts'
import { bootServerKernel } from '../../src/runtime/kernel.ts'
import { ChatSessionMirror } from '../../src/session-log/chat-mirror.ts'
import { SessionLogError, type SessionLog } from '../../src/session-log/log.ts'
import { createSessionQueryTool, querySessionLog } from '../../src/session-log/query-tool.ts'
import { sessionLogRoutes } from '../../src/session-log/routes.ts'
import { openDb } from '../../src/store/db.ts'
import { JobStore } from '../../src/store/jobs.ts'
import { ThreadStore } from '../../src/store/threads.ts'
import type { VaultKeychain } from '../../src/vault/keychain.ts'

const account = 'integration-owner'
const input = { name: 'Integration', kind: 'model_api', provider: 'deepseek', auth: 'api_key' } as const
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const toolContext = { workspaceRoot: null, enableBash: false, signal: new AbortController().signal }
const fakeKey = () => `fake_${randomBytes(32).toString('hex')}`
const notReady = (error: unknown) => error instanceof SessionLogError && error.code === 'egress_not_ready'

async function fixture(t: TestContext, transport?: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k3-k2-'))
  const keys = new Map<string, Buffer>()
  const keychain: VaultKeychain = { key(id, create, purpose) {
    const name = JSON.stringify([id, purpose])
    if (!keys.has(name) && create) keys.set(name, randomBytes(32))
    if (!keys.has(name)) throw new Error('Throwaway key unavailable')
    return Buffer.from(keys.get(name)!)
  } }
  let db = openDb(join(dir, 'node.sqlite'))
  let kernel = await bootServerKernel(undefined, { db })
  const config = { databasePath: join(dir, 'connections.sqlite'), localHost: () => 'http://127.0.0.1:11434',
    keychain: async () => keychain, transport: transport ?? (async () => { throw new Error('Unexpected provider request') }) }
  const load = () => kernel.node.plugin(connectionsPlugin, { ...config, keychain: () => config.keychain() })
  let handle = await load()
  const service = () => kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const retired = fakeKey(); const current = fakeKey()
  const row = service().create(account, input)
  await service().unlockVault(account)
  const retiredRef = service().saveSecret(account, row.id, retired).secretRef as SecretRef
  const currentRef = service().saveSecret(account, row.id, current).secretRef as SecretRef
  t.after(async () => {
    await kernel.node.dispose(); db.close()
    for (const key of keys.values()) key.fill(0)
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, config, service, keychain, row, retired, current, retiredRef, currentRef,
    get db() { return db }, get kernel() { return kernel },
    get log() { return kernel.sessionLog! },
    async restart() {
      await kernel.node.dispose(); db.close()
      db = openDb(join(dir, 'node.sqlite'))
      kernel = await bootServerKernel(undefined, { db })
      // Real production profile, before Connections apply: no empty-ready window.
      assert.equal(kernel.scrubber.isReady(), false)
      assert.deepEqual(kernel.scrubber.pendingSources(), ['vault'])
      assert.throws(() => kernel.sessionLog!.list(), notReady)
      handle = await load()
    },
    async unload() { await handle.dispose() },
    async reload() { handle = await load() },
  }
}

async function failingTool(...secrets: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.env.FAKE_TOOL_OUTPUT);process.exitCode=1'], {
      env: { FAKE_TOOL_OUTPUT: secrets.join(' ') }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', data => { stdout += data })
    child.on('error', reject)
    child.on('close', code => code === 1 ? resolve(stdout) : reject(new Error('Expected tool failure')))
  })
}

function routes(log: SessionLog) {
  return new Hono().route('/api/sessions', sessionLogRoutes(() => log))
}

function noMatches(value: unknown, secrets: string[]) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets) assert.equal(text.split(secret).length - 1, 0, 'zero fake-secret matches')
}

test('K2 integration: restart, failing tool, locked-vault event, inspector/export/query and model/artifact are scrubbed', { timeout: 15_000 }, async t => {
  const requests: { body: string; auth: string | null }[] = []
  const f = await fixture(t, async (_url, init) => {
    requests.push({ body: String(init?.body), auth: new Headers(init?.headers).get('authorization') })
    return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: `${f.current} ${f.retired}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  })
  await f.restart()
  assert.equal(f.service().snapshot(account).vault.unlocked, false)
  assert.equal(f.kernel.scrubber.isReady(), true)
  const output = await failingTool(f.current, f.retired)
  assert.equal(output, `${f.current} ${f.retired}`)
  const sessionId = 's-k3-restart'
  const handle = f.log.open(sessionId, { kind: 'agent' })
  const result = handle.append({ type: 'tool.result', data: { toolCallId: 'failed-tool', status: 'error', result: output, error: 'exit 1', durationMs: 1 } }, { idempotencyKey: 'tool-once' })
  const expected = `${redactionMarker(f.currentRef)} ${redactionMarker(f.retiredRef)}`
  assert.equal(result.event.type, 'tool.result')
  assert.deepEqual(result.event.data, { toolCallId: 'failed-tool', status: 'error', result: expected, error: 'exit 1', durationMs: 1 })
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM session_events WHERE type='tool.result'").get()!.n, 1)
  const secrets = [f.current, f.retired]
  noMatches(f.db.prepare('SELECT * FROM session_events').all(), secrets)
  noMatches(f.db.prepare('SELECT * FROM session_events_fts').all(), secrets)
  for (const secret of secrets) assert.equal(f.log.search(secret, { audience: 'person' }).length, 0)
  const app = routes(f.log)
  for (const path of ['/api/sessions', `/api/sessions/${sessionId}`, `/api/sessions/${sessionId}/events`,
    `/api/sessions/${sessionId}/spans`, `/api/sessions/${sessionId}/export`, '/api/sessions/search?q=REDACTED']) {
    const response = await app.request(path, {}, LOOPBACK)
    assert.equal(response.status, 200, path)
    noMatches(await response.text(), secrets)
  }
  const exported = await (await app.request(`/api/sessions/${sessionId}/export`, {}, LOOPBACK)).json() as { events: SessionEvent[] }
  assert.equal(exported.events.filter(event => event.type === 'tool.result').length, 1)
  for (const audience of ['local_agent', 'remote_agent'] as const) {
    const tool = createSessionQueryTool({ log: f.log, sessionId, audience })
    const result = await tool.execute({}, toolContext)
    noMatches(result, secrets)
    assert.equal(JSON.parse(result.content).events.filter((event: SessionEvent) => event.type === 'tool.result').length, 1)
  }
  // Unloading/reloading the vault cannot reopen an egress hole in the long-lived K2 provider.
  await f.unload()
  f.config.keychain = async () => { throw new Error('Throwaway keychain locked') }
  assert.equal(f.kernel.scrubber.scrub(output), expected)
  await f.reload()
  noMatches(f.log.readAll(sessionId, 'person'), secrets)
  f.config.keychain = async () => f.keychain
  await f.service().unlockVault(account)
  const completion = await f.service().complete(account, f.row.id, { messages: [{ role: 'toolResult', toolCallId: 'failed-tool', toolName: 'failing-tool', content: [{ type: 'text', text: output }], isError: true, timestamp: Date.now() }] },
    { model: piModels('deepseek')[0]!.id, runId: 'integration', requestId: 'after-restart' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.auth, `Bearer ${f.current}`)
  noMatches(requests[0]!.body, secrets); assert.match(requests[0]!.body, /REDACTED/)
  noMatches(completion, secrets); assert.match(JSON.stringify(completion.content), /REDACTED/)
  const ledger = f.service().snapshot(account).costs
  assert.equal(ledger.length, 1); noMatches(ledger, secrets)
  const path = join(f.dir, 'artifact.json')
  const digest = await f.service().writeArtifact(account, path, { output, completion, ledger })
  const bytes = await readFile(path)
  noMatches(bytes.toString(), secrets)
  assert.equal(digest.sha256, createHash('sha256').update(bytes).digest('hex'))
})

for (const failure of ['rejected', 'held'] as const) test(`K2 integration: ${failure} keychain keeps every read closed and recovers deferred events on unlock`, { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  let release!: (value: VaultKeychain) => void
  let keyReads = 0
  const tracked: VaultKeychain = { key(...args) { keyReads++; return f.keychain.key(...args) } }
  f.config.keychain = failure === 'held'
    ? () => new Promise(resolve => { release = resolve })
    : async () => { throw new Error('Throwaway keychain locked') }
  await f.restart()
  assert.equal(f.kernel.scrubber.isReady(), false)
  assert.deepEqual(f.kernel.scrubber.pendingSources(), ['vault'])
  const thread = new ThreadStore(f.db).create({ title: 'Pending', mode: 'chat', model: 'fixture', workspaceId: null,
    options: { numCtx: 4096, temperature: 0, think: 'high' } })
  const mirror = new ChatSessionMirror({ log: f.log, db: f.db })
  const jobs = new JobStore(f.db, { sessionMirror: mirror })
  const output = await failingTool(f.current, f.retired)
  const job = jobs.createChat({ threadId: thread.id, idempotencyScope: 'integration', idempotencyKey: 'deferred', requestFingerprint: 'fixture',
    input: { content: output, attachments: [], autoApprove: null }, derivedTitle: 'Pending' })
  assert.deepEqual(mirror.backlog(), [job.job.id])
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_events').get()!.n, 0)
  noMatches(f.db.prepare('SELECT * FROM session_mirror_backlog').all(), [f.current, f.retired])
  for (const read of [() => f.log.open('s-pending', { kind: 'agent' }), () => f.log.list(), () => f.log.session(thread.id),
    () => f.log.read(thread.id, { audience: 'person' }), () => f.log.readAll(thread.id, 'remote_agent'),
    () => f.log.search('fake', { audience: 'person' }), () => f.log.counts(thread.id), () => f.log.tokenMeter(thread.id),
    () => querySessionLog(f.log, thread.id, 'remote_agent', {})]) assert.throws(read, notReady)
  const app = routes(f.log)
  for (const path of ['/api/sessions', `/api/sessions/${thread.id}`, `/api/sessions/${thread.id}/events`,
    `/api/sessions/${thread.id}/spans`, `/api/sessions/${thread.id}/export`, `/api/sessions/${thread.id}/stream`, '/api/sessions/search?q=fake']) {
    const response = await app.request(path, {}, LOOPBACK)
    assert.equal(response.status, 503, path)
    const body = apiErrorSchema.parse(await response.json())
    assert.equal(body.code, 'egress_not_ready'); assert.deepEqual(body.details, { pendingSources: ['vault'] })
    noMatches(body, [f.current, f.retired])
  }
  await assert.rejects(createSessionQueryTool({ log: f.log, sessionId: thread.id, audience: 'local_agent' }).execute({}, toolContext), /cannot be read until secret redaction is ready/)
  if (failure === 'held') {
    release(tracked)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(keyReads, 0, 'expired startup registration cannot resume')
    assert.equal(f.kernel.scrubber.isReady(), false)
  }
  f.config.keychain = async () => tracked
  await f.service().unlockVault(account)
  assert.equal(f.kernel.scrubber.isReady(), true)
  mirror.catchUpBacklog()
  assert.deepEqual(mirror.backlog(), [])
  const events = f.log.readAll(thread.id, 'person')
  assert.equal(events.filter(event => event.type === 'prompt').length, 1)
  noMatches(f.db.prepare('SELECT * FROM session_events').all(), [f.current, f.retired])
  noMatches(events, [f.current, f.retired])
  assert.match(JSON.stringify(events.find(event => event.type === 'prompt')), /REDACTED/)
  assert.equal(mirror.catchUpBacklog(), 0, 'recovery writes no duplicate events')
})
