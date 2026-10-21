import assert from 'node:assert/strict'
import { test } from 'node:test'
import { window } from './fixture.ts'
import { ConnectionRelayModel } from '../../src/relay/model.ts'
import type { Connections } from '../../src/connections/service.ts'

function local(reply: { message: { content: string }; prompt_eval_count: number; eval_count: number; done_reason: string }) {
  return {
    snapshot: () => ({ connections: [{ id: 'fixture', kind: 'local_runtime' }] }),
    localChat: async () => reply,
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
