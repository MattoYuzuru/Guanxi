import assert from 'node:assert/strict'
import { test } from 'node:test'
import { thresholds } from '../../src/relay/budget.ts'
import { canonical, probes } from '../../src/relay/handoff.ts'
import { actionResponseSchema, GENERIC_TOOLS, LOCAL_TOOLS, probeResponseSchema, workPrompt, type RelayToolSpec } from '../../src/relay/response-schemas.ts'
import type { JsonSchema } from '../../src/relay/json-schema.ts'
import type { RelayModel } from '../../src/relay/model.ts'
import { fixture, plan, reserves, window } from './fixture.ts'
import { accepts } from './schema-check.ts'

const FILE_READ: RelayToolSpec = { name: 'file_read', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'string' } }, additionalProperties: false } }
const SHELL: RelayToolSpec = { name: 'shell', parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } }, additionalProperties: false } }
const item = (id: string, dependsOn: string[]) => ({ id, title: id, dependsOn, acceptance: ['true'], protectedPaths: ['tests'] })
/** The first listed item is blocked by the second, which is blocked by the third: the next item is not the first one in plan order. */
const twoItems = { ...plan, items: [item('c', ['b']), item('b', ['a']), item('a', [])] }
const pair = { ...plan, items: [item('b', ['a']), item('a', [])] }
const purpose = (prompt: string) => prompt.startsWith('Execute') ? 'work' : prompt.startsWith('Answer these five') ? 'probe' : prompt.startsWith('Write a fresh') ? 'narrative' : 'other'
/** verify a, hand off (the next cycle opens with the probes), then verify b and keep handing off. */
const script = () => { let n = 0; return () => { n++; return canonical(n === 1 ? { action: 'verify', item: 'a' } : n === 3 ? { action: 'verify', item: 'b' } : { action: 'handoff' }) } }
function record(model: RelayModel) {
  const calls: Array<{ purpose: string; schema: JsonSchema | undefined }> = [], original = model.call.bind(model)
  model.call = (prompt, options) => { calls.push({ purpose: purpose(prompt), schema: options.responseSchema }); return original(prompt, options) }
  return calls
}

test('probes ask for the probe schema, work steps for the action schema over the workspace tools, the narrative for none; the switch turns all of it off', async () => {
  const f = fixture({ plan: twoItems, tools: [FILE_READ, SHELL], actions: script() }), calls = record(f.model)
  try {
    await f.executor.run(f.attempt)
    assert.deepEqual(f.executor.tools.map(t => t.name), ['work.query', 'notes.search', 'file_read', 'shell'], 'the executor\'s ledger queries plus exactly what the workspace lists')
    const by = (p: string) => calls.filter(c => c.purpose === p)
    assert.ok(by('probe').length >= 1 && by('work').length >= 3 && by('narrative').length >= 1)
    for (const call of by('probe')) assert.deepEqual(call.schema, probeResponseSchema())
    for (const call of by('work')) assert.deepEqual(call.schema, actionResponseSchema(f.executor.tools))
    for (const call of by('narrative')) assert.equal(call.schema, undefined, 'the prose handoff stays unconstrained')
  } finally { f.close() }
  const off = fixture({ plan: twoItems, actions: script(), limits: { structuredOutput: false } }), offCalls = record(off.model)
  try {
    await off.executor.run(off.attempt)
    assert.ok(offCalls.length >= 5); assert.ok(offCalls.every(c => c.schema === undefined), 'no schema anywhere when the switch is off')
  } finally { off.close() }
  // A workspace that lists no tools is offered the usual names, and the prompt says so.
  const generic = fixture({ actions: script() })
  try { assert.deepEqual(generic.executor.tools.map(t => t.name), [...LOCAL_TOOLS, ...GENERIC_TOOLS].map(t => t.name)) } finally { generic.close() }
})

test('the work prompt is generated from the tools the workspace serves', async () => {
  const f = fixture({ tools: [FILE_READ, SHELL], actions: () => canonical({ action: 'handoff' }) })
  try {
    await f.executor.run(f.attempt)
    const prompts = f.prompts.filter(p => purpose(p) === 'work')
    assert.ok(prompts.length >= 1)
    for (const prompt of prompts) {
      assert.ok(prompt.startsWith(workPrompt(f.executor.tools)))
      assert.ok(prompt.includes('work.query(offset?), notes.search(query, offset?), file_read(path, offset?), shell(command).'))
      assert.equal(prompt.includes('file_write'), false)
    }
  } finally { f.close() }
})

test('a model that answers in every shape the first real runs produced finishes only when the schema reaches it', async () => {
  const unquoted = (text: string) => text.replaceAll('"', '')
  const tagged = () => `I'll read the rest...\n\n<tool_call>\n{"name":"file_read","args":{"path":"SPEC.md","offset":120}}\n</parameter>\n</tool_call>`
  const wrongProbe = (text: string) => canonical({ ...JSON.parse(text), nextItem: null, nextStatus: 'completed' })
  const run = async (limits: { structuredOutput: boolean }) => {
    const f = fixture({ plan: pair, tools: [FILE_READ, SHELL], actions: script(), limits, caps: { cycles: 4 } })
    let bad = 0, conforming = 0
    const original = f.model.call.bind(f.model)
    f.model.call = async (prompt, options) => {
      const reply = await original(prompt, options), kind = purpose(prompt)
      if (kind === 'narrative') return reply
      if (options.responseSchema) {
        // What a grammar-constrained runtime guarantees; the fixture only has to prove the schema it was handed admits its own reply.
        assert.ok(accepts(options.responseSchema, JSON.parse(reply.text)), `${kind}: ${reply.text}`); conforming++
        return reply
      }
      bad++
      return { ...reply, text: kind === 'probe' ? wrongProbe(reply.text) : bad % 2 ? unquoted(reply.text) : tagged() }
    }
    try {
      await f.executor.run(f.attempt)
      const ledger = f.relay.read(f.run.id)
      const codes = f.log.readAll(f.run.session_id, 'person').flatMap(e => e.type === 'error' ? [(e.data as { code: string }).code] : [])
      return { items: ledger.items, errors: ledger.errors, bad, conforming, codes, probeNotes: f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note' && String(e.data.text).includes('"relay":"probe"')).length }
    } finally { f.close() }
  }
  const constrained = await run({ structuredOutput: true })
  assert.equal(constrained.items.a, 'done'); assert.equal(constrained.items.b, 'done')
  assert.equal(constrained.bad, 0); assert.ok(constrained.conforming >= 5); assert.equal(constrained.errors, 0)
  const unconstrained = await run({ structuredOutput: false })
  assert.ok(unconstrained.bad >= 3)
  assert.equal(unconstrained.items.a, 'open', 'not one item was verified')
  assert.ok(unconstrained.errors >= 3, 'invalid actions are counted')
  assert.ok(unconstrained.codes.includes('probe_failed_twice') || unconstrained.codes.includes('no_progress'), JSON.stringify(unconstrained.codes))
})

test('the probe prompt and its excerpt carry every fact the answers need, and the wrong answers of the first real runs stay wrong', async () => {
  const f = fixture({ plan: twoItems, actions: script() })
  const seen: string[] = [], original = f.model.call.bind(f.model)
  f.model.call = (prompt, options) => { if (purpose(prompt) === 'probe') seen.push(prompt); return original(prompt, options) }
  try {
    await f.executor.run(f.attempt)
    assert.ok(seen.length >= 1)
    const sealed = (cycle: number) => f.db.prepare('SELECT ledger FROM relay_seals WHERE run_id=? AND cycle=?').get(f.run.id, cycle) as { ledger: string } | undefined
    // The reader applies only what the prompt text defines to what the prompt text contains.
    const read = (prompt: string) => {
      const lines = prompt.split('\n'), handoff = JSON.parse(lines.find(l => l.startsWith('{"attemptId"'))!), open = (JSON.parse(lines.find(l => l.startsWith('{"open"'))!) as { open: Array<{ id: string; status: string; dependsOn: string[] }> }).open
      const openIds = new Set(open.map(o => o.id)), next = open.find(o => o.dependsOn.every(d => !openIds.has(d)))
      return { ledgerHash: handoff.ledgerHash, head: handoff.ledger.head, revision: handoff.ledger.revision, nextItem: next?.id ?? null, nextStatus: next?.status ?? null }
    }
    const [first] = seen, cycle = JSON.parse(first!.split('\n').find(l => l.startsWith('{"attemptId"'))!).cycle as number
    const expected = probes(JSON.parse(sealed(cycle)!.ledger))
    assert.deepEqual(read(first!), expected)
    assert.equal(expected.nextItem, 'b', 'a is done, c (listed first) waits for b: the next item is the first one whose dependencies are done')
    assert.equal(expected.nextStatus, 'open')
    assert.equal(first!.includes('"strip"'), true)
  } finally { f.close() }
  // The bar is unchanged: the answers that failed the real runs still fail it.
  const wrong = fixture({ plan: twoItems, actions: script() }), original2 = wrong.model.call.bind(wrong.model)
  wrong.model.call = async (prompt, options) => {
    const reply = await original2(prompt, options)
    return purpose(prompt) === 'probe' ? { ...reply, text: canonical({ ...JSON.parse(reply.text), nextItem: null, nextStatus: 'completed' }) } : reply
  }
  try {
    await wrong.executor.run(wrong.attempt)
    const codes = wrong.log.readAll(wrong.run.session_id, 'person').flatMap(e => e.type === 'error' ? [(e.data as { code: string }).code] : [])
    assert.ok(codes.includes('probe_failed_twice'), JSON.stringify(codes))
  } finally { wrong.close() }
})

test('a tool page is sized to the executor\'s per-turn bound, so nothing the cursor says was read is cut', async () => {
  const budget = Math.floor(thresholds(window, reserves).hard / 4)
  const pages: Array<number | undefined> = []
  let n = 0
  const f = fixture({ tools: [FILE_READ], actions: () => (++n === 1 ? canonical({ action: 'tool', name: 'file_read', args: { path: 'big' } }) : canonical({ action: 'handoff' })) })
  const original = f.workspace.tool
  f.workspace.tool = async (name, args, signal, options) => { pages.push(options?.pageBytes); return original(name, { ...args, output: JSON.stringify({ more: true, nextOffset: 9, text: 'p'.repeat(budget - 40) }) }, signal, options) }
  try {
    await f.executor.run(f.attempt)
    assert.deepEqual(pages, [budget])
    const follow = f.prompts.filter(p => purpose(p) === 'work')[1]!
    assert.ok(follow.includes('p'.repeat(budget - 40)), 'a result within the budget reaches the model whole')
    assert.equal(follow.includes('[use paging]'), false)
  } finally { f.close() }
})
