import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OllamaChatRequest } from '../../src/ollama/types.ts'
import { LlamaServerClient } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerRuntime } from '../../src/runtime/llama-server/runtime.ts'
import { fakeRender, fakeTokens, startFakeLlama } from '../fixtures/fake-llama-server.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const content = 'Executor transport fixture.'
const rendered = fakeRender(content, { template: 'chat' }, false)
async function fixture(t: { after(fn: () => unknown): void }, state: Parameters<typeof startFakeLlama>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi-expected-transport-')), modelPath = join(directory, 'model.gguf')
  await writeFile(modelPath, 'GGUF-expected-transport')
  const fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, replies: ['{"ok":true}'], ...state })
  const runtime = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: fake.url }), model: 'fixture', countTimeoutMs: 3000 })
  t.after(async () => { await runtime.close(); await fake.close(); await rm(directory, { recursive: true, force: true }) })
  const seen = await runtime.observe(runtime.model, new AbortController().signal)
  const expected = { renderedSha256: sha(rendered), tokens: fakeTokens(rendered, true), digest: seen.digest, contextTokens: 16000 }
  const request: OllamaChatRequest = { model: 'fixture', stream: false, think: false, messages: [{ role: 'user', content }], options: { num_ctx: 16000, num_predict: 500 } }
  const run = (override: Partial<typeof expected> = {}, patch: Partial<OllamaChatRequest> = {}) => {
    const transport = runtime.expectedTransport({ ...expected, ...override }), r = { ...request, ...patch }
    return { transport, result: transport.chat(r, new AbortController().signal, () => undefined, { authorizeDispatch: async () => undefined, prepare: () => r }) }
  }
  return { fake, runtime, expected, run }
}

test('an expected transport evaluates exactly the counted rendering, reports its hash and never blocks on the synchronous bridge', async t => {
  const f = await fixture(t), original = Atomics.wait
  let waits = 0
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => { waits++; return original(...args) }) as typeof Atomics.wait
  try {
    const { transport, result } = f.run()
    const reply = await result
    assert.equal(reply.prompt_eval_count, f.expected.tokens); assert.equal(transport.evidence()?.renderedSha256, f.expected.renderedSha256)
    assert.equal(waits, 0)
  } finally { Atomics.wait = original }
  assert.equal((await f.fake.requests('/completion'))[0]!.body.prompt, rendered)
})

test('each executor-side refusal happens before /completion and records its fixed code', async t => {
  const f = await fixture(t)
  for (const [name, override, patch, expectedCode] of [
    ['rendering hash', { renderedSha256: sha('another rendering') }, {}, 'runtime_counter_mismatch'],
    ['token count', { tokens: f.expected.tokens + 1 }, {}, 'runtime_counter_mismatch'],
    ['model digest', { digest: 'sha256:' + '0'.repeat(64) }, {}, 'runtime_identity_changed'],
    ['counted window', { contextTokens: 8000 }, {}, 'runtime_identity_changed'],
    ['claimed larger window', {}, { options: { num_ctx: 1_000_000, num_predict: 500 } }, 'context_ceiling'],
    ['output beyond the window', {}, { options: { num_ctx: 16000, num_predict: 16000 } }, 'context_ceiling'],
  ] as const) {
    const { transport, result } = f.run(override, patch)
    await assert.rejects(result, new RegExp(expectedCode), name)
    assert.equal(transport.evidence()?.failure, expectedCode, name)
  }
  assert.equal((await f.fake.requests('/completion')).length, 0)
})

test('a reply that evaluated other tokens than were counted is refused after the request', async t => {
  const f = await fixture(t, { evaluatedSkew: 1 }), { transport, result } = f.run()
  await assert.rejects(result)
  assert.equal(transport.evidence()?.failure, 'truncation_protocol'); assert.equal(transport.evidence()?.renderedSha256, undefined)
  assert.equal((await f.fake.requests('/completion')).length, 1)
})
