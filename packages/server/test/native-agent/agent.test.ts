import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, realpath, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const dir = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'k4-agent-')))
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
    async restart(dataDirectory = data) { await agents.close(); agents = new NativeAgents(host, log, connections, scrubber, dataDirectory) } }
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
  const read = events.find(e => e.type === 'tool.result' && e.data.toolCallId === 'read')
  assert.equal(read?.type === 'tool.result' && read.data.status, 'ok', 'the file tool must actually succeed, not merely return a scrubbed error')
  assert.match(read?.type === 'tool.result' ? read.data.result! : '', /REDACTED/)
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
test('arbitrary shell execution uses an execution owner in both modes', { timeout: 30000 }, async t => {
  const { nativeTools } = await import('../../src/native-agent/tools.ts')
  const f = await fixture(t)
  for (const mode of ['read-only', 'full-access'] as const) {
    const scratch = join(f.dir, mode); await mkdir(scratch)
    const handle = f.log.open(`test-${mode}`, { kind: 'agent' })
    try {
      const tools = nativeTools({ policy: { mode, scratch, runtimeBase: f.data, roots: [], attachments: [], protectedPaths: [], domains: [] }, log: f.log, handle, scrubber: f.scrubber, queue() {} })
      const shell = tools.find(tool => tool.name === 'shell')!
      const result = await shell.execute('owned', { command: `node -e 'console.log("owned")'` })
      assert.notEqual(result.isError, true)
      assert.equal(result.content[0]?.type === 'text' && JSON.parse(result.content[0].text).stdout, 'owned\n')
    } finally { handle.close() }
  }
})
test('fetch treats an at-prefixed body as literal text rather than a file upload', { timeout: 30000 }, async t => {
  const { nativeTools } = await import('../../src/native-agent/tools.ts')
  const { createServer } = await import('node:http')
  const f = await fixture(t)
  const scratch = join(f.dir, 'fetch-scratch'); await mkdir(scratch)
  const file = join(scratch, 'body'); await writeFile(file, 'must-not-upload-file-contents')
  let body = ''
  const server = createServer(async (req, res) => {
    for await (const chunk of req) body += chunk.toString()
    res.end('received')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const handle = f.log.open('literal-fetch', { kind: 'agent' })
  try {
    const tools = nativeTools({ policy: { mode: 'full-access', scratch, roots: [], attachments: [], protectedPaths: [], domains: [`127.0.0.1:${port}`] }, log: f.log, handle, scrubber: f.scrubber, queue() {} })
    const result = await tools.find(tool => tool.name === 'fetch')!.execute('fetch', { url: `http://127.0.0.1:${port}/`, method: 'POST', body: `@${file}` })
    assert.notEqual(result.isError, true)
    assert.equal(body, `@${file}`)
    assert.equal(body.includes('must-not-upload-file-contents'), false)
  } finally { handle.close() }
})
test('protected file/directory links and absent children deny writes through canonical names', { timeout: 30000 }, async t => {
  let root = ''
  const f = await fixture(t, async call => call === 1 ? [
    ...['file', 'directory/existing', 'future/new'].map((path, index) => ({ type: 'toolCall' as const, id: `deny-${index}`, name: 'file_write', arguments: { path: join(root, path), content: 'changed' } })),
    { type: 'toolCall', id: 'control', name: 'file_write', arguments: { path: join(root, 'allowed'), content: 'worked' } },
  ] : [{ type: 'text', text: 'finished' }])
  root = join(f.dir, 'protected-root'); await mkdir(root)
  await mkdir(join(root, 'directory')); await mkdir(join(root, 'future'))
  await writeFile(join(root, 'file'), 'original'); await writeFile(join(root, 'directory/existing'), 'original')
  await symlink(join(root, 'file'), join(root, 'file-link'))
  await symlink(join(root, 'directory'), join(root, 'directory-link'))
  await symlink(join(root, 'future'), join(root, 'parent-link'))
  f.agents().setRoots(f.input.projectId, [f.workspaces.create(root).id])
  const { sessionId } = await f.agents().create({ ...f.input, mode: 'full-access', protectedPaths: ['file-link', 'directory-link', 'parent-link/new'] })
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const events = f.log.readAll(sessionId, 'person')
  const policy = events.find(event => event.type === 'agent.policy')!
  assert.equal(policy.type, 'agent.policy')
  if (policy.type !== 'agent.policy') throw new Error('missing policy')
  for (const path of ['file-link', 'file', 'directory-link', 'directory', 'parent-link/new', 'future/new']) assert.ok(policy.data.protectedPaths.includes(join(root, path)))
  for (let index = 0; index < 3; index++) {
    const result = events.find(event => event.type === 'tool.result' && event.data.toolCallId === `deny-${index}`)
    assert.equal(result?.type === 'tool.result' && result.data.status, 'error')
  }
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'original')
  assert.equal(await readFile(join(root, 'directory/existing'), 'utf8'), 'original')
  await assert.rejects(readFile(join(root, 'future/new')))
  assert.equal(await readFile(join(root, 'allowed'), 'utf8'), 'worked')
})
test('protected dangling links and absent children beneath dangling parents fail creation closed', async t => {
  const f = await fixture(t)
  const root = join(f.dir, 'dangling-root'); await mkdir(root)
  await symlink(join(root, 'future-file'), join(root, 'file-link'))
  await symlink(join(root, 'future-directory'), join(root, 'parent-link'))
  f.agents().setRoots(f.input.projectId, [f.workspaces.create(root).id])
  for (const path of ['file-link', 'parent-link/new']) {
    await assert.rejects(f.agents().create({ ...f.input, mode: 'full-access', protectedPaths: [path] }), /protected_path_invalid/)
  }
  assert.equal(f.requests.length, 0, 'no inference starts with an unresolved protected target')
})
test('zero-root scratch protections accept an ordinary missing file through a linked data directory', async t => {
  const f = await fixture(t)
  const alias = join(f.dir, 'data-alias'); await symlink(f.data, alias)
  await f.restart(alias)
  for (const mode of ['read-only', 'full-access'] as const) {
    const { sessionId } = await f.agents().create({ ...f.input, mode, protectedPaths: ['future'] })
    assert.equal((await f.agents().wait(sessionId)).status, 'completed')
    const policy = f.log.readAll(sessionId, 'person').find(event => event.type === 'agent.policy')!
    if (policy.type !== 'agent.policy') throw new Error('missing policy')
    assert.equal(policy.data.scratch.startsWith(f.data + '/'), true)
    assert.ok(policy.data.protectedPaths.includes(join(policy.data.scratch, 'future')))
  }
})
test('shutdown during attachment staging prevents a late model dispatch', { timeout: 30000 }, async t => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t)
  f.agents().host.artifactTransfers.download = async () => {
    await held
    return { content: new Uint8Array(), attachment: { artifact: { mediaType: 'text/plain' }, displayName: 'fixture' } } as Awaited<ReturnType<import('../../src/native-agent/service.ts').NativeHost['artifactTransfers']['download']>>
  }
  const creating = f.agents().create({ ...f.input, attachmentIds: ['fixture'] })
  await new Promise(resolve => setTimeout(resolve, 10))
  await f.agents().close()
  release()
  await assert.rejects(creating, /agent_unavailable/)
  assert.equal(f.requests.length, 0)
})

test('overlapping roots exclude a second native writer until unload kills detached descendants', { timeout: 30000 }, async t => {
  let root = ''
  const f = await fixture(t, async call => call === 1 ? [{ type: 'toolCall', id: 'owned', name: 'shell', arguments: {
    command: ['setsid', 'nohup', 'double'].map(kind => {
      const child = `sh -c 'printf ready > ${root}/${kind}-ready; sleep 2; printf LEAK > ${root}/${kind}-late' >/dev/null 2>&1`
      return kind === 'double' ? `((${child} &) >/dev/null 2>&1 &)` : `${kind} ${child} &`
    }).join('\n') + `\nsleep 30`,
  } }] : [{ type: 'text', text: 'second writer' }])
  root = join(f.dir, 'shared'); await mkdir(join(root, 'nested'), { recursive: true })
  const whole = f.workspaces.create(root), nested = f.workspaces.create(join(root, 'nested'))
  f.agents().setRoots(f.input.projectId, [whole.id])
  const { sessionId } = await f.agents().create({ ...f.input, mode: 'full-access' })
  const until = Date.now() + 15_000
  for (const kind of ['setsid', 'nohup', 'double']) while (true) {
    try { assert.equal(await readFile(join(root, kind + '-ready'), 'utf8'), 'ready'); break } catch {
      assert.ok(Date.now() < until, `${kind} must actually start`); await new Promise(r => setTimeout(r, 10))
    }
  }
  for (const ids of [[whole.id], [nested.id]]) {
    f.agents().setRoots(f.input.projectId, ids)
    await assert.rejects(f.agents().create({ ...f.input, mode: 'full-access' }), /root_busy/)
  }
  assert.equal(f.requests.length, 1)
  await f.agents().close()
  await f.restart()
  assert.equal(f.agents().progress(sessionId).status, 'cancelled')
  const second = await f.agents().create({ ...f.input, mode: 'full-access' })
  assert.equal((await f.agents().wait(second.sessionId)).status, 'completed')
  await new Promise(r => setTimeout(r, 2200))
  for (const kind of ['setsid', 'nohup', 'double']) await assert.rejects(readFile(join(root, kind + '-late')), { code: 'ENOENT' })
  assert.equal(f.requests.length, 2)
})

test('a stored running session projects interrupted after restart and never dispatches automatically', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input)
  await f.agents().wait(sessionId)
  const writer = f.log.open(sessionId, { kind: 'agent' })
  writer.append({ type: 'agent.state', data: { status: 'running', error: null } }); writer.close()
  await f.restart()
  assert.equal(f.agents().progress(sessionId).status, 'interrupted')
  assert.equal(f.agents().progress(sessionId).error, 'process_restarted')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(f.requests.length, 1)
  f.agents().prompt(sessionId, 'explicit continuation')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 2)
})

test('selected text and image attachments are staged immutable and image data is dispatched only to an image model', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const model = piModels('openai').find(model => model.input.includes('image'))!
  const connection = f.connections.create('local', { name: 'Image fixture', provider: 'openai', kind: 'model_api', auth: 'api_key' })
  f.connections.saveSecret('local', connection.id, f.secret)
  f.agents().host.artifactTransfers.download = async id => ({ content: Buffer.from(id === 'image' ? 'fixture-image-bytes' : 'fixture text'),
    attachment: { artifact: { mediaType: id === 'image' ? 'image/png' : 'text/plain' }, displayName: id } }) as unknown as Awaited<ReturnType<import('../../src/native-agent/service.ts').NativeHost['artifactTransfers']['download']>>
  const selected = await f.agents().create({ ...f.input, model: model.id, connectionId: connection.id, attachmentIds: ['text', 'image'] })
  assert.equal((await f.agents().wait(selected.sessionId)).status, 'completed')
  assert.match(f.requests[0]!, /Zml4dHVyZS1pbWFnZS1ieXRlcw==/)
  const policy = f.log.readAll(selected.sessionId, 'person').find(e => e.type === 'agent.policy')!
  if (policy.type !== 'agent.policy') throw new Error('missing policy')
  assert.equal(policy.data.attachments.length, 2)
  assert.equal(await readFile(policy.data.attachments[0]!, 'utf8'), 'fixture text')
  assert.equal(JSON.stringify(f.log.readAll(selected.sessionId, 'person')).includes('Zml4dHVyZS1pbWFnZS1ieXRlcw=='), false)
  const local = f.connections.create('local', { kind: 'local_runtime', provider: 'ollama', auth: 'none', name: 'Text-only fixture' })
  const denied = await f.agents().create({ ...f.input, connectionId: local.id, model: 'fixture-local', contextTokens: 4096, attachmentIds: ['image'] })
  assert.equal((await f.agents().wait(denied.sessionId)).status, 'failed')
  assert.equal(f.requests.length, 1, 'text-only model never receives an image')
})
test('runtime recovery clears a historical shell-unavailable projection', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  const writer = f.log.open(sessionId, { kind: 'agent' })
  const call = (id: string) => writer.append({ type: 'tool.call', data: { toolCallId: id, name: 'shell', arguments: {}, source: 'builtin', parsedFrom: 'native', diffPath: null } })
  call('failed')
  writer.append({ type: 'tool.result', data: { toolCallId: 'failed', status: 'error', result: 'container_runtime_unavailable', error: 'tool_failed', durationMs: 1 } })
  assert.equal(f.agents().progress(sessionId).shellUnavailable, 'container_runtime_unavailable')
  call('recovered')
  writer.append({ type: 'tool.result', data: { toolCallId: 'recovered', status: 'ok', result: 'owned', error: null, durationMs: 1 } })
  writer.close()
  assert.equal(f.agents().progress(sessionId).shellUnavailable, undefined)
})
test('oversized state tool results use a bounded artifact response and a session-bound reader', async t => {
  const { nativeTools } = await import('../../src/native-agent/tools.ts')
  const f = await fixture(t)
  const handle = f.log.open('large-state', { kind: 'agent' })
  try {
    const tools = nativeTools({ policy: { mode: 'read-only', scratch: f.dir, runtimeBase: f.data,
      roots: Array.from({ length: 2000 }, (_, i) => `/fixture/${i}/${'path'.repeat(30)}`), attachments: [], protectedPaths: [], domains: [] }, log: f.log, handle, scrubber: f.scrubber, queue() {} })
    const result = await tools.find(t => t.name === 'project_info')!.execute('large', {})
    assert.notEqual(result.isError, true)
    const text = result.content[0]!.type === 'text' ? result.content[0]!.text : ''
    assert.ok(Buffer.byteLength(text) <= 65536)
    const reference = JSON.parse(text); assert.equal(reference.truncated, true)
    const page = await tools.find(t => t.name === 'tool_output_read')!.execute('page', { artifact: reference.artifact, offset: '0' })
    assert.notEqual(page.isError, true)
    const data = page.content[0]!.type === 'text' ? JSON.parse(page.content[0]!.text) : null
    assert.equal(data.offset, 0); assert.ok(data.nextOffset > 0); assert.equal(data.truncated, true)
  } finally { handle.close() }
})
