import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../../src/index.ts'
import { CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { NATIVE_AGENT_SERVICE, type NativeAgentService } from '../../src/native-agent/plugin.ts'
import { filterNativeRequest } from '../../src/native-agent/request-policy.ts'

test('port-zero server native policies deny the actually bound API and web ports', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'k4f-ports-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const web = createServer((_req, res) => res.end('fixture web'))
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const webPort = (web.address() as { port: number }).port
  const oldPort = process.env.GUANXI_WEB_PORT
  process.env.GUANXI_WEB_PORT = String(webPort)
  t.after(() => { if (oldPort === undefined) delete process.env.GUANXI_WEB_PORT; else process.env.GUANXI_WEB_PORT = oldPort })
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, devOrigins: [] })
  t.after(() => server.close())
  assert.notEqual(server.port, 0, 'an ephemeral API port was actually bound')
  const connections = server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const local = t.mock.method(connections, 'localChat', async () => ({ model: 'fixture', done: true,
    message: { role: 'assistant' as const, content: 'fixture answer' } }))
  const connection = connections.create('local', { kind: 'local_runtime', provider: 'ollama', auth: 'none', name: 'Fixture' })
  const project = server.context.projects.create('Fixture')
  const agents = server.kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)!
  for (const mode of ['read-only', 'full-access'] as const) {
    const creating = agents.create({ projectId: project.id, connectionId: connection.id, model: 'fixture',
      prompt: 'fixture', mode, contextTokens: 4096,
      domains: [`127.0.0.1:${server.port}`, `127.0.0.1:${webPort}`, '127.0.0.1:80'] })
    await assert.doesNotReject(creating, 'an ephemeral listener must produce a valid native policy')
    const { sessionId } = await creating
    assert.equal((await agents.wait(sessionId)).text, 'fixture answer')
    const event = server.kernel.sessionLog!.readAll(sessionId, 'person').find(event => event.type === 'agent.policy')!
    assert.equal(event.type, 'agent.policy')
    if (event.type !== 'agent.policy') throw new Error('missing policy')
    for (const port of [server.port, webPort]) {
      let authorized = false
      const decision = await filterNativeRequest(new Request(`http://127.0.0.1:${port}/`), event.data, async () => { authorized = true; return true })
      assert.deepEqual(decision, { action: 'deny' }, `${mode}: bound port ${port} denied despite explicit domain grant`)
      assert.equal(authorized, false, 'node requests stop before egress authorization')
    }
    assert.deepEqual(event.data.nodePorts, [server.port, webPort], 'the policy snapshots both actual service ports')
    assert.deepEqual(await filterNativeRequest(new Request('http://127.0.0.1/'), event.data, async () => true), { action: 'allow' }, 'a granted non-node service remains usable')
  }
  assert.equal(local.mock.callCount(), 2, 'both sessions use only the fixture provider')
})
