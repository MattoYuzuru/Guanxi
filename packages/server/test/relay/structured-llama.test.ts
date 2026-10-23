import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { RelayStartInput } from '@guanxi/contract'
import { Connections } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import { OwnedCheckoutAllocator } from '../../src/relay/checkout.ts'
import { probeResponseSchema } from '../../src/relay/response-schemas.ts'
import { RelayRuntimeSource } from '../../src/relay/runtime.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { RelayStore } from '../../src/relay/store.ts'
import type { RelayLimits } from '../../src/relay/types.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { LlamaServerClient } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerRuntime } from '../../src/runtime/llama-server/runtime.ts'
import { Vault } from '../../src/vault/vault.ts'
import { RUN_TIME, runFixture } from '../fixtures/durable-runs.ts'
import { reply, startFakeLlama, type FakeLlamaState } from '../fixtures/fake-llama-server.ts'
import { accepts } from './schema-check.ts'
import { caps, reserves } from './fixture.ts'

const exec = promisify(execFile)
async function until(predicate: () => boolean | Promise<boolean>, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('fixture did not reach the expected state')
}
/** A model that answers every prompt in the shape the first real runs produced when it was not constrained (unquoted keys, a fenced probe whose
 * values are wrong) and in valid JSON when a `json_schema` reaches the server. The function is serialised into the server thread and captures
 * nothing: it decides on `body.json_schema` alone. */
const script = reply((prompt, _call, body) => {
  const state = globalThis as unknown as { work?: number }
  if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Completed fixture acceptance.'
  if (prompt.startsWith('<|user|>\nAnswer these five')) {
    const hash = /"ledgerHash":"([0-9a-f]{64})"/.exec(prompt)![1], head = /"head":"([0-9a-f]{40,64})"/.exec(prompt)![1], revision = /"revision":"([^"]+)"/.exec(prompt)![1]
    const open = [...prompt.matchAll(/\{"dependsOn":\[([^\]]*)\],"id":"([^"]+)","status":"([^"]+)"\}/g)].map(m => ({ deps: m[1] ? m[1].split(',').map(s => s.replace(/"/g, '')) : [], id: m[2]!, status: m[3]! }))
    const ids = new Set(open.map(o => o.id)), next = open.find(o => o.deps.every(d => !ids.has(d)))
    return body.json_schema ? JSON.stringify({ ledgerHash: hash, head, revision, nextItem: next ? next.id : null, nextStatus: next ? next.status : null })
      : '```json\n' + JSON.stringify({ ledgerHash: hash, head, revision, nextItem: null, nextStatus: 'completed' }) + '\n```'
  }
  state.work = (state.work ?? 0) + 1
  const action = state.work === 1 ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } } : state.work === 2 ? { action: 'verify', item: 'one' }
    : state.work === 3 ? { action: 'handoff' } : state.work === 4 ? { action: 'verify', item: 'two' } : { action: 'handoff' }
  return body.json_schema ? JSON.stringify(action) : '{action:tool,name:file_read,args:{path:"src/item.txt"}}'
})

async function fixture(t: { after(fn: () => unknown): void }, limits?: Partial<RelayLimits>, fakeState: Partial<FakeLlamaState> = {}) {
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const parent = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'structured-llama-')))
  const source = join(parent, 'project'), checkouts = join(parent, 'checkouts'), modelPath = join(parent, 'model.gguf')
  await mkdir(join(source, 'src'), { recursive: true }); await writeFile(join(source, 'src', 'item.txt'), 'synthetic task content'); await writeFile(modelPath, 'GGUF-structured-weights')
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: source })).stdout.trim()
  await git(['init', '-q', '-b', 'main']); await git(['add', '.']); await git(['commit', '-q', '-m', 'fixture'])
  const base = await git(['rev-parse', 'HEAD'])
  const fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, replies: [script], ...fakeState })
  const now = RUN_TIME
  const f = runFixture(':memory:')
  const relay = new RelayStore(f.db, f.store, f.scrubber, () => now), governor = new ResourceGovernor(), life = new AbortController()
  const connectionStore = new ConnectionStore(join(parent, 'connections.sqlite'), f.scrubber)
  const vault = new Vault(connectionStore, async () => { throw new Error('No fixture keychain') }, f.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async () => { throw new Error('Ollama must not be used by an llama-server relay') } })
  const connections = new Connections(connectionStore, vault, new BalanceProbes(connectionStore, vault), f.scrubber, life.signal, { client: () => client }, governor, () => 'http://127.0.0.1:11434')
  const connection = connections.create('local', { name: 'Fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  const runtime = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: fake.url }), model: 'fixture', clock: () => now, countTimeoutMs: 5000 })
  const runtimeSource = new RelayRuntimeSource(connections, () => { throw new Error('Ollama models must not be consulted') }, { maximumAgeMs: 10_000, observer: runtime, counter: runtime.counter }, () => now)
  const allocator = new OwnedCheckoutAllocator({ root: checkouts })
  const host = { runtime: runtimeSource, reserves, clock: () => now, nodePorts: () => [4437, 5237], ...(limits ? { limits } : {}),
    project: async (id: string) => ({ projectId: id, roots: [source], source: 'fixture project/workspace store', observedAt: now }),
    allocate: (async (policy, signal) => allocator.allocate(policy, signal)) as NonNullable<ConstructorParameters<typeof RelayStarts>[6]['allocate']> }
  const starts = new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, relay, host)
  const item = (id: string, dependsOn: string[]) => ({ id, title: id, dependsOn, acceptance: ['/usr/bin/true'], protectedPaths: [] })
  const input: RelayStartInput = { key: 'structured-key', projectId: 'project', connectionId: connection.id, model: 'fixture', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base, goal: 'Read the fixture and run acceptance.', items: [item('one', []), item('two', ['one'])], protectedPaths: [] }, caps }
  t.after(async () => {
    life.abort(); await starts.close(); await runtime.close(); await connections.close(); vault.close(); connectionStore.close(); await governor.close(); f.close(); await fake.close()
    await chmod(checkouts, 0o700).catch(() => undefined)
    let quarantined = false
    for (const name of await readdir(checkouts).catch(() => [] as string[])) {
      if ((await readdir(join(checkouts, name, 'runtime', 'native-cleanup')).catch(() => [] as string[])).length) quarantined = true
    }
    if (!quarantined) await rm(parent, { recursive: true, force: true })
  })
  return { ...f, relay, starts, input, fake, errors: (sessionId: string) => f.log.readAll(sessionId, 'person').filter(event => event.type === 'error').map(event => (event.data as { code: string }).code) }
}
const purpose = (prompt: string) => prompt.startsWith('<|user|>\nWrite a fresh') ? 'narrative' : prompt.startsWith('<|user|>\nAnswer these five') ? 'probe' : 'work'
const toolNames = (schema: { anyOf: Array<{ properties: { name?: { const: string } } }> }) => schema.anyOf.flatMap(v => v.properties.name ? [v.properties.name.const] : [])

test('through K3 and the llama-server transport every probe and work step carries its schema, the narrative none, and the run verifies both items', async t => {
  const f = await fixture(t), receipt = await f.starts.start(f.input)
  await until(() => ['completed', 'input_required', 'failed'].includes(f.starts.status(f.input.key).status))
  assert.equal(f.starts.status(f.input.key).status, 'completed', JSON.stringify({ errors: f.errors(receipt.sessionId!), error: f.starts.status(f.input.key).error }))
  const ledger = f.relay.read(receipt.runId!)
  assert.deepEqual(ledger.items, { one: 'done', two: 'done' }); assert.equal(ledger.errors, 0, 'not one invalid action')
  assert.deepEqual(f.errors(receipt.sessionId!), [])
  const posts = await f.fake.requests('/completion'), kinds = posts.map(p => purpose(p.body.prompt))
  for (const kind of ['work', 'probe', 'narrative'] as const) assert.ok(kinds.includes(kind), kind)
  for (const post of posts) {
    const kind = purpose(post.body.prompt)
    // The field is exactly `json_schema`, after the four flags the server has always been sent.
    assert.deepEqual(Object.keys(post.body), kind === 'narrative' ? ['prompt', 'n_predict', 'stream', 'cache_prompt'] : ['prompt', 'n_predict', 'stream', 'cache_prompt', 'json_schema'], kind)
    if (kind === 'probe') {
      assert.deepEqual(post.body.json_schema, probeResponseSchema())
      assert.deepEqual(Object.keys(post.body.json_schema.properties), ['ledgerHash', 'head', 'revision', 'nextItem', 'nextStatus'], 'keys are written in the order the prompt names them')
    }
    if (kind === 'work') {
      assert.deepEqual(toolNames(post.body.json_schema), ['work.query', 'notes.search', 'tool_output_read', 'project_info', 'file_read', 'file_write', 'shell', 'search', 'repo_map', 'fetch', 'attachments', 'session_log_query'],
        'the grammar names exactly the tools the workspace serves, plus the two ledger queries')
      const variants = post.body.json_schema.anyOf as Array<{ properties: Record<string, unknown> }>
      assert.deepEqual(Object.keys(variants[0]!.properties), ['action', 'name', 'args'], 'a tool call names the tool before its arguments')
      assert.deepEqual(Object.keys(variants.at(-6)!.properties), ['action', 'kind', 'text', 'items', 'expiresAt'])
      assert.ok(accepts(post.body.json_schema, { action: 'tool', name: 'file_read', args: { path: 'src/item.txt', offset: '0' } }))
      assert.equal(accepts(post.body.json_schema, { action: 'tool', name: 'plan', args: {} }), false)
    }
  }
  // Counting is untouched: every dispatched string is a rendering the counter measured, and every evaluated count equalled the exact count.
  const rendered = new Set((await f.fake.requests('/apply-template')).map(r => `<|user|>\n${r.body.messages[0].content}<|end|>\n<|assistant|>\n<think>\n\n</think>\n\n`))
  for (const post of posts) assert.ok(rendered.has(post.body.prompt), 'a dispatched string was counted as is')
  const calls = f.log.readAll(receipt.sessionId!, 'person').filter(e => e.type === 'tool.call').map(e => (e.data as { name: string }).name)
  assert.deepEqual(calls, ['file_read'])
})

test('the same model without the schema answers in the shapes the real runs produced and no item is verified', async t => {
  const f = await fixture(t, { structuredOutput: false }), receipt = await f.starts.start(f.input)
  await until(() => f.relay.read(receipt.runId!).errors >= 3 || f.starts.status(f.input.key).status !== 'running')
  await f.starts.stop(f.input.key)
  const ledger = f.relay.read(receipt.runId!)
  assert.ok(ledger.errors >= 3); assert.equal(ledger.items.one, 'open')
  const posts = await f.fake.requests('/completion')
  assert.ok(posts.length >= 3); assert.ok(posts.every(p => !('json_schema' in p.body)), 'the switch sends no schema')
})

test('a grammar the server rejects stops the run as response_schema_rejected, which is also the recorded reason of the failed call; the server\'s text stays out', async t => {
  const f = await fixture(t, undefined, { rejectSchema: true }), receipt = await f.starts.start(f.input)
  await until(() => f.starts.status(f.input.key).status !== 'running')
  assert.equal(f.starts.status(f.input.key).status, 'input_required')
  assert.deepEqual(f.errors(receipt.sessionId!), ['response_schema_rejected'], 'not probe_failed_twice, not model_failed, not an identity problem')
  const notes = f.log.readAll(receipt.sessionId!, 'person').filter(e => e.type === 'agent.note').map(e => String(e.data.text))
  assert.ok(notes.some(text => text.includes('"relay":"call_failed_reason"') && text.includes('"reason":"response_schema_rejected"') && text.includes('"purpose":"work"')), JSON.stringify(notes.filter(n => n.includes('call_failed'))))
  assert.equal(f.relay.read(receipt.runId!).items.one, 'open')
  assert.equal(JSON.stringify(f.log.readAll(receipt.sessionId!, 'person')).includes('SERVER-GRAMMAR-TEXT'), false)
  assert.equal((await f.fake.requests('/completion')).length, 1, 'the rejected call is not retried')
})
