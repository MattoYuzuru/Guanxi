import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BenchGatewayError } from '../src/k3-gateway.ts'
import { encodePrivateFrame, PrivateFrameDecoder, PrivateTrialChannel, type PrivateChannelHost } from '../src/private-channel.ts'

const policy = { maximumPayloadBytes: 4096, maximumRequests: 2, requestTimeoutMs: 1000 }
const request = (id = 0) => ({ version: 1, id, operation: 'complete', context: { messages: [{ role: 'user', text: 'fixture' }], tools: [] } })
const decode = (frame: Buffer) => { const decoder = new PrivateFrameDecoder(policy.maximumPayloadBytes); const values = [...decoder.push(frame)]; decoder.finish(); return values[0] as Record<string, any> }
function fixture() {
  let calls = 0, retained = 0
  const result = { role: 'assistant' as const, api: 'openai-completions' as const, provider: 'fixture', model: 'fixture',
    content: [{ type: 'thinking' as const, thinking: 'fixture private reasoning', thinkingSignature: 'fixture-private-signature' },
      { type: 'text' as const, text: 'public reply' }, { type: 'toolCall' as const, id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } }],
    stopReason: 'toolUse' as const, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  const host: PrivateChannelHost = { model: { api: 'openai-completions', provider: 'fixture', id: 'fixture' },
    gateway: { async complete() { calls++; return { requestId: `request-${calls}`, result } } },
    async retain(_id, message) { retained++; assert.equal(message, result) } }
  return { host, result, calls: () => calls, retained: () => retained }
}

test('private framing roundtrips split UTF-8 and coalesced frames without exporting framing state', () => {
  const first = encodePrivateFrame({ text: '界😺' }, 4096), second = encodePrivateFrame({ n: 2 }, 4096)
  const bytes = Buffer.concat([first, second]), decoder = new PrivateFrameDecoder(4096), decoded = []
  for (const byte of bytes) decoded.push(...decoder.push(Uint8Array.of(byte)))
  decoder.finish()
  assert.deepEqual(decoded, [{ text: '界😺' }, { n: 2 }])
  assert.throws(() => [...decoder.push(first)], /channel_closed/)
})

test('framing rejects oversized announcements, invalid JSON/UTF-8 and truncated records before dispatch', () => {
  const over = Buffer.alloc(4); over.writeUInt32BE(4097)
  assert.throws(() => [...new PrivateFrameDecoder(4096).push(over)], /channel_frame_too_large/)
  assert.throws(() => encodePrivateFrame({ text: '界' }, 1), /channel_frame_too_large/)
  for (const body of [Buffer.from('{'), Buffer.from([0xff])]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    const decoder = new PrivateFrameDecoder(4096)
    assert.throws(() => [...decoder.push(Buffer.concat([header, body]))], /channel_frame_invalid/)
    assert.throws(() => decoder.finish(), /channel_closed/)
  }
  for (const length of [1, 5]) {
    const decoder = new PrivateFrameDecoder(4096)
    assert.deepEqual([...decoder.push(encodePrivateFrame({ a: 1 }, 4096).subarray(0, length))], [])
    assert.throws(() => decoder.finish(), /channel_frame_truncated/)
  }
})

test('one fixed completion operation emits only text/tool calls after private retention; reasoning stays off the task stream', async () => {
  const f = fixture(), channel = new PrivateTrialChannel(f.host, policy)
  const frame = await channel.handle(request()), response = decode(frame)
  assert.deepEqual(response.message, { text: 'public reply', toolCalls: [{ id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } }], stopReason: 'toolUse' })
  assert.equal(response.requestId, 'request-1'); assert.equal(response.id, 0)
  assert.equal(f.calls(), 1); assert.equal(f.retained(), 1)
  for (const value of ['fixture private reasoning', 'fixture-private-signature', 'thinking', 'usage', 'apiKey']) assert.equal(frame.includes(Buffer.from(value)), false)
  await channel.settled(); channel.close()
  await assert.rejects(channel.handle(request(1)), /channel_closed/)
})

test('foreign selectors, reasoning, invalid operations and reused IDs close capability without another gateway call', async () => {
  for (const patch of [{ connectionId: 'foreign' }, { model: 'foreign' }, { trial: { arm: 'foreign' } },
    { operation: 'snapshot' }, { context: { messages: [{ role: 'assistant', text: '', toolCalls: [], thinking: 'private' }], tools: [] } }]) {
    const f = fixture(), channel = new PrivateTrialChannel(f.host, policy)
    await assert.rejects(channel.handle({ ...request(), ...patch }), /channel_request_invalid/)
    assert.equal(f.calls(), 0); assert.equal(f.retained(), 0)
    await assert.rejects(channel.handle(request()), /channel_closed/)
  }
  const f = fixture(), channel = new PrivateTrialChannel(f.host, policy)
  await channel.handle(request())
  await assert.rejects(channel.handle(request()), /channel_request_invalid/)
  assert.equal(f.calls(), 1)
})

test('private retention acknowledgement precedes any accepted task response', async () => {
  const f = fixture(); let release!: () => void, delivered = false
  f.host.retain = async () => new Promise<void>(resolve => { release = resolve })
  const channel = new PrivateTrialChannel(f.host, policy)
  const pending = channel.handle(request()).then(frame => { delivered = true; return frame })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(typeof release, 'function'); assert.equal(delivered, false)
  release()
  assert.equal(decode(await pending).status, 'ok'); assert.equal(delivered, true)
})

test('text/tool transcript conversion uses copied host catalog identity and no caller billing observation', async () => {
  const f = fixture(); let observed: Parameters<PrivateChannelHost['gateway']['complete']>[0] | undefined
  f.host.gateway = { async complete(context) { observed = context; return { requestId: 'converted', result: f.result } } }
  const channel = new PrivateTrialChannel(f.host, policy)
  f.host.model.id = 'mutated'
  await channel.handle({ ...request(), context: { messages: [
    { role: 'system', text: 'solve' }, { role: 'user', text: 'task' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pwd' } }] },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'shell', text: '/app', isError: false },
  ], tools: [{ name: 'shell', description: 'fixture shell', parameters: { type: 'object' } }] } })
  assert.equal(observed!.messages[2]!.role, 'assistant')
  const assistant = observed!.messages[2]!
  assert.ok(assistant.role === 'assistant')
  assert.equal(assistant.model, 'fixture'); assert.equal(assistant.content[0]!.type, 'toolCall')
  assert.equal(observed!.messages[3]!.role, 'toolResult'); assert.equal(observed!.tools![0]!.name, 'shell')
})

test('request quota and byte ceilings bind before dispatch and copied host policy cannot be enlarged', async () => {
  const f = fixture(), mutable = { ...policy, maximumRequests: 1 }, channel = new PrivateTrialChannel(f.host, mutable)
  mutable.maximumRequests = 99
  await channel.handle(request())
  await assert.rejects(channel.handle(request(1)), /channel_request_invalid/)
  assert.equal(f.calls(), 1)
  const other = fixture(), bounded = new PrivateTrialChannel(other.host, policy)
  await assert.rejects(bounded.handle({ ...request(), context: { messages: [{ role: 'user', text: 'x'.repeat(5000) }], tools: [] } }), /channel_frame_too_large/)
  assert.equal(other.calls(), 0)
})

test('channel close or a concurrent request aborts an active operation and settled waits for its acknowledgement', async () => {
  for (const concurrent of [false, true]) {
    const f = fixture()
    let acknowledged = false, release!: () => void
    f.host.gateway = { async complete(_context, signal) {
      await new Promise<void>(resolve => {
        signal!.addEventListener('abort', () => { release = resolve }, { once: true })
      })
      acknowledged = true
      throw new BenchGatewayError('gateway_model_failed')
    } }
    const channel = new PrivateTrialChannel(f.host, policy), pending = channel.handle(request())
    if (concurrent) await assert.rejects(channel.handle(request(1)), /channel_request_invalid/)
    else channel.close()
    let settled = false
    const waiting = channel.settled().then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false); assert.equal(acknowledged, false)
    release(); const response = decode(await pending); await waiting
    assert.equal(response.status, 'error'); assert.equal(response.code, 'gateway_model_failed')
    assert.equal(acknowledged, true); assert.equal(settled, true); assert.equal(f.retained(), 0)
  }
})

test('timeout reaches the gateway abort signal and never emits a successful task response', async () => {
  const f = fixture(); let aborted = false
  f.host.gateway = { async complete(_context, signal) {
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    throw new Error('fixture-private-timeout-error')
  } }
  const channel = new PrivateTrialChannel(f.host, { ...policy, requestTimeoutMs: 10 })
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const frame = await channel.handle(request())
    assert.equal(decode(frame).status, 'error'); assert.equal(aborted, true)
    assert.equal(frame.includes(Buffer.from('fixture-private-timeout-error')), false)
    await channel.settled()
  } finally { clearInterval(keepAlive) }
})

test('retention or oversized reply failure closes the channel without partial reasoning or a retry', async () => {
  for (const kind of ['retention', 'size']) {
    const f = fixture()
    if (kind === 'retention') f.host.retain = async () => { throw new Error('fixture-private-k2-error') }
    else f.result.content.push({ type: 'text', text: 'x'.repeat(5000) })
    const channel = new PrivateTrialChannel(f.host, policy), frame = await channel.handle(request())
    assert.deepEqual(decode(frame), { version: 1, id: 0, status: 'error', code: 'channel_failed' })
    assert.equal(f.calls(), 1)
    await assert.rejects(channel.handle(request(1)), /channel_closed/)
    assert.equal(frame.includes(Buffer.from('fixture-private')), false)
  }
})

test('an authoritative retainAndProject projection controls the frame and old pure retain hosts stay supported', async () => {
  const f = fixture()
  let retained = 0, projected = 0
  f.host.retain = async () => { retained++ }
  f.host.retainAndProject = async (requestId) => {
    projected++
    assert.equal(requestId, 'request-1')
    return { text: 'projected public', toolCalls: [], stopReason: 'stop',
      reasoning: 'must-not-cross-the-frame' } as never
  }
  const channel = new PrivateTrialChannel(f.host, policy)
  const frame = await channel.handle(request())
  const response = decode(frame)
  assert.deepEqual(response.message, { text: 'projected public', toolCalls: [], stopReason: 'stop' })
  assert.equal(response.requestId, 'request-1')
  assert.equal(projected, 1); assert.equal(retained, 0)
  assert.equal(frame.includes(Buffer.from('must-not-cross-the-frame')), false)
  assert.equal(frame.includes(Buffer.from('fixture private reasoning')), false)
  await channel.settled()
})

test('a failed authoritative projection closes the channel and emits no successful task frame', async () => {
  const f = fixture()
  f.host.retainAndProject = async () => { throw new Error('fixture-private-retention-code') }
  const channel = new PrivateTrialChannel(f.host, policy)
  const frame = decode(await channel.handle(request()))
  assert.equal(frame.status, 'error')
  assert.equal(frame.code, 'channel_failed')
  assert.equal(frame.message, undefined)
  assert.equal(JSON.stringify(frame).includes('fixture-private-retention-code'), false)
  await channel.settled()
})
