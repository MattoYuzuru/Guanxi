import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinLifecycle } from './live-world.ts'

test('the pin lifecycle check accepts heartbeat re-pins between the first pin and the last unpin, and nothing else', () => {
  assert.equal(pinLifecycle(['pin', 'unpin']).ok, true)
  assert.deepEqual(pinLifecycle(['pin', 'pin', 'pin', 'unpin']), { ok: true, pins: 3 })
  for (const bad of [[], ['pin'], ['unpin'], ['unpin', 'pin'], ['pin', 'unpin', 'pin'], ['pin', 'unpin', 'unpin'], ['pin', 'unpin', 'pin', 'unpin'], [undefined, 'unpin']]) {
    assert.equal(pinLifecycle(bad).ok, false, JSON.stringify(bad))
  }
})
