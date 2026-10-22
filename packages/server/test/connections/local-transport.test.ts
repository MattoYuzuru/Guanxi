import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { Connections, type LocalChatTransport } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import type { OllamaChatRequest } from '../../src/ollama/types.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { Vault } from '../../src/vault/vault.ts'

async function setup(t: { after(fn: () => unknown): void }, options: { unattended?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k3-transport-'))
  const scrubber = new SecretScrubber(), governor = new ResourceGovernor(), life = new AbortController()
  const store = new ConnectionStore(join(dir, 'connections.sqlite'), scrubber)
  const vault = new Vault(store, async () => { throw new Error('No fixture keychain') }, scrubber, { ownerDevice: true, nodeKeyOptIn: true })
  let ollama = 0
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async () => { ollama++; return Response.json({ version: 'fixture' }) } })
  const connections = new Connections(store, vault, new BalanceProbes(store, vault), scrubber, life.signal, { client: () => client }, governor, () => 'http://127.0.0.1:11434')
  const row = connections.create('local', { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: options.unattended ?? true })
  t.after(async () => { life.abort(); await connections.close(); vault.close(); store.close(); await governor.close(); scrubber.close(); await rm(dir, { recursive: true, force: true }) })
  return { connections, store, governor, scrubber, row, ollama: () => ollama }
}
const request: OllamaChatRequest = { model: 'fixture', messages: [{ role: 'user', content: 'hello' }], options: { num_ctx: 1024, num_predict: 16 } }
const chunk = { model: 'fixture', created_at: new Date(0).toISOString(), done: true, message: { role: 'assistant' as const, content: 'ok' }, prompt_eval_count: 7, eval_count: 3 }
function transport(chat: LocalChatTransport['chat'], host = 'http://127.0.0.1:8081'): LocalChatTransport {
  return { id: 'llama-server', host, usageSource: 'llama-server:/completion', chat }
}

test('a trusted transport replaces the Ollama wire call while K3 keeps the permit, the scrub, the dispatch hooks and the receipt', async t => {
  const f = await setup(t), secret = 'k3-transport-secret-value-1'
  f.scrubber.register('secret://k3-transport', secret)
  let permit: string | undefined, prepared: OllamaChatRequest | undefined, started = 0, authorized = 0
  const chat = transport(async (_request, _signal, onDispatched, dispatch) => {
    permit = f.governor.snapshot().activeLease?.model.name
    await dispatch.authorizeDispatch(); prepared = dispatch.prepare(); onDispatched()
    return chunk
  })
  const result = await f.connections.localChat('local', f.row.id, { ...request, messages: [{ role: 'user', content: `leak ${secret}` }] },
    { runId: 'run', requestId: 'transport-request', background: true, transport: chat, onStarted: () => { started++ }, authorizeDispatch: async () => { authorized++ } })
  assert.equal(result.prompt_eval_count, 7)
  assert.equal(f.ollama(), 0, 'the Ollama adapter was never contacted')
  assert.equal(permit, 'llama-server:fixture', 'a foreign runtime takes the one permit under a prefixed name')
  assert.equal(JSON.stringify(prepared).includes(secret), false, 'prepare() hands the transport the scrubbed request')
  assert.equal(started, 1); assert.equal(authorized, 1)
  assert.equal(f.governor.snapshot().activeLease, null, 'the permit is released when the call settles')
  const [receipt] = f.store.costs('local')
  assert.equal(receipt!.source, 'llama-server:/completion'); assert.equal(receipt!.inputTokens, 7); assert.equal(receipt!.outputTokens, 3); assert.equal(receipt!.costUsd, null)
})

test('without a transport the Ollama path and its receipt label are unchanged', async t => {
  const f = await setup(t)
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async (url) => String(url).endsWith('/api/version') ? Response.json({ version: 'v' }) : Response.json(chunk) })
  const connections = new Connections(f.store, new Vault(f.store, async () => { throw new Error('none') }, f.scrubber, { ownerDevice: true, nodeKeyOptIn: true }), new BalanceProbes(f.store, undefined as never), f.scrubber,
    new AbortController().signal, { client: () => client }, f.governor, () => 'http://127.0.0.1:11434')
  await connections.localChat('local', f.row.id, request, { runId: 'run', requestId: 'plain' })
  assert.equal(f.store.costs('local').at(-1)!.source, 'ollama:/api/chat')
  await connections.close()
})

test('a transport outside loopback, a revoked consent or a transport failure never reaches or leaks the permit', async t => {
  const f = await setup(t); let calls = 0
  const never = transport(async () => { calls++; return chunk }, 'http://192.168.1.20:8081')
  await assert.rejects(f.connections.localChat('local', f.row.id, request, { runId: 'run', requestId: 'remote', transport: never }), /Local runtime must be on this node/)
  const credentials = transport(async () => { calls++; return chunk }, 'http://user:pass@127.0.0.1:8081')
  await assert.rejects(f.connections.localChat('local', f.row.id, request, { runId: 'run', requestId: 'creds', transport: credentials }), /Local runtime must be on this node/)
  const local = transport(async () => { calls++; return chunk })
  const open = await setup(t, { unattended: false })
  await assert.rejects(open.connections.localChat('local', open.row.id, request, { runId: 'run', requestId: 'no-consent', background: true, transport: local }), /Unattended access disabled/)
  assert.equal(calls, 0, 'the transport was never invoked')
  const failing = transport(async () => { calls++; throw new Error('wire failure with text that must not escape') })
  await assert.rejects(f.connections.localChat('local', f.row.id, request, { runId: 'run', requestId: 'failing', transport: failing }),
    (error: unknown) => !String(error).includes('wire failure') && /Runtime request failed/.test(String(error)))
  assert.equal(calls, 1); assert.equal(f.governor.snapshot().activeLease, null)
  assert.equal(f.store.costs('local').length, 0, 'a failed call records no receipt')
})
