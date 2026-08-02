import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ResourceGovernor,
  type AdmissionRequest,
} from '../src/runtime/resource-governor.ts'

function request(operationId: string, model = operationId): AdmissionRequest {
  return {
    owner: { kind: 'operation', operationId },
    operation: 'model_warm',
    model: { provider: 'ollama', name: model },
    requestedContext: 4_096,
    priority: 'normal',
    enqueuedAt: '2026-08-03T10:00:00.000Z',
  }
}

describe('ResourceGovernor single-permit compatibility gate', () => {
  it('admits one typed owner and hands leases to waiters in FIFO order', async () => {
    const governor = new ResourceGovernor()
    const firstTicket = governor.enqueue(request('first'))
    const first = await governor.acquire(firstTicket)
    const order: string[] = []

    const secondTicket = governor.enqueue(request('second'))
    const secondPromise = governor.acquire(secondTicket).then((lease) => {
      order.push('second')
      return lease
    })
    const thirdTicket = governor.enqueue(request('third'))
    const thirdPromise = governor.acquire(thirdTicket).then((lease) => {
      order.push('third')
      return lease
    })

    assert.equal(governor.active, true)
    assert.equal(governor.waiting, 2)

    first.release()
    const second = await secondPromise
    assert.deepEqual(order, ['second'])
    assert.equal(governor.waiting, 1)

    // Duplicate cleanup cannot release the current owner.
    first.release()
    assert.equal(governor.active, true)
    assert.equal(governor.waiting, 1)

    second.release()
    const third = await thirdPromise
    assert.deepEqual(order, ['second', 'third'])
    assert.equal(governor.waiting, 0)

    third.release()
    assert.equal(governor.active, false)
  })

  it('removes an aborted ticket without cancelling the owner or leaking a lease', async () => {
    const governor = new ResourceGovernor()
    const ownerTicket = governor.enqueue(request('owner'))
    const owner = await governor.acquire(ownerTicket)
    const waitingController = new AbortController()
    const waitingTicket = governor.enqueue(request('waiting'))
    const waiting = governor.acquire(waitingTicket, { signal: waitingController.signal })

    assert.equal(governor.waiting, 1)
    waitingController.abort()

    await assert.rejects(waiting, { name: 'AbortError' })
    assert.equal(governor.active, true)
    assert.equal(governor.waiting, 0)

    const nextTicket = governor.enqueue(request('next'))
    const nextPromise = governor.acquire(nextTicket)
    owner.release()
    const next = await nextPromise
    assert.equal(governor.active, true)

    next.release()
    assert.equal(governor.active, false)
  })

  it('rejects an already-aborted request without taking ownership', async () => {
    const governor = new ResourceGovernor()
    const controller = new AbortController()
    controller.abort()
    const ticket = governor.enqueue(request('aborted'))

    await assert.rejects(governor.acquire(ticket, { signal: controller.signal }), {
      name: 'AbortError',
    })
    assert.equal(governor.active, false)
    assert.equal(governor.waiting, 0)
  })
})
