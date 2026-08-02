import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExclusiveInferenceBridge } from '../src/runtime/exclusive-inference.ts'

describe('ExclusiveInferenceBridge', () => {
  it('admits one owner and hands the permit to waiters in FIFO order', async () => {
    const bridge = new ExclusiveInferenceBridge()
    const first = await bridge.acquire()
    const order: string[] = []

    const secondPromise = bridge.acquire().then((permit) => {
      order.push('second')
      return permit
    })
    const thirdPromise = bridge.acquire().then((permit) => {
      order.push('third')
      return permit
    })

    assert.equal(bridge.active, true)
    assert.equal(bridge.waiting, 2)

    first.release()
    const second = await secondPromise
    assert.deepEqual(order, ['second'])
    assert.equal(bridge.waiting, 1)

    // Duplicate cleanup cannot release the current owner.
    first.release()
    assert.equal(bridge.active, true)
    assert.equal(bridge.waiting, 1)

    second.release()
    const third = await thirdPromise
    assert.deepEqual(order, ['second', 'third'])
    assert.equal(bridge.waiting, 0)

    third.release()
    assert.equal(bridge.active, false)
  })

  it('removes an aborted waiter without cancelling the owner or leaking a permit', async () => {
    const bridge = new ExclusiveInferenceBridge()
    const owner = await bridge.acquire()
    const waitingController = new AbortController()
    const waiting = bridge.acquire(waitingController.signal)

    assert.equal(bridge.waiting, 1)
    waitingController.abort()

    await assert.rejects(waiting, { name: 'AbortError' })
    assert.equal(bridge.active, true)
    assert.equal(bridge.waiting, 0)

    const nextPromise = bridge.acquire()
    owner.release()
    const next = await nextPromise
    assert.equal(bridge.active, true)

    next.release()
    assert.equal(bridge.active, false)
  })

  it('rejects an already-aborted request without taking ownership', async () => {
    const bridge = new ExclusiveInferenceBridge()
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(bridge.acquire(controller.signal), { name: 'AbortError' })
    assert.equal(bridge.active, false)
    assert.equal(bridge.waiting, 0)
  })
})
