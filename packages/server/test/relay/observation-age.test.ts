import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical } from '../../src/relay/handoff.ts'
import { RelayError } from '../../src/relay/types.ts'
import { fixture, plan, window } from './fixture.ts'

const MAX_AGE_MS = 60_000, CALL_MS = 120_000
const item = (id: string, dependsOn: string[]) => ({ id, title: id, dependsOn, acceptance: ['true'], protectedPaths: ['tests'] })
const pair = { ...plan, items: [item('b', ['a']), item('a', [])] }
/** verify a, hand off (the next cycle opens with probes), verify b. */
const script = () => { let n = 0; return () => { n++; return canonical(n === 1 ? { action: 'verify', item: 'a' } : n === 3 ? { action: 'verify', item: 'b' } : { action: 'handoff' }) } }

/** A meter that behaves like the real one: an exact count is valid only while the last observation is at most MAX_AGE_MS old, an observation
 * refreshes it, and dispatch observes again right before the request (K3 `authorizeDispatch`). Every call takes CALL_MS, as a slow executor does. */
function aging(f: ReturnType<typeof fixture>, async: boolean) {
  const seen = { now: 0, observed: 0, counts: 0, observations: 0, oldest: 0 }
  const stale = () => {
    seen.counts++; seen.oldest = Math.max(seen.oldest, seen.now - seen.observed)
    if (seen.now - seen.observed > MAX_AGE_MS) throw new RelayError('runtime_observation_stale')
  }
  const count = f.model.count.bind(f.model), call = f.model.call.bind(f.model)
  f.model.observe = async () => { seen.observed = seen.now; seen.observations++; return window }
  f.model.count = text => { stale(); return count(text) }
  if (async) f.model.countAsync = async text => { stale(); return count(text) }
  f.model.call = async (prompt, options) => {
    seen.observed = seen.now   // authorizeDispatch observes the runtime immediately before the request
    const reply = await call(prompt, options)
    seen.now += CALL_MS
    return reply
  }
  return seen
}

for (const async of [false, true]) {
  test(`a count after a call that took longer than the observation age refreshes the observation first (${async ? 'asynchronous' : 'synchronous'} exact meter)`, async () => {
    const f = fixture({ plan: pair, exact: true, actions: script(), caps: { cycles: 4 } }), seen = aging(f, async)
    try {
      await f.executor.run(f.attempt)
      const errors = f.log.readAll(f.run.session_id, 'person').flatMap(e => e.type === 'error' ? [(e.data as { code: string }).code] : [])
      assert.deepEqual(errors, [], 'not runtime_observation_stale, not anything else')
      assert.deepEqual(f.relay.read(f.run.id).items, { b: 'done', a: 'done' })
      assert.ok(seen.now >= 4 * CALL_MS, 'many calls, each longer than the observation age')
      assert.ok(seen.counts > 10 && seen.oldest <= MAX_AGE_MS, `every count saw an observation at most ${MAX_AGE_MS} ms old (${seen.oldest})`)
    } finally { f.close() }
  })
}

test('a second probe attempt, packed after a first one that took longer than the observation age, observes before it counts', async () => {
  const f = fixture({ plan: pair, exact: true, actions: script(), caps: { cycles: 4 } }), seen = aging(f, false)
  const call = f.model.call.bind(f.model)
  let wrong = true
  f.model.call = async (prompt, options) => {
    const reply = await call(prompt, options)
    // The first probe of the run is answered wrongly, which makes the executor pack and send a second one.
    if (wrong && prompt.startsWith('Answer these five')) { wrong = false; return { ...reply, text: '{}' } }
    return reply
  }
  try {
    await f.executor.run(f.attempt)
    const codes = f.log.readAll(f.run.session_id, 'person').flatMap(e => e.type === 'error' ? [(e.data as { code: string }).code] : [])
    assert.deepEqual(codes, []); assert.equal(wrong, false)
    assert.deepEqual(f.relay.read(f.run.id).items, { b: 'done', a: 'done' }); assert.ok(seen.oldest <= MAX_AGE_MS)
  } finally { f.close() }
})
