import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { start } from '../../src/index.ts'
import { reserves } from './fixture.ts'

const fakeBinary = fileURLToPath(new URL('../fixtures/fake-llama-server.ts', import.meta.url))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) }) })
async function until(predicate: () => boolean | Promise<boolean>, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  assert.fail('condition was not reached')
}
async function workspace(t: { after(fn: () => unknown): void }, behaviour = 'serve') {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-operational-boot-'))
  const binary = join(dir, 'llama-server'), modelPath = join(dir, 'model.gguf')
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeBinary}" --fixture-behaviour ${behaviour} "$@"\n`); await chmod(binary, 0o755)
  await writeFile(modelPath, 'GGUF-boot-fixture')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, binary, modelPath }
}
const body = { key: 'boot-key', projectId: 'no-such-project', connectionId: 'x', model: 'fixture', consent: 'full-access', domains: [],
  plan: { revision: 'r1', base: 'a'.repeat(40), goal: 'goal', items: [{ id: 'one', title: 'one', dependsOn: [], acceptance: ['true'], protectedPaths: [] }], protectedPaths: [] },
  caps: { cycles: 1, tokens: 1000, wallMs: 1000, moneyMicros: null } }
const post = async (url: string, connectionId: string) => {
  const response = await fetch(`${url}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, connectionId }) })
  return { status: response.status, code: (await response.json() as { code?: string }).code }
}

test('configuring both the T0 relay port and the operational option is a boot error before any file or database exists', async t => {
  const w = await workspace(t)
  await assert.rejects(start({ port: 0, dataDir: join(w.dir, 'data'), webDir: w.dir, devOrigins: [], relay: { runtime: { maximumAgeMs: 1 }, reserves },
    operationalRelay: { llamaServer: { kind: 'attach', baseUrl: 'http://127.0.0.1:1', model: 'fixture' }, reserves } }), /relay_policy_invalid/)
  await assert.rejects(stat(join(w.dir, 'data')), { code: 'ENOENT' }, 'no data directory was created')
})

test('with the option but without the binary the server boots and POST /api/relay keeps its stock refusal', async t => {
  const w = await workspace(t)
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: join(w.dir, 'data'), webDir: w.dir, devOrigins: [],
    operationalRelay: { llamaServer: { kind: 'spawn', binary: join(w.dir, 'absent-llama-server'), modelPath: w.modelPath, model: 'fixture', contextTokens: 8192 }, reserves } })
  t.after(() => server.close())
  assert.deepEqual(await post(server.url, 'x'), { status: 503, code: 'runtime_meter_unavailable' })
  const rows = server.context.db.prepare("SELECT (SELECT COUNT(*) FROM durable_runs) runs, (SELECT COUNT(*) FROM sessions) sessions").get()!
  assert.deepEqual({ ...rows }, { runs: 0, sessions: 0 })
})

test('with the binary the server owns one llama-server child: once healthy a request passes the meter and workspace gates, and close stops it', async t => {
  const w = await workspace(t), port = await freePort()
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: join(w.dir, 'data'), webDir: w.dir, devOrigins: [], connectionsPolicy: { ownerDevice: true, nodeKeyOptIn: true },
    operationalRelay: { llamaServer: { kind: 'spawn', binary: w.binary, modelPath: w.modelPath, model: 'fixture', contextTokens: 8192, port }, reserves } })
  let closed = false
  t.after(async () => { if (!closed) await server.close() })
  const connections = server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const connection = connections.create('local', { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  // Until the child is healthy the meter is unavailable; afterwards the first remaining gate is project resolution.
  await until(async () => (await post(server.url, connection.id)).code === 'relay_project_unavailable')
  assert.deepEqual(await post(server.url, connection.id), { status: 503, code: 'relay_project_unavailable' })
  const props = await (await fetch(`http://127.0.0.1:${port}/props`)).json() as { __pid: number; __argv: string[] }
  assert.ok(alive(props.__pid)); assert.ok(props.__argv.includes('--jinja'))
  const rows = server.context.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!
  assert.equal(rows.n, 0)
  await server.close(); closed = true
  await until(() => !alive(props.__pid))
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'the owned child no longer listens after the server closed')
})

test('while the owned child is still loading the model, admission is the stock meter refusal; closing the server stops the loading child', async t => {
  const w = await workspace(t, 'never-ready'), port = await freePort()
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: join(w.dir, 'data'), webDir: w.dir, devOrigins: [], connectionsPolicy: { ownerDevice: true, nodeKeyOptIn: true },
    operationalRelay: { llamaServer: { kind: 'spawn', binary: w.binary, modelPath: w.modelPath, model: 'fixture', contextTokens: 8192, port, stopGraceMs: 500 }, reserves } })
  let closed = false
  t.after(async () => { if (!closed) await server.close() })
  const connection = server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.create('local', { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).status === 503 } catch { return false } })
  const props = await (await fetch(`http://127.0.0.1:${port}/props`)).json() as { __pid: number }
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await post(server.url, connection.id), { status: 503, code: 'runtime_meter_unavailable' })
  assert.equal(server.context.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
  await server.close(); closed = true
  assert.equal(alive(props.__pid), false)
})

test('without an explicit port the spawned child still wires the relay once it is healthy', async t => {
  const w = await workspace(t)
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: join(w.dir, 'data'), webDir: w.dir, devOrigins: [], connectionsPolicy: { ownerDevice: true, nodeKeyOptIn: true },
    operationalRelay: { llamaServer: { kind: 'spawn', binary: w.binary, modelPath: w.modelPath, model: 'fixture', contextTokens: 8192 }, reserves } })
  t.after(() => server.close())
  const connection = server.kernel.node.service<Connections>(CONNECTIONS_SERVICE)!.create('local', { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  // The regression: with a port chosen asynchronously the relay stayed unwired and refused forever.
  await until(async () => (await post(server.url, connection.id)).code === 'relay_project_unavailable')
  assert.equal(server.context.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
})
