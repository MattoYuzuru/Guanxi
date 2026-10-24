import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './fixture.ts'
import { byteHash, canonical, hash, probes, render, strip } from '../../src/relay/handoff.ts'
import type { Handoff } from '../../src/relay/types.ts'

test('the strip shows the current item and status the probe asks for, within 300 bytes and in valid JSON', () => {
  const f = fixture()
  try {
    const l = f.relay.read(f.run.id)
    const handoff = (): Handoff => ({ format: 'guanxi.handoff/v1', runId: f.run.id, cycle: l.cycle, attemptId: f.attempt.id, epoch: f.attempt.epoch, token: f.attempt.token,
      ledgerHash: hash(l), ledger: { ref: `run:${f.run.id}/cycles/${l.cycle}/ledger`, strip: strip(l), head: l.head, revision: l.plan.revision },
      notes: [], narrative: '', degraded: false, bundleHash: byteHash(Buffer.from('fixture-git-bundle')) })
    for (const status of ['open', 'verification_requested'] as const) {
      l.items.one = status
      const value = JSON.parse(strip(l)) as { current: string | null; currentStatus: string | null }
      assert.equal(value.current, 'one')
      assert.equal(value.currentStatus, status)
      assert.deepEqual(probes(l), { ledgerHash: hash(l), head: l.head, revision: l.plan.revision, nextItem: 'one', nextStatus: status })
      const text = render(handoff())
      assert.ok(text.includes('"current":"one"'), 'the rendered strip names the current item')
      assert.ok(text.includes(`"currentStatus":"${status}"`), 'the rendered strip names that item\'s status')
      assert.ok(text.includes(`SHA-256: ${hash(l)}`) && text.includes(`HEAD: ${l.head}`) && text.includes(`Revision: ${l.plan.revision}`), 'the handoff shows the other three probe values')
      const json = canonical(handoff())
      for (const key of ['"ledgerHash"', '"head"', '"revision"']) assert.ok(json.includes(key), key)
      assert.ok(json.includes('"strip"'), 'the canonical handoff carries the strip')
    }
    // A finished plan still renders valid strip JSON with explicit nulls, never `undefined`.
    l.items.one = 'done'
    assert.deepEqual(JSON.parse(strip(l)), { blocked: [], current: null, currentStatus: null, query: 'work.query', queued: null })
    assert.deepEqual(probes(l), { ledgerHash: hash(l), head: l.head, revision: l.plan.revision, nextItem: null, nextStatus: null })
    // A long title/acceptance cannot push the probe fields out of the bounded strip.
    l.items.one = 'open'; l.plan.items[0]!.title = 'long title '.repeat(80); l.plan.items[0]!.acceptance = ['x'.repeat(400)]
    const long = strip(l)
    assert.ok(Buffer.byteLength(long) <= 300, `${Buffer.byteLength(long)} bytes`)
    const parsed = JSON.parse(long) as { current: string | null; currentStatus: string | null }
    assert.equal(parsed.current, 'one'); assert.equal(parsed.currentStatus, 'open')
  } finally { f.close() }
})
