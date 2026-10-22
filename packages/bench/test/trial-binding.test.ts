import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTrialBinding, nonceHash, trialBindingTag } from '../src/trial-binding.ts'

function input() {
  return {
    experimentId: 'experiment', taskId: 'task', armId: 'candidate', seed: 0,
    runId: 'run', attemptId: 'attempt', sessionId: 'session',
    accountId: 'account', connectionId: 'connection', provider: 'fixture',
    model: 'fixture', modelApi: 'openai-completions', outputTokenLimit: 32,
    toolSource: 'builtin' as const, attempt: { id: 'attempt', run_id: 'run' },
  }
}

test('trial binding generates a fresh frozen nonce and refuses an attempt mismatch or unknown tool source', () => {
  const source = input()
  const first = createTrialBinding(source)
  const second = createTrialBinding(source)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(first.nonce.length >= 40, true)
  assert.notEqual(first.nonce, second.nonce)
  assert.equal(nonceHash(first).length, 64)
  assert.equal(trialBindingTag(first).length, 64)
  source.accountId = 'mutated-after-creation'
  assert.equal(first.accountId, 'account')
  assert.equal(trialBindingTag(first), trialBindingTag(second))
  assert.notEqual(nonceHash(first), nonceHash(second))
  assert.throws(() => createTrialBinding({ ...input(), attemptId: 'other' }), { code: 'binding_attempt_mismatch' })
  assert.throws(() => createTrialBinding({ ...input(), attempt: { id: 'other', run_id: 'run' } }),
    { code: 'binding_attempt_mismatch' })
  assert.throws(() => createTrialBinding({ ...input(), runId: 'other' }), { code: 'binding_attempt_mismatch' })
  assert.throws(() => createTrialBinding({ ...input(), toolSource: 'mcp' as never }), { code: 'binding_invalid' })
  assert.throws(() => createTrialBinding({ ...input(), outputTokenLimit: 0 }), { code: 'binding_invalid' })
  assert.throws(() => createTrialBinding({ ...input(), seed: -1 }), { code: 'binding_invalid' })
})
