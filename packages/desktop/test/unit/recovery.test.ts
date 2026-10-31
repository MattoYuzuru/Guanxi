import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBackoff } from '../../src/recovery.ts'

describe('createBackoff (a crash loop slows down)', () => {
  const setup = () => {
    const clock = { now: 1_000_000 }
    return { clock, backoff: createBackoff({ baseMs: 3_000, maxMs: 60_000, resetAfterMs: 300_000, now: () => clock.now }) }
  }

  it('starts at the base delay and doubles with each close repeat, up to the cap', () => {
    const { backoff, clock } = setup()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      delays.push(backoff.failure())
      clock.now += 10_000
    }
    assert.deepEqual(delays, [3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000])
  })

  it('forgets the history after a quiet period', () => {
    const { backoff, clock } = setup()
    backoff.failure()
    clock.now += 10_000
    assert.equal(backoff.failure(), 6_000)
    clock.now += 300_001
    assert.equal(backoff.failure(), 3_000)
  })

  it('the base delay is what a plain load failure uses', () => {
    assert.equal(setup().backoff.base(), 3_000)
  })
})
