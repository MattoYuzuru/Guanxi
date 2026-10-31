import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leadDelegateInputSchema, leadWakePacketSchema } from '@guanxi/contract'
import { brief } from './brief.ts'

test('the delegation brief accepts the ADR-0021 lead fields and applies the default policies', () => {
  const { onDeadline, onCancel, ...rest } = brief()
  const parsed = leadDelegateInputSchema.parse(rest)
  assert.deepEqual([parsed.onDeadline, parsed.onCancel], ['wrap_up', 'cancel'])
  assert.deepEqual(parsed.plan.items[0]!.acceptance, ['npm', 'test'])
  assert.ok(onDeadline && onCancel)
})

test('host-owned and unknown fields are refused rather than ignored', () => {
  for (const extra of [{ identity: { accountId: 'a' } }, { constraints: { roots: ['/'] } }, { judges: {} }, { wake: {} }, { resources: {} }, { network: 'open' }, { surprise: 1 }]) {
    assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), ...extra }).success, false, JSON.stringify(extra))
  }
})

test('estimates must cover exactly the plan items and the numbers are bounded and positive', () => {
  assert.ok(leadDelegateInputSchema.safeParse({ ...brief(), estimatesMs: { t1: 60_000 } }).success)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), estimatesMs: { t1: 60_000, t9: 1 } }).success, false)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), estimatesMs: {} }).success, false)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), deadlineMs: 0 }).success, false)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), objective: '' }).success, false)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), objective: 'x'.repeat(4_001) }).success, false)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), definitionOfDone: [] }).success, false)
  assert.equal(leadDelegateInputSchema.safeParse({ ...brief(), plan: { ...brief().plan, base: 'not-a-commit' } }).success, false)
})

test('the wake packet schema is strict', () => {
  const packet = { format: 'guanxi.wake/v1', runId: 'r', wakeSeq: 1, kind: 'resolution', outcome: 'completed',
    child: { runId: 'c', state: 'completed', attempts: 1, costs: [] }, items: [], gates: [], head: null, diffstat: '', handoff: null,
    narrative: '', openQuestions: [], metrics: { cycles: null, tokens: null, moneyMicros: null }, drilldown: [], truncated: [] }
  assert.ok(leadWakePacketSchema.safeParse(packet).success)
  assert.equal(leadWakePacketSchema.safeParse({ ...packet, trace: [] }).success, false, 'no trace field exists')
  assert.equal(leadWakePacketSchema.safeParse({ ...packet, format: 'guanxi.wake/v2' }).success, false)
  assert.equal(leadWakePacketSchema.safeParse({ ...packet, wakeSeq: 0 }).success, false)
})
