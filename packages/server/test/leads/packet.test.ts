import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leadWakePacketSchema } from '@guanxi/contract'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { buildWakePacket, renderWakePacket, tokensOf, type PacketInput } from '../../src/leads/packet.ts'
import type { ChildReport } from '../../src/leads/types.ts'

const child = { runId: 'child-1', state: 'completed' as const, attempts: 2, costs: [{ currency: 'USD', inputTokens: 10, outputTokens: 5, costMicrounits: null }] }
const report = (overrides: Partial<ChildReport> = {}): ChildReport => ({
  items: [{ id: 't1', title: 'First', status: 'done' }, { id: 't2', title: 'Second', status: 'open' }],
  gates: [{ item: 't1', ok: true, head: 'abcdef1234567890', output: 'all green' }], head: 'abcdef1234567890', diffstat: '2 files changed',
  handoff: { ref: 'relay:child-1', cycle: 4 }, narrative: 'Finished the first item.', openQuestions: ['Should t2 wait?'],
  metrics: { cycles: 4, tokens: 900, moneyMicros: null }, ...overrides,
})
const input = (overrides: Partial<PacketInput> = {}): PacketInput => ({ runId: 'lead-1', wakeSeq: 3, kind: 'resolution', outcome: 'completed', child, report: report(), pendingChildren: [], ...overrides })

test('the packet is structured, strict, deterministic and starts with the format marker', () => {
  const scrubber = new SecretScrubber()
  const a = buildWakePacket(input(), scrubber)
  const b = buildWakePacket(input(), scrubber)
  assert.deepEqual(a, b)
  assert.ok(leadWakePacketSchema.safeParse(a.packet).success)
  assert.equal(a.text.split('\n')[0], 'guanxi.wake/v1 wake=3 kind=resolution run=lead-1')
  assert.deepEqual(a.packet.truncated, [])
  assert.match(a.text, /handoff: relay:child-1 cycle=4/)
  assert.match(a.text, /child cost: USD in=10 out=5 microunits=unknown/)
  assert.ok(!('trace' in a.packet))
  assert.equal(a.tokens, tokensOf(a.text))
  assert.equal(buildWakePacket(input({ report: null }), scrubber).packet.items.length, 0, 'a child without a report still yields an outcome')
  scrubber.close()
})

test('free text is scrubbed before it is cut, so a clip can never leave a prefix of a registered value', () => {
  const scrubber = new SecretScrubber()
  const secret = 'prefixsecret_ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  scrubber.register('secret://t/s', secret)
  const narrative = 'x'.repeat(1_480) + secret
  const built = buildWakePacket(input({ report: report({ narrative, diffstat: secret, openQuestions: [secret],
    gates: [{ item: 't1', ok: false, head: 'h', output: 'o'.repeat(380) + secret }], items: [{ id: 't1', title: secret, status: 'open' }] }) }), scrubber)
  const everything = JSON.stringify(built.packet) + built.text
  assert.ok(!everything.includes(secret))
  assert.ok(!everything.includes(secret.slice(0, 10)), 'no partial prefix survives the clip')
  scrubber.close()
})

test('the finished packet is scrubbed again, covering fields that never pass through the report', () => {
  const scrubber = new SecretScrubber()
  const secret = 'identifier_secret_ABCDEFGHIJKLMNOP'
  scrubber.register('secret://t/id', secret)
  const built = buildWakePacket(input({ runId: `run-${secret}`, child: { ...child, runId: `child-${secret}` }, pendingChildren: [`other-${secret}`] }), scrubber)
  assert.ok(!(JSON.stringify(built.packet) + built.text).includes(secret))
  scrubber.close()
})

test('a large report is reduced in a fixed order, records every reduction and fits the budget', () => {
  const scrubber = new SecretScrubber()
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, title: `Item ${i} ${'y'.repeat(250)}`, status: 'open' as const }))
  const big = report({ items, gates: items.map(item => ({ item: item.id, ok: false, head: 'h', output: 'g'.repeat(1_000) })),
    diffstat: 'd'.repeat(5_000), narrative: 'n'.repeat(9_000), openQuestions: Array.from({ length: 30 }, (_, i) => `q${i} ${'z'.repeat(400)}`) })
  const built = buildWakePacket(input({ report: big }), scrubber)
  assert.ok(built.tokens <= 4_000, `${built.tokens} tokens`)
  assert.ok(built.packet.truncated.indexOf('gates.output:120') < built.packet.truncated.indexOf('narrative:400'))
  assert.ok(built.packet.truncated.some(entry => entry.startsWith('openQuestions:+')))
  assert.ok(built.packet.items.length < 300 && built.packet.truncated.some(entry => entry.startsWith('items:-')))
  assert.match(built.text, /truncated: /)
  // A tight explicit budget still keeps the outcome; an impossible one refuses instead of overrunning.
  const tight = buildWakePacket(input({ report: big }), scrubber, 250)
  assert.ok(tight.tokens <= 250)
  assert.match(tight.text, /outcome: completed/)
  assert.throws(() => buildWakePacket(input({ report: big }), scrubber, 5), { code: 'wake_packet_too_large' })
  scrubber.close()
})

test('every field is bounded, not only the clipped prose: huge ids and references cannot make a wake undeliverable', () => {
  const scrubber = new SecretScrubber()
  const huge = 'h'.repeat(20_000)
  const built = buildWakePacket(input({ child: { ...child, runId: 'c'.repeat(150), costs: Array.from({ length: 50 }, (_, i) => ({ currency: `C${i}${huge}`, inputTokens: 1, outputTokens: 1, costMicrounits: null })) },
    pendingChildren: Array.from({ length: 200 }, () => huge),
    report: report({ head: huge, handoff: { ref: huge, cycle: 1 }, items: [{ id: huge, title: huge, status: 'open' }], gates: [{ item: huge, ok: false, head: huge, output: huge }] }) }), scrubber)
  assert.ok(built.tokens <= 4_000, `${built.tokens}`)
  assert.ok(leadWakePacketSchema.safeParse(built.packet).success)
  const forced = buildWakePacket(input({ report: report({ items: [{ id: 'a'.repeat(80), title: 'T'.repeat(200), status: 'open' }] }) }), scrubber, 170)
  assert.ok(forced.packet.truncated.includes('minimal'), 'the last resort keeps only outcome, state and metrics')
  assert.ok(forced.tokens <= 170)
  assert.deepEqual([forced.packet.items, forced.packet.gates, forced.packet.handoff], [[], [], null])
  assert.match(forced.text, /outcome: completed/)
  scrubber.close()
})

test('escalations carry no outcome claim and list other pending children for drill-down only', () => {
  const scrubber = new SecretScrubber()
  const built = buildWakePacket(input({ kind: 'escalation', outcome: 'pending', pendingChildren: ['child-1', 'child-2'] }), scrubber)
  assert.match(built.text, /kind=escalation/)
  assert.match(built.text, /outcome: pending/)
  assert.deepEqual(built.packet.drilldown.filter(ref => ref.kind === 'run').map(ref => ref.id), ['child-1', 'child-2'])
  assert.equal(renderWakePacket(built.packet), built.text)
  scrubber.close()
})
