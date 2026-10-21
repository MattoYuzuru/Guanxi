import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createKernel } from '@guanxi/kernel'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { egressScrubberPlugin } from '../../src/egress/plugin.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'
import { connectionsPlugin } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { piModels } from '../../src/connections/pi.ts'
import { createSessionLogPlugin } from '../../src/session-log/plugin.ts'
import type { SessionLog } from '../../src/session-log/log.ts'
import { openDb } from '../../src/store/db.ts'
import { ProjectStore } from '../../src/store/projects.ts'
import { ProjectService } from '../../src/projects/service.ts'
import { WorkspaceStore } from '../../src/store/workspaces.ts'
import { NativeAgents } from '../../src/native-agent/service.ts'
import { emptyUsage } from '../../src/native-agent/model.ts'

async function fixture(t: { after(fn: () => unknown): void }, respond?: (call: number, context: string, signal?: AbortSignal) => Promise<AssistantMessage['content']>, localFetch?: typeof fetch) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'k4-agent-')))
  const data = join(dir, 'data'); await mkdir(data)
  const db = openDb(join(data, 'test.sqlite'))
  const kernel = createKernel()
  await kernel.plugin(resourceGovernorPlugin)
  await kernel.plugin(ollamaAdapterPlugin, { fetch: localFetch ?? (async () => { throw new Error('No external network in K4 tests') }) })
  await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
  await kernel.plugin(createSessionLogPlugin({ db }))
  const requests: string[] = []
  const model = piModels('deepseek')[0]!
  let calls = 0
  await kernel.plugin(connectionsPlugin, { databasePath: join(data, 'connections.sqlite'), localHost: () => '127.0.0.1:11434',
    keychain: async () => ({ key: () => randomBytes(32) }),
    pi: { async complete(_model, context, options) {
      const serialized = JSON.stringify(context); requests.push(serialized)
      const content = respond ? await respond(++calls, serialized, options.signal) : [{ type: 'text' as const, text: 'fixture answer' }]
      return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, usage: emptyUsage(),
        stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() }
    } } })
  const connections = kernel.service<Connections>('connections.registry')!
  const connection = connections.create('local', { name: 'Fixture', provider: 'deepseek', kind: 'model_api', auth: 'api_key' })
  await connections.unlockVault('local')
  const secret = 'test_' + randomBytes(24).toString('hex')
  connections.saveSecret('local', connection.id, secret)
  const projects = new ProjectService(new ProjectStore(db)), workspaces = new WorkspaceStore(db)
  const project = projects.create('Fixture project')
  const log = kernel.service<SessionLog>('session.log')!, scrubber = kernel.service<EgressScrubber>('egress.scrubber')!
  const host = { projects, workspaces, artifactTransfers: { download: async () => { throw new Error('No attachment') } } } as unknown as ConstructorParameters<typeof NativeAgents>[0]
  let agents = new NativeAgents(host, log, connections, scrubber, data)
  t.after(async () => { await agents.close(); await kernel.dispose(); db.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, data, connections, agents: () => agents, log, scrubber, secret, requests, projects, workspaces,
    input: { projectId: project.id, connectionId: connection.id, model: model.id, prompt: 'fixture prompt' },
    async restart() { await agents.close(); agents = new NativeAgents(host, log, connections, scrubber, data) } }
}
test('native pi loop uses K3 and K2; tool-printed secrets scrub before next request, reasoning stays in its class', { timeout: 30000 }, async t => {
  let secret = '', root = ''
  const f = await fixture(t, async (call): Promise<AssistantMessage['content']> => call === 1 ? [
    { type: 'thinking', thinking: 'fixture reasoning' },
    { type: 'toolCall', id: 'read', name: 'file_read', arguments: { path: join(root, 'secret.txt') } },
    { type: 'toolCall', id: 'note', name: 'note_add', arguments: { text: secret } },
  ] : [{ type: 'text', text: 'finished ' + secret }])
  secret = f.secret; root = join(f.dir, 'root'); await mkdir(root); await writeFile(join(root, 'secret.txt'), secret)
  const workspace = f.workspaces.create(root)
  f.agents().setRoots(f.input.projectId, [workspace.id])
  const { sessionId } = await f.agents().create(f.input)
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'completed')
  assert.equal(f.requests.length, 2)
  for (const request of f.requests) { assert.equal(request.includes(secret), false); assert.equal(request.includes('fixture reasoning'), false) }
  assert.match(f.requests[1]!, /REDACTED/)
  const events = f.log.readAll(sessionId, 'person')
  assert.equal(JSON.stringify(events).includes(secret), false)
  assert.equal(events.filter(e => e.type === 'tool.call').length, 2)
  assert.equal(events.filter(e => e.type === 'tool.result').length, 2)
  assert.equal(events.filter(e => e.type === 'agent.note').length, 1)
  assert.equal(events.filter(e => e.type === 'reasoning').length, 1)
  assert.equal(f.log.readAll(sessionId, 'remote_agent').filter(e => e.type === 'reasoning').length, 0)
  assert.equal(JSON.stringify(result).includes(secret), false)
  await f.restart()
  assert.equal(f.agents().progress(sessionId).status, 'completed')
  f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 3)
  assert.match(f.requests[2]!, /file_read/)
})
test('project zero/multiple roots persist, policy is immutable and readiness blocks create', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  assert.equal(f.agents().projects().find(p => p.id === f.input.projectId)!.filesystemBindings.length, 0)
  const ids: string[] = []
  for (const name of ['one', 'two']) { const root = join(f.dir, name); await mkdir(root); ids.push(f.workspaces.create(root).id) }
  f.agents().setRoots(f.input.projectId, ids)
  const { sessionId } = await f.agents().create(f.input)
  await f.agents().wait(sessionId)
  f.agents().setRoots(f.input.projectId, [])
  const policy = f.log.readAll(sessionId, 'person').find(e => e.type === 'agent.policy')!
  assert.equal(policy.type === 'agent.policy' && policy.data.roots.length, 2)
  await f.restart()
  assert.equal(f.agents().projects().find(p => p.id === f.input.projectId)!.filesystemBindings.length, 0)
  f.scrubber.expect('unready')
  await assert.rejects(f.agents().create(f.input), /egress_unavailable/)
  assert.equal(f.requests.length, 1)
  f.scrubber.ready('unready')
})
test('queued prompts are visible/removable, are consumed once, and cancel aborts a pending provider', { timeout: 30000 }, async t => {
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const f = await fixture(t, async (call, _ctx, signal) => {
    if (call === 1) await held
    if (call === 3) await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
    return [{ type: 'text', text: `answer ${call}` }]
  })
  const { sessionId } = await f.agents().create(f.input)
  f.agents().queue(sessionId, 'keep')
  f.agents().queue(sessionId, 'remove')
  const queue = f.agents().progress(sessionId).queue
  assert.equal(queue.length, 2)
  f.agents().removeQueued(sessionId, queue[1]!.id)
  release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 2)
  assert.equal(f.log.readAll(sessionId, 'person').filter(e => e.type === 'prompt' && e.data.text === 'keep').length, 1)
  f.agents().prompt(sessionId, 'cancel me')
  while (f.requests.length < 3) await new Promise(r => setTimeout(r, 5))
  f.agents().stop(sessionId)
  assert.equal((await f.agents().wait(sessionId)).status, 'cancelled')
})
test('native local-runtime dispatch uses K3, explicit context and the same pi tool loop', { timeout: 30000 }, async t => {
  const requests: Record<string, unknown>[] = []
  const f = await fixture(t, undefined, async (url, init) => {
    if (new URL(String(url)).pathname === '/api/version') return Response.json({ version: 'fixture' })
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ model: 'fixture-local', done: true, done_reason: 'stop', message: { role: 'assistant', content: 'local answer' }, prompt_eval_count: 3, eval_count: 4 })
  })
  const connection = f.connections.create('local', { kind: 'local_runtime', provider: 'ollama', auth: 'none', name: 'Fixture local' })
  const { sessionId } = await f.agents().create({ ...f.input, connectionId: connection.id, model: 'fixture-local', contextTokens: 4096 })
  assert.equal((await f.agents().wait(sessionId)).text, 'local answer')
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]!.options, { num_ctx: 4096 })
  assert.equal(Array.isArray(requests[0]!.tools), true)
  assert.equal(f.requests.length, 0, 'local path never uses the API provider transport')
})
test('native HTTP routes enforce peer/origin/JSON boundaries and reach the shared model service', { timeout: 30000 }, async t => {
  const { nativeAgentRoutes } = await import('../../src/native-agent/routes.ts')
  const f = await fixture(t)
  const service = f.agents()
  const app = nativeAgentRoutes(() => service as unknown as import('../../src/native-agent/plugin.ts').NativeAgentService)
  const peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
  assert.equal((await app.request('/projects')).status, 403)
  assert.equal((await app.request('/', { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: JSON.stringify(f.input) }, peer)).status, 403)
  assert.equal((await app.request('/', { method: 'POST', body: '{}' }, peer)).status, 415)
  const created = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.input) }, peer)
  assert.equal(created.status, 202)
  const { sessionId } = await created.json() as { sessionId: string }
  assert.equal((await service.wait(sessionId)).status, 'completed')
  assert.equal((await app.request(`/${sessionId}`, undefined, peer)).status, 200)
  assert.equal((await app.request(`/${sessionId}/result`, undefined, peer)).status, 200)
  assert.equal(f.requests.length, 1)
})
