import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { LlamaServerClient, LlamaServerError, LLAMA_SERVER_MAX_JSON_BYTES, loopbackOrigin } from '../../src/runtime/llama-server/client.ts'
import { SyncTokenCounter } from '../../src/runtime/llama-server/sync-count.ts'
import { fakeRender, fakeTokens, startFakeLlama } from '../fixtures/fake-llama-server.ts'

const refused = (error: unknown) => error instanceof LlamaServerError && error.code === 'llama_server_refused'
const code = (expected: string) => (error: unknown) => error instanceof LlamaServerError && error.code === expected

test('only a bare loopback http origin with a port is accepted; everything else is refused before any request', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(loopbackOrigin('http://localhost:8080/'), 'http://localhost:8080')
  assert.equal(loopbackOrigin('http://[::1]:8080'), 'http://[::1]:8080')
  for (const bad of ['http://192.168.1.5:8080', 'http://example.com:8080', 'https://127.0.0.1:8080', 'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/?x=1', 'http://127.0.0.1:8080/#f', 'http://127.0.0.1', 'http://0.0.0.0:8080', 'not a url']) {
    assert.throws(() => loopbackOrigin(bad), refused, bad)
    assert.throws(() => new LlamaServerClient({ baseUrl: bad }), refused, bad)
  }
  assert.throws(() => new SyncTokenCounter({ baseUrl: 'http://example.com:1' }), refused)
})

test('props, health, render, tokenize and completion parse the documented shapes and send exactly the counted flags', async t => {
  const fake = await startFakeLlama({ alias: 'a', modelPath: '/m.gguf', nCtx: 4096, buildInfo: 'b1-x' }); t.after(() => fake.close())
  const client = new LlamaServerClient({ baseUrl: fake.url })
  assert.equal(await client.health(), 'ok')
  assert.deepEqual(await client.props(), { modelPath: '/m.gguf', alias: 'a', contextTokens: 4096, slots: 1, buildInfo: 'b1-x' })
  const rendered = await client.render('hello world')
  assert.equal(rendered, fakeRender('hello world', { template: 'chat' }, false))
  assert.deepEqual((await fake.requests('/apply-template'))[0]!.body,
    { messages: [{ role: 'user', content: 'hello world' }], chat_template_kwargs: { enable_thinking: false } })
  assert.equal(await client.countTokens(rendered), fakeTokens(rendered))
  assert.deepEqual((await fake.requests('/tokenize'))[0]!.body, { content: rendered, add_special: true, parse_special: true })
  const done = await client.complete(rendered, 50, new AbortController().signal)
  assert.deepEqual(done, { content: '{}', promptTokens: fakeTokens(rendered), completionTokens: 1, stopType: 'eos', truncated: false })
  assert.deepEqual((await fake.requests('/completion'))[0]!.body, { prompt: rendered, n_predict: 50, stream: false, cache_prompt: true })
  const uncached = await new LlamaServerClient({ baseUrl: fake.url, cachePrompt: false }).complete(rendered, 7, new AbortController().signal)
  assert.equal(uncached.promptTokens, fakeTokens(rendered))
  assert.equal((await fake.requests('/completion')).at(-1)!.body.cache_prompt, false, 'prefix reuse is an explicit option')
  await fake.configure({ loading: true })
  assert.equal(await client.health(), 'loading')
  await assert.rejects(client.complete('x', 0, new AbortController().signal), refused)
})

test('malformed, oversized, non-JSON and redirected answers are protocol or availability failures without leaking text', async t => {
  const fake = await startFakeLlama(); t.after(() => fake.close())
  const client = new LlamaServerClient({ baseUrl: fake.url })
  for (const bad of [{}, { model_path: '', build_info: 'x', default_generation_settings: { n_ctx: 1 } }, { model_path: 'p', build_info: 'x', default_generation_settings: { n_ctx: 0 } },
    { model_path: 'p', build_info: 'x', default_generation_settings: {} }, 'text']) {
    await fake.configure({ propsOverride: bad })
    await assert.rejects(client.props(), code('llama_server_protocol'))
  }
  const hostile = createServer((request, response) => {
    if (request.url === '/props') { response.writeHead(302, { location: 'http://127.0.0.1:1/props' }); return response.end() }
    if (request.url === '/health') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('secret prompt text') }
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"prompt":"'); response.write('x'.repeat(LLAMA_SERVER_MAX_JSON_BYTES)); response.end('"}')
  })
  await new Promise<void>(resolve => hostile.listen(0, '127.0.0.1', resolve)); t.after(() => { hostile.closeAllConnections(); hostile.close() })
  const other = new LlamaServerClient({ baseUrl: `http://127.0.0.1:${(hostile.address() as AddressInfo).port}` })
  await assert.rejects(other.props(), code('llama_server_unavailable'))
  await assert.rejects(other.health(), (error: unknown) => error instanceof LlamaServerError && error.code === 'llama_server_protocol' && !String(error.message).includes('secret'))
  await assert.rejects(other.render('x'), code('llama_server_protocol'))
})

test('an unreachable server, a deadline and an abort are distinct, and abort settles before returning', async t => {
  const closed = await startFakeLlama(); const url = closed.url; await closed.close()
  await assert.rejects(new LlamaServerClient({ baseUrl: url }).props(), code('llama_server_unavailable'))
  const slow = await startFakeLlama({ completionDelayMs: 400 }); t.after(() => slow.close())
  await assert.rejects(new LlamaServerClient({ baseUrl: slow.url, completionTimeoutMs: 100 }).complete('x', 1, new AbortController().signal), code('llama_server_timeout'))
  const controller = new AbortController(), pending = new LlamaServerClient({ baseUrl: slow.url }).complete('x', 1, controller.signal)
  while (await slow.count('/completion') < 2) await new Promise(resolve => setTimeout(resolve, 5))
  controller.abort(new Error('stop'))
  await assert.rejects(pending, /stop/)
  const before = new AbortController(); before.abort()
  await assert.rejects(new LlamaServerClient({ baseUrl: slow.url }).props(before.signal))
})

test('an observer that throws after dispatch aborts and settles the started request before surfacing its own failure', async t => {
  const slow = await startFakeLlama({ completionDelayMs: 300 }); t.after(() => slow.close())
  const client = new LlamaServerClient({ baseUrl: slow.url })
  await assert.rejects(client.complete('x', 1, new AbortController().signal, () => { throw new Error('observer failed') }), /observer failed/)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await slow.aborted(), await slow.count('/completion'), 'every request that reached the server was cut off by the client, none was left running')
  assert.ok(await slow.aborted() <= 1)
})

test('the synchronous counter agrees with the async client, reuses only an identical exact answer and never estimates', async t => {
  const fake = await startFakeLlama(); t.after(() => fake.close())
  const client = new LlamaServerClient({ baseUrl: fake.url }), counter = new SyncTokenCounter({ baseUrl: fake.url, timeoutMs: 2000 }); t.after(() => counter.close())
  for (const text of ['one', 'two words here', 'line\nbreak <|marker|> end', '界 unicode ✓']) {
    assert.equal(counter.count(text), await client.countTokens(await client.render(text)), text)
  }
  const tokenizeCalls = await fake.count('/tokenize')
  assert.equal(counter.count('two words here'), counter.count('two words here'))
  assert.equal(await fake.count('/tokenize'), tokenizeCalls, 'an identical request is answered from the exact cache')
  counter.count('two words here', true)
  assert.equal(await fake.count('/tokenize'), tokenizeCalls + 1, 'a fresh count always asks the server')
  assert.notEqual(counter.count('two words'), counter.count('two words here'))
  counter.clear(); counter.count('two words here')
  assert.equal(await fake.count('/tokenize'), tokenizeCalls + 3)
})

test('a dead, slow or malformed server is a count failure, a later healthy server recovers, and a closed counter refuses', async t => {
  const fake = await startFakeLlama({ tokenizeDelayMs: 1500 }); t.after(() => fake.close())
  const counter = new SyncTokenCounter({ baseUrl: fake.url, timeoutMs: 200 }); t.after(() => counter.close())
  assert.throws(() => counter.count('slow'), /runtime_count_invalid/)
  await fake.configure({ tokenizeDelayMs: 0 })
  assert.equal(counter.count('slow'), fakeTokens(fakeRender('slow', { template: 'chat' }, false)))
  const url = fake.url; await fake.close()
  assert.throws(() => counter.count('server is gone'), /runtime_count_invalid/)
  const hostile = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"prompt":5}') })
  await new Promise<void>(resolve => hostile.listen(0, '127.0.0.1', resolve)); t.after(() => { hostile.closeAllConnections(); hostile.close() })
  const odd = new SyncTokenCounter({ baseUrl: `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`, timeoutMs: 500 })
  assert.throws(() => odd.count('x'), /runtime_count_invalid/)
  await odd.close(); assert.throws(() => odd.count('x'), /runtime_count_invalid/)
  assert.ok(url)
})
