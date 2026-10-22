import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { encodePrivateFrame, PrivateFrameDecoder, type PrivateChannelHost } from '../src/private-channel.ts'
import { servePrivateTrialStreams, type PrivateStreamPolicy } from '../src/private-stream.ts'

const policy: PrivateStreamPolicy = { maximumPayloadBytes: 4096, maximumRequests: 3,
  requestTimeoutMs: 1000, maximumInputChunkBytes: 8192, outputTimeoutMs: 100 }
const request = (id = 0) => ({ version: 1, id, operation: 'complete', context: { messages: [{ role: 'user', text: '界 fixture' }], tools: [] } })
const frame = (id = 0) => encodePrivateFrame(request(id), policy.maximumPayloadBytes)
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(write?: (chunk: Buffer, callback: (error?: Error | null) => void) => void) {
  const input = new PassThrough(), frames: Buffer[] = [], abort = new AbortController()
  const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    frames.push(Buffer.from(chunk)); if (write) write(chunk, callback); else callback()
  } })
  let calls = 0, retained = 0
  const result = { role: 'assistant' as const, api: 'openai-completions' as const, provider: 'fixture', model: 'fixture',
    content: [{ type: 'text' as const, text: 'public response' }, { type: 'thinking' as const, thinking: 'private-stream-reasoning' }],
    stopReason: 'stop' as const, timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  const host: PrivateChannelHost = { model: { api: result.api, provider: result.provider, id: result.model },
    gateway: { async complete() { calls++; return { requestId: 'host-request', result } } },
    async retain() { retained++ } }
  return { input, output, frames, abort, host, result, calls: () => calls, retained: () => retained,
    start: (p = policy) => servePrivateTrialStreams(input, output, host, p, abort.signal) }
}

test('stream adapter handles split UTF-8 requests sequentially and emits framed public replies only after retention', async () => {
  const f = fixture(), running = f.start(), bytes = frame()
  for (const byte of bytes) f.input.write(Buffer.from([byte]))
  await turn()
  assert.equal(f.frames.length, 1); assert.equal(f.retained(), 1)
  f.input.write(frame(1)); await turn()
  f.input.end()
  assert.deepEqual(await running, { reason: 'channel_input_ended', responsesDelivered: 2 })
  const decoder = new PrivateFrameDecoder(policy.maximumPayloadBytes)
  const responses = [...decoder.push(Buffer.concat(f.frames))] as Array<{ status: string; id: number }>
  decoder.finish()
  assert.deepEqual(responses.map(response => [response.id, response.status]), [[0, 'ok'], [1, 'ok']])
  assert.equal(Buffer.concat(f.frames).includes(Buffer.from('private-stream-reasoning')), false)
  assert.equal(f.calls(), 2)
})

test('EOF and parent abort reach blocked inference immediately but ownership waits for acknowledgement', async () => {
  for (const mode of ['eof', 'abort']) {
    const f = fixture(), ack = deferred(), entered = deferred()
    let observed: AbortSignal | undefined, settled = false
    f.host.gateway = { async complete(_context, signal) {
      observed = signal; entered.resolve(); await ack.promise; throw new Error('private-provider-exception')
    } }
    const running = f.start().then(value => { settled = true; return value })
    f.input.write(frame()); await entered.promise
    if (mode === 'eof') f.input.end(); else f.abort.abort(new Error('private-abort-reason'))
    await turn()
    assert.equal(observed!.aborted, true); assert.equal(settled, false); assert.equal(f.frames.length, 0)
    ack.resolve()
    assert.equal((await running).reason, mode === 'eof' ? 'channel_input_ended' : 'channel_aborted')
    assert.equal(f.frames.length, 0)
  }
})

test('EOF during private retention waits for its acknowledgement and suppresses the successful reply', async () => {
  const f = fixture(), entered = deferred(), ack = deferred()
  let settled = false
  f.host.retain = async () => { entered.resolve(); await ack.promise }
  const running = f.start().then(value => { settled = true; return value })
  f.input.write(frame()); await entered.promise
  f.input.end(); await turn()
  assert.equal(settled, false); assert.equal(f.frames.length, 0)
  ack.resolve(); assert.equal((await running).responsesDelivered, 0)
  assert.equal(f.frames.length, 0)
})

test('coalesced concurrent requests close the capability without a queued second dispatch', async () => {
  const f = fixture(), ack = deferred()
  let calls = 0, signal: AbortSignal | undefined
  f.host.gateway = { async complete(_context, current) { calls++; signal = current; await ack.promise; return { requestId: 'host', result: f.result } } }
  const running = f.start()
  f.input.write(Buffer.concat([frame(), frame(1)])); await turn()
  assert.equal(calls, 1); assert.equal(signal!.aborted, true)
  ack.resolve()
  assert.deepEqual(await running, { reason: 'channel_request_invalid', responsesDelivered: 0 })
  assert.equal(f.frames.length, 0)
})

test('response delivery remains in flight: second request closes, but a clean input half-close allows the retained response', async () => {
  for (const concurrent of [false, true]) {
    let written!: () => void
    const f = fixture((_chunk, callback) => { written = () => callback() }), running = f.start()
    f.input.write(frame()); await turn()
    assert.equal(typeof written, 'function'); assert.equal(f.retained(), 1)
    if (concurrent) f.input.write(frame(1)); else f.input.end()
    await turn()
    if (!concurrent) written()
    const result = await running
    assert.equal(result.reason, concurrent ? 'channel_request_invalid' : 'channel_input_ended')
    assert.equal(result.responsesDelivered, concurrent ? 0 : 1)
    assert.equal(f.calls(), 1)
    if (concurrent) written() // Late completion is consumed without changing the primary cause.
  }
})

test('output callback backpressure is bounded by explicit policy and late completion is consumed', async () => {
  let late!: () => void
  const f = fixture((_chunk, callback) => { late = () => callback() })
  const running = f.start({ ...policy, outputTimeoutMs: 10 })
  f.input.write(frame())
  const result = await running
  assert.deepEqual(result, { reason: 'channel_output_timeout', responsesDelivered: 0 })
  assert.equal(f.output.destroyed, true); assert.equal(f.input.destroyed, true)
  late(); await turn()
})

test('a failed capability delivers one fixed error frame and closes without exposing its host exception', async () => {
  const f = fixture()
  f.host.gateway = { async complete() { throw new Error('private-host-exception') } }
  const running = f.start()
  f.input.write(frame())
  assert.deepEqual(await running, { reason: 'channel_failed', responsesDelivered: 1 })
  const decoder = new PrivateFrameDecoder(policy.maximumPayloadBytes)
  const decoded = [...decoder.push(Buffer.concat(f.frames))]
  decoder.finish()
  assert.deepEqual(decoded, [{ version: 1, id: 0, status: 'error', code: 'channel_failed' }])
  assert.equal(Buffer.concat(f.frames).includes(Buffer.from('private-host-exception')), false)
  assert.equal(f.input.destroyed, true); assert.equal(f.output.destroyed, true)
})

test('input/output errors and closes map to fixed outcomes without exporting exception messages', async () => {
  for (const mode of ['input-error', 'input-close', 'output-error', 'output-close']) {
    const f = fixture(), running = f.start()
    if (mode === 'input-error') f.input.destroy(new Error('private-input-value'))
    if (mode === 'input-close') f.input.destroy()
    if (mode === 'output-error') f.output.destroy(new Error('private-output-value'))
    if (mode === 'output-close') f.output.destroy()
    assert.equal((await running).reason, { 'input-error': 'channel_input_failed', 'input-close': 'channel_input_closed',
      'output-error': 'channel_output_failed', 'output-close': 'channel_output_closed' }[mode])
    assert.equal(f.frames.length, 0); assert.equal(f.calls(), 0)
  }
  const f = fixture((_chunk, callback) => callback(new Error('private-write-value'))), running = f.start()
  f.input.write(frame())
  assert.equal((await running).reason, 'channel_output_failed')
})

test('malformed, truncated, invalid-selector and oversized input refuse dispatch with bounded fixed errors', async () => {
  for (const mode of ['truncated', 'oversize', 'invalid-json', 'selector', 'chunk', 'string']) {
    const f = fixture(), running = f.start()
    if (mode === 'truncated') f.input.end(frame().subarray(0, 7))
    if (mode === 'oversize') { const header = Buffer.alloc(4); header.writeUInt32BE(4097); f.input.write(header) }
    if (mode === 'invalid-json') f.input.write(Buffer.from([0, 0, 0, 1, 123]))
    if (mode === 'selector') f.input.write(encodePrivateFrame({ ...request(), connectionId: 'foreign' },4096))
    if (mode === 'chunk') f.input.write(Buffer.alloc(8193))
    if (mode === 'string') { f.input.setEncoding('utf8'); f.input.write(frame()) }
    const result = await running
    assert.equal(result.reason, { truncated: 'channel_frame_truncated', oversize: 'channel_frame_too_large',
      'invalid-json': 'channel_frame_invalid', selector: 'channel_request_invalid', chunk: 'channel_input_too_large', string: 'channel_input_invalid' }[mode])
    assert.equal(f.calls(), 0); assert.equal(f.frames.length, 0)
  }
})

test('pre-aborted/closed streams cannot dispatch and mutable transport policy cannot enlarge the active bound', async () => {
  const f = fixture(); f.input.write(frame()); f.abort.abort()
  assert.equal((await f.start()).reason, 'channel_aborted'); assert.equal(f.calls(), 0)
  const closed = fixture(); closed.output.end()
  assert.equal((await closed.start()).reason, 'channel_output_closed'); assert.equal(closed.calls(), 0)
  const mutable = { ...policy, maximumInputChunkBytes: 8 }, other = fixture(), running = other.start(mutable)
  mutable.maximumInputChunkBytes = 8192
  other.input.write(frame())
  assert.equal((await running).reason, 'channel_input_too_large'); assert.equal(other.calls(), 0)
  for (const patch of [{ outputTimeoutMs: 0 }, { maximumInputChunkBytes: 0 }]) {
    const invalid = fixture()
    await assert.rejects(invalid.start({ ...policy, ...patch }), /channel_policy_invalid/)
    invalid.input.destroy(); invalid.output.destroy()
  }
})
