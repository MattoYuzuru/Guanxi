import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SIDE_CHAT_SAVE_MAX_BYTES, encodeSideChatSavedNote, parseSideChatSavedNote, sideChatErrorSchema, sideChatRespondRequestSchema, sideChatSaveRequestSchema, sideChatSendRequestSchema,
} from '@guanxi/contract'

const id = '11111111-1111-4111-8111-111111111111'
test('side-chat requests are strict, end on a user question and carry an explicit context choice', () => {
  const ok = { requestId: id, messages: [{ role: 'user', text: 'q' }], context: { include: 'session', lastTurns: 3 } }
  assert.equal(sideChatRespondRequestSchema.safeParse(ok).success, true)
  assert.equal(sideChatRespondRequestSchema.safeParse({ ...ok, context: { include: 'none' } }).success, true)
  for (const bad of [
    { ...ok, messages: [] }, { ...ok, messages: [{ role: 'assistant', text: 'a' }] }, { ...ok, messages: [{ role: 'user', text: '   ' }] },
    { ...ok, messages: [{ role: 'system', text: 'x' }] }, { ...ok, requestId: 'nope' }, { ...ok, extra: 1 },
    { ...ok, context: { include: 'session', lastTurns: 0 } }, { ...ok, context: { include: 'none', lastTurns: 1 } }, { ...ok, context: { include: 'everything' } },
  ]) assert.equal(sideChatRespondRequestSchema.safeParse(bad).success, false, JSON.stringify(bad))
  assert.equal(sideChatSaveRequestSchema.safeParse({ operationId: id, messages: [{ role: 'assistant', text: 'a' }] }).success, true)
  assert.equal(sideChatSaveRequestSchema.safeParse({ operationId: id, messages: [] }).success, false)
  assert.equal(sideChatSendRequestSchema.safeParse({ operationId: id, text: 'go' }).success, true)
  assert.equal(sideChatSendRequestSchema.safeParse({ operationId: id, text: ' ' }).success, false)
  assert.equal(sideChatSendRequestSchema.safeParse({ operationId: id, text: 'go', session: 'x' }).success, false)
})
test('a saved side chat round-trips and no other agent note is mistaken for one', () => {
  const messages = [{ role: 'user' as const, text: 'q "quoted"\nline' }, { role: 'assistant' as const, text: 'a' }]
  assert.deepEqual(parseSideChatSavedNote(encodeSideChatSavedNote(id, messages)), { sideChat: 'saved', operationId: id, messages })
  assert.equal(encodeSideChatSavedNote(id, messages), encodeSideChatSavedNote(id, [...messages]), 'canonical')
  for (const other of ['plain note', '{"relay":"cap"}', '{"sideChat":"saved"}', '{"sideChat":"other","operationId":"x","messages":[]}', '']) {
    assert.equal(parseSideChatSavedNote(other), null, other)
  }
  assert.equal(sideChatErrorSchema.safeParse({ code: 'context_too_large', details: { bytes: 2, boundBytes: 1, windowTokens: 1, outputTokens: 0, source: 's' } }).success, true)
  assert.equal(sideChatErrorSchema.safeParse({ code: 'unknown' }).success, false)
  for (const code of ['budget_exhausted', 'too_many_requests']) assert.equal(sideChatErrorSchema.safeParse({ code }).success, true, code)
  assert.equal(sideChatErrorSchema.safeParse({ code: 'too_large', details: { bytes: 2, boundBytes: 1 } }).success, true)
  assert.equal(sideChatErrorSchema.safeParse({ code: 'too_large', details: { bytes: 2 } }).success, false)
  assert.equal(SIDE_CHAT_SAVE_MAX_BYTES, 256 * 1024)
})
