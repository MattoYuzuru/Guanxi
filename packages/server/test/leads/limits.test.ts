import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOUR, brief, leadFixture } from './helpers.ts'

const limits = { maxCaps: { cycles: 10, tokens: 1_000_000, moneyMicros: 5_000_000, wallMs: 4 * HOUR }, maxDeadlineMs: 12 * HOUR }
const within = { cycles: 5, tokens: 500_000, moneyMicros: 1_000_000, wallMs: 2 * HOUR }

test('the owner\'s ceilings refuse a brief before the lead is stopped, with a typed content-free answer', async t => {
  const cases: [string, ReturnType<typeof brief>, string][] = [
    ['null cycles', brief({ caps: { ...within, cycles: null } }), 'caps.cycles'],
    ['null tokens', brief({ caps: { ...within, tokens: null } }), 'caps.tokens'],
    ['null money', brief({ caps: { ...within, moneyMicros: null } }), 'caps.moneyMicros'],
    ['null wall', brief({ caps: { ...within, wallMs: null } }), 'caps.wallMs'],
    ['cap above ceiling', brief({ caps: { ...within, tokens: 1_000_001 } }), 'caps.tokens'],
    ['deadline above ceiling', brief({ caps: within, deadlineMs: 12 * HOUR + 1 }), 'deadlineMs'],
    ['detach on cancel', brief({ caps: within, onCancel: 'detach' }), 'onCancel'],
    ['detach at the deadline', brief({ caps: within, onDeadline: 'detach' }), 'onDeadline'],
  ]
  for (const [name, refused, field] of cases) {
    const f = await leadFixture(t, { lead: { briefs: [refused] }, plugin: { limits } })
    const { runId, first } = f.start()
    assert.equal((await first).outcome, 'completed', name)
    const answer = (await f.events()).find(e => e.event === 'tool_answer')!
    assert.deepEqual([answer.isError, answer.text], [true, `delegation_exceeds_policy: ${field}`], name)
    assert.equal(f.runs().promises(runId).length, 0, name)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lead_delegations').get()!.n, 0, `${name}: no intent`)
    assert.equal(f.children.launches.length, 0, name)
  }
})

test('a brief inside the ceilings delegates, the owner\'s cancel always cancels the child, and validateExecutor sees the whole brief', async t => {
  const seen: unknown[] = []
  const f = await leadFixture(t, { lead: { briefs: [brief({ caps: within, deadlineMs: 12 * HOUR })] },
    plugin: { limits, validateExecutor: (_executor: unknown, _owner: string, whole?: unknown) => { seen.push(whole) } } })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  assert.equal((seen[0] as { caps: unknown }).caps !== undefined && (seen[0] as { deadlineMs: number }).deadlineMs === 12 * HOUR, true, 'the executor check receives caps and deadline, not only the connection')
  assert.equal(f.runs().promises(runId)[0]!.cancel_policy, 'cancel')
  await f.lead().cancel(runId)
  assert.equal(f.runs().get(f.children.launches[0]!.childRunId).state, 'canceled')
  assert.deepEqual(f.children.stops, [f.children.launches[0]!.childRunId])
})

test('detach is possible only when the owner allows it', async t => {
  const f = await leadFixture(t, { lead: { briefs: [brief({ caps: within, onCancel: 'detach' })] }, plugin: { limits: { ...limits, allowDetach: true } } })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  assert.equal(f.runs().promises(runId)[0]!.cancel_policy, 'detach')
})

test('malformed owner ceilings are refused when the service is built', async t => {
  await assert.rejects(leadFixture(t, { plugin: { limits: { ...limits, maxCaps: { ...limits.maxCaps, tokens: -1 } } } }))
  await assert.rejects(leadFixture(t, { plugin: { limits: { ...limits, maxDeadlineMs: 1.5 } } }))
  // Four positive numbers under the wrong names are not the four caps.
  await assert.rejects(leadFixture(t, { plugin: { limits: { ...limits, maxCaps: { cycle: 1, token: 1, money: 1, wall: 1 } as never } } }))
  await assert.rejects(leadFixture(t, { plugin: { limits: { ...limits, maxCaps: { cycles: 1, tokens: 1, moneyMicros: 1, wallMs: 1, extra: 1 } as never } } }))
  await assert.rejects(leadFixture(t, { plugin: { limits: { ...limits, maxCaps: { cycles: 1, tokens: 1, moneyMicros: 1 } as never } } }))
})
