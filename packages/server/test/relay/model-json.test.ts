import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseModelJson } from '../../src/relay/model-json.ts'
import { fixture } from './fixture.ts'

test('model JSON: one Markdown fence is removed, nothing else is repaired', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 })
  assert.deepEqual(parseModelJson('  \n{"a":1}\n '), { a: 1 })
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModelJson('```\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModelJson('\n```json\r\n{\n  "a": [1, 2]\n}\r\n```\n'), { a: [1, 2] })
  for (const bad of ['{action:tool}', '```json\n{"a":1,}\n```', 'Here: {"a":1}', '```json\n{"a":1}\n```\n```json\n{"b":2}\n```', '```json {"a":1}```', ''])
    assert.throws(() => parseModelJson(bad), SyntaxError, bad)
})

test('a relay whose model fences every probe and action still finishes the item (real-model reply shape)', async () => {
  const f = fixture({ fence: true }); try {
    const l = await f.executor.run(f.attempt)
    assert.equal(l.state, 'finish'); assert.equal(l.items.one, 'done')
    const notes = f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note').map(e => String(e.data.text))
    assert.equal(notes.filter(t => t.includes('"relay":"probe"') && t.includes('"correct":false')).length, 0, 'no probe was judged wrong')
  } finally { f.close() }
})
