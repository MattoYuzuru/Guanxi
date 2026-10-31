/** B3-c: pins the default (ledger) path. The digest below was recorded by running this file on the base commit `a9a25c82`, before the
 * naive-compaction arm existed; it covers every prompt the model is sent and the shape of every event of a two-cycle run. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { canonical } from '../../src/relay/handoff.ts'
import { fixture, plan } from './fixture.ts'

const item = (id: string, dependsOn: string[]) => ({ id, title: 'item ' + id, dependsOn, acceptance: ['true'], protectedPaths: ['tests'] })
const PINNED = 'c9bf1d6804ab4f4867dddf74c9dd28b258bbd571feafd00f630282fc32c1852b'

test('the default path\'s prompts, event shapes and final ledger are those of the base commit', async () => {
  let work = 0
  const f = fixture({ plan: { ...plan, items: [item('b', ['a']), item('a', [])] },
    actions: () => canonical(work++ === 0 ? { action: 'verify', item: 'a' } : work === 3 ? { action: 'verify', item: 'b' } : { action: 'handoff' }) })
  try {
    await f.executor.run(f.attempt)
    // Evidence ids are random, so every hash that covers them differs between runs; the shapes, order and text must not.
    const same = (text: string) => text.replaceAll(f.run.id, 'RUN').replaceAll(f.attempt.id, 'ATTEMPT').replace(/[0-9a-f]{64}/g, 'H')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
    const notes = f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note').map(e => same(String(e.data.text)))
    const transcript = JSON.stringify({ prompts: f.prompts.map(same), notes, ledger: same(canonical(f.relay.read(f.run.id))) })
    assert.equal(f.relay.read(f.run.id).cycle, 2)
    assert.equal(createHash('sha256').update(transcript).digest('hex'), PINNED)
  } finally { f.close() }
})
