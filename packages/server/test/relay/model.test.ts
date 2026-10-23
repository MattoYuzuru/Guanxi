import assert from 'node:assert/strict'
import { test } from 'node:test'
import { window } from './fixture.ts'
import { ConnectionRelayModel } from '../../src/relay/model.ts'
import type { Connections } from '../../src/connections/service.ts'

function local(reply: { message: { content: string }; prompt_eval_count: number; eval_count: number; done_reason: string }) {
  return {
    snapshot: () => ({ connections: [{ id: 'fixture', kind: 'local_runtime' }] }),
    // Like K3: the prepared request is handed to onPrepared before dispatch.
    localChat: async (_scope: string, _id: string, request: unknown, call: { onPrepared?: (r: unknown) => void }) => { call.onPrepared?.(request); return reply },
  } as unknown as Connections
}

const options = { runId: 'fixture', requestId: 'call', maxOutput: 10, maxInput: 14000, window }

test('local done_reason length maps to outputLimited, not input truncation', async () => {
  const model = new ConnectionRelayModel(local({ message: { content: '{}' }, prompt_eval_count: 100, eval_count: 10, done_reason: 'length' }),
    'fixture', 'fixture', { observe: async () => window, count: () => 100 })
  const reply = await model.call('prompt', options)
  assert.equal(reply.outputLimited, true)
  assert.equal(reply.inputTruncated, false)
})

test('local prompt_eval_count mismatch maps to inputTruncated, not outputLimited', async () => {
  const model = new ConnectionRelayModel(local({ message: { content: '{}' }, prompt_eval_count: 99, eval_count: 1, done_reason: 'stop' }),
    'fixture', 'fixture', { observe: async () => window, count: () => 100 })
  const reply = await model.call('prompt', options)
  assert.equal(reply.inputTruncated, true)
  assert.equal(reply.outputLimited, false)
})

test('a local Ollama :cloud model reports unknown cost instead of zero', async () => {
  const model = new ConnectionRelayModel(local({ message: { content: '{}' }, prompt_eval_count: 100, eval_count: 1, done_reason: 'stop' }),
    'fixture', 'llama3:cloud', { observe: async () => window, count: () => 100 })
  const reply = await model.call('prompt', options)
  assert.equal(reply.moneyMicros, null)
})

test('a call that outlasts the runtime observation age is not failed by a recount after it (real executor speed)', async () => {
  let dispatched = false
  const connections = {
    snapshot: () => ({ connections: [{ id: 'fixture', kind: 'local_runtime' }] }),
    localChat: async (_scope: string, _id: string, request: unknown, call: { onPrepared?: (r: unknown) => void }) => {
      call.onPrepared?.(request); dispatched = true
      return { message: { content: '{}' }, prompt_eval_count: 100, eval_count: 10, done_reason: 'stop' }
    },
  } as unknown as Connections
  // The meter refuses once the call has run: its observation went stale while the model was generating.
  const model = new ConnectionRelayModel(connections, 'fixture', 'fixture', { observe: async () => window,
    count: () => { if (dispatched) throw new Error('runtime_observation_stale'); return 100 } })
  const reply = await model.call('prompt', options)
  assert.equal(reply.inputTruncated, false)
  assert.equal(reply.inputTokens, 100)
})

test('a provider (model_api) connection ignores the response schema: its request and call options are exactly what they were', async () => {
  const seen: { context?: unknown; call?: Record<string, unknown> } = {}
  const connections = {
    snapshot: () => ({ connections: [{ id: 'fixture', kind: 'model_api' }] }),
    complete: async (_scope: string, _id: string, context: unknown, call: Record<string, unknown> & { onPrepared?: (r: unknown) => void }) => {
      call.onPrepared?.(context); seen.context = context; seen.call = call
      return { content: [{ type: 'text', text: '{"ok":true}' }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: 'stop' }
    },
  } as unknown as Connections
  const model = new ConnectionRelayModel(connections, 'fixture', 'provider-model', { observe: async () => window, count: () => 10 })
  const schema = { type: 'object', properties: { marker: { const: 'SCHEMA-MARKER' } } }
  const reply = await model.call('prompt', { ...options, responseSchema: schema })
  assert.equal(reply.text, '{"ok":true}')
  assert.equal(JSON.stringify(seen).includes('SCHEMA-MARKER'), false, 'the schema is nowhere in the provider call')
  assert.deepEqual(Object.keys(seen.call!).sort(), ['background', 'model', 'onPrepared', 'onStarted', 'options', 'requestId', 'runId', 'signal'])
})
