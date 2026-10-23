import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, reserves, window } from './fixture.ts'
import { canonical } from '../../src/relay/handoff.ts'
import { thresholds } from '../../src/relay/budget.ts'

const tokenCount = (text: string) => Math.ceil(Buffer.byteLength(text) / 4)
const notes = (f: ReturnType<typeof fixture>) => f.log.readAll(f.run.session_id, 'person')
  .filter(e => e.type === 'agent.note').map(e => String(e.data.text))

function toolRun(output: (n: number) => string) {
  let n = 0
  return {
    turn: () => ++n,
    actions: () => {
      const call = ++n
      if (call > 40) return canonical({ action: 'handoff' })
      return canonical({ action: 'tool', name: 'echo', args: { output: output(call) } })
    },
  }
}

test('byte-counted packing winds down on the same measure and keeps the latest tool result', async () => {
  const run = toolRun(n => `MARK${n}:` + 'x'.repeat(2500))
  const f = fixture({ count: tokenCount, actions: run.actions })
  try {
    let latest = '', checked = 0
    const tool = f.workspace.tool
    f.workspace.tool = async (name, args, signal) => {
      const result = 'RESULT:' + await tool(name, args, signal)
      latest = result
      return result
    }
    const call = f.model.call
    f.model.call = async (prompt, options) => {
      if (prompt.startsWith('Execute') && latest) { checked++; assert.ok(prompt.includes(latest), `missing ${latest}`) }
      const reply = await call(prompt, options)
      if (prompt.startsWith('Write a fresh')) latest = ''
      return reply
    }
    const l = await f.executor.run(f.attempt)
    assert.notEqual(l.state, 'work')
    assert.ok(notes(f).some(text => text.includes('"state":"wind_down"')), 'wind_down was emitted')
    assert.ok(f.prompts.filter(p => p.startsWith('Execute')).length > 1)
    assert.ok(checked > 0, 'the latest tool result was checked')
    assert.ok(run.turn() <= 41)
  } finally { f.close() }
})

test('exact tokenizer packing winds down and no dispatched prompt exceeds H', async () => {
  const run = toolRun(n => `MARK${n}:` + 'x'.repeat(2500))
  const f = fixture({ exact: true, count: tokenCount, actions: run.actions })
  try {
    const t = thresholds(window, reserves)
    const measure = (text: string) => f.model.count(f.scrubber.scrub(text)) + window.framingTokens
    let latest = '', checked = 0
    const tool = f.workspace.tool
    f.workspace.tool = async (name, args, signal) => {
      const result = 'RESULT:' + await tool(name, args, signal)
      latest = result
      return result
    }
    const call = f.model.call
    f.model.call = async (prompt, options) => {
      assert.ok(measure(prompt) <= t.H, `dispatch ${measure(prompt)} > ${t.H}`)
      if (prompt.startsWith('Execute') && latest) { checked++; assert.ok(prompt.includes(latest), `missing ${latest}`) }
      const reply = await call(prompt, options)
      if (prompt.startsWith('Write a fresh')) latest = ''
      return reply
    }
    const l = await f.executor.run(f.attempt)
    assert.notEqual(l.state, 'work')
    assert.ok(notes(f).some(text => text.includes('"state":"wind_down"')), 'wind_down was emitted')
    assert.ok(f.prompts.filter(p => p.startsWith('Execute')).length > 1)
    assert.ok(checked > 0, 'the latest tool result was checked')
    assert.ok(run.turn() <= 41)
  } finally { f.close() }
})

test('a dropped older turn emits context_dropped and becomes the boundary', async () => {
  let n = 0
  const f = fixture({ count: tokenCount, reserves: { stepMedian: 100 }, actions: () => {
    const call = ++n
    if (call > 3) return canonical({ action: 'handoff' })
    return canonical({ action: 'tool', name: 'echo', args: { output: 'x'.repeat(2600) } })
  } })
  try {
    await f.executor.run(f.attempt)
    const emitted = notes(f)
    const dropped = emitted.find(text => text.includes('"relay":"context_dropped"'))
    assert.ok(dropped, 'context_dropped note')
    assert.match(dropped!, /"dropped":[1-9]/)
    assert.ok(emitted.some(text => text.includes('"state":"wind_down"')))
  } finally { f.close() }
})
