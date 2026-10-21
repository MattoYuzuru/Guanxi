import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request, thresholds, boundary, upperTokens, type Measure } from '../../src/relay/budget.ts'
import { fixture, reserves, window } from './fixture.ts'
import { canonical } from '../../src/relay/handoff.ts'

test('reserve formulas use actual W, including 32k and 64k boundary rules', () => {
  const t = thresholds(window, reserves)
  assert.equal(t.H, window.tokens - reserves.turn - reserves.safety)
  assert.equal(t.hard, t.H - reserves.handoff - reserves.tool)
  assert.equal(t.soft, Math.min(.75 * window.tokens, t.hard - reserves.stepMedian, reserves.effective))
  for (const W of [32000, 64000]) {
    const x = thresholds({ ...window, tokens: W }, reserves)
    assert.equal(x.W, W); assert.equal(boundary(x, x.hard, false, 0), true)
    assert.equal(boundary(x, Math.max(.5 * W, x.soft - 1000), true, 1000), true)
  }
  assert.throws(() => thresholds({ ...window, tokens: 100 }, reserves), /window_too_small/)
})
test('randomized prompts, notes and tool outputs never exceed H in a rejecting fixture runtime', async () => {
  const f = fixture(); try {
    let seed = 0x12345678
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
    for (let i = 0; i < 250; i++) {
      const w = { ...window, tokens: 8000 + random() % 100000 }
      const t = thresholds(w, { ...reserves, effective: w.tokens })
      const parts = [0,1,2].map(() => 'Ж'.repeat(random() % 300000))
      const measure: Measure = Object.assign((value: string) => upperTokens(value, w), { exact: false })
      const prompt = request('fixture prompt ' + 'x'.repeat(random() % 1000), { turns: parts }, measure, t.H).text
      assert.ok(upperTokens(prompt, w) <= t.H, `seed ${seed}`)
      const reply = await f.model.call(prompt, { runId: f.run.id, requestId: String(i), maxOutput: 100, maxInput: t.H, window: w })
      assert.ok(reply.inputTokens <= t.H)
    }
    assert.throws(() => request('x'.repeat(20000), {}, Object.assign((value: string) => upperTokens(value, window), { exact: false }), 1000), /context_ceiling/)
  } finally { f.close() }
})
test('the exact-tokenizer measure never packs a request above H', () => {
  let seed = 0x9e3779b9
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  for (let i = 0; i < 250; i++) {
    const w = { ...window, tokens: 8000 + random() % 100000 }
    const t = thresholds(w, { ...reserves, effective: w.tokens })
    const measure: Measure = Object.assign((value: string) => Math.ceil(Buffer.byteLength(value) / 4) + w.framingTokens, { exact: true })
    const head = 'head ' + 'y'.repeat(random() % 4000)
    const turns = [0,1,2,3].map(() => 'Ж'.repeat(random() % 300000) + 'tail' + random())
    const packed = request('fixture exact prompt ' + 'x'.repeat(random() % 1000), { head: [head], turns }, measure, t.H)
    assert.ok(measure(packed.text) <= t.H, `seed ${seed}`)
  }
})
test('oversize counter refuses dispatch; prompt_eval_count truncation is a protocol failure', async () => {
  const f = fixture(); try {
    f.model.count = () => 100000
    await f.executor.run(f.attempt)
    assert.equal(f.prompts.length, 0)
    assert.ok(f.log.readAll(f.run.session_id, 'person').some(e => e.type === 'error' && e.data.code === 'context_ceiling'))
    assert.equal(f.store.get(f.run.id).state, 'input_required')
  } finally { f.close() }
  const g = fixture(); try {
    const call = g.model.call
    g.model.call = async (p,o) => ({ ...await call(p,o), truncated: true })
    await g.executor.run(g.attempt)
    assert.equal(g.prompts.length, 1)
    assert.ok(g.log.readAll(g.run.session_id, 'person').some(e => e.type === 'error' && e.data.code === 'truncation_protocol'))
  } finally { g.close() }
})
test('long wall caps rearm across timer limits and clock changes, and cancellation owns the timer', async () => {
  const {wallDeadline}=await import('../../src/relay/budget.ts')
  let now=0, expires=0, cancelled=0, delay=0, tick=()=>{}
  const end=5_000_000_000
  const stop=wallDeadline(()=>end-now,()=>{expires++},(fn,ms)=>{tick=fn;delay=ms;return()=>{cancelled++}})
  assert.equal(delay,2**31-1)
  now=delay;tick();assert.equal(expires,0);assert.equal(delay,2**31-1)
  now=-1000;tick();assert.equal(expires,0);assert.equal(delay,2**31-1)
  now=end;tick();assert.equal(expires,1)
  stop();tick();assert.equal(expires,1);assert.equal(cancelled,1)
})
test('invalid monetary bounds refuse model dispatch rather than weakening a normative cap', async () => {
  const f=fixture({caps:{moneyMicros:100}})
  try {
    f.model.maxCostMicros=()=>-1
    await f.executor.run(f.attempt)
    assert.equal(f.prompts.length,0)
    assert.equal(f.store.get(f.run.id).state,'input_required')
  } finally {f.close()}
})
