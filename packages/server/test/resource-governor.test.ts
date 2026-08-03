import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  ResourceGovernor,
  ResourceGovernorError,
  SINGLE_PERMIT_POLICY_BASIS,
  type AdmissionRequest,
} from '../src/runtime/resource-governor.ts'

function request(
  ownerId: string,
  options: Partial<
    Pick<AdmissionRequest, 'operation' | 'model' | 'requestedContext' | 'priority'>
  > = {},
): AdmissionRequest {
  return {
    owner: { kind: 'operation', operationId: ownerId },
    operation: options.operation ?? 'model_warm',
    model: options.model ?? { provider: 'ollama', name: `model-${ownerId}` },
    requestedContext: options.requestedContext ?? 4_096,
    priority: options.priority ?? 'normal',
    enqueuedAt: '2026-08-03T10:00:00.000Z',
  }
}

function deterministicGovernor(): ResourceGovernor {
  let id = 0
  let tick = 0
  return new ResourceGovernor({
    createId: () => `resource-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 3, 10, 0, 0) + tick++),
  })
}

describe('ResourceGovernor typed admission and observation', () => {
  it('freezes the exact request and explains one active lease plus FIFO waiters', async () => {
    const governor = deterministicGovernor()
    const mutable = {
      owner: { kind: 'operation' as const, operationId: 'first' },
      operation: 'compaction' as const,
      model: { provider: 'ollama' as const, name: 'exact-model' },
      requestedContext: 32_768,
      priority: 'normal' as const,
      enqueuedAt: '2026-08-03T10:00:00.000Z',
    }
    const firstTicket = governor.enqueue(mutable)
    mutable.owner.operationId = 'mutated-owner'
    mutable.model.name = 'mutated-model'
    mutable.requestedContext = 1

    const firstLease = await governor.acquire(firstTicket)
    const secondTicket = governor.enqueue(request('second'))
    const secondLeasePromise = governor.acquire(secondTicket)
    const thirdTicket = governor.enqueue(request('third'))
    const thirdLeasePromise = governor.acquire(thirdTicket)

    const snapshot = governor.snapshot()
    assert.equal(snapshot.policy.acceleratorPermits, 1)
    assert.equal(snapshot.policy.order, 'priority_fifo')
    assert.deepEqual(snapshot.policy.priorities, ['normal', 'prewarm'])
    assert.equal(snapshot.policy.scope, 'application_process')
    assert.equal(snapshot.policy.basis, SINGLE_PERMIT_POLICY_BASIS)
    assert.deepEqual(snapshot.activeLease, {
      leaseId: firstLease.id,
      ticketId: firstTicket.id,
      owner: { kind: 'operation', operationId: 'first' },
      operation: 'compaction',
      model: { provider: 'ollama', name: 'exact-model' },
      requestedContext: 32_768,
      priority: 'normal',
      acquiredAt: firstLease.acquiredAt,
      state: 'active',
    })
    assert.deepEqual(
      snapshot.queued.map((entry) => entry.owner),
      [
        { kind: 'operation', operationId: 'second' },
        { kind: 'operation', operationId: 'third' },
      ],
    )
    assert.equal(snapshot.queued[0]?.reason, 'single_permit_busy')
    assert.equal(governor.explain(secondTicket.id).queuePosition, 1)
    assert.equal(governor.explain(secondTicket.id).decisionCode, 'queued_fifo')
    assert.equal(Object.isFrozen(firstTicket.request), true)
    assert.equal(Object.isFrozen(firstTicket.request.owner), true)
    assert.equal(Object.isFrozen(firstTicket.request.model), true)

    firstLease.release()
    const secondLease = await secondLeasePromise
    assert.equal(secondLease.owner.kind, 'operation')
    assert.equal(
      secondLease.owner.kind === 'operation' ? secondLease.owner.operationId : null,
      'second',
    )
    secondLease.release()
    const thirdLease = await thirdLeasePromise
    thirdLease.release()
    assert.equal(governor.snapshot().activeLease, null)
  })

  it('cancels only one waiting ticket while active cancellation stays owner-controlled', async () => {
    const governor = deterministicGovernor()
    const activeSignal = new AbortController()
    const activeTicket = governor.enqueue(request('active'))
    const activeLease = await governor.acquire(activeTicket, { signal: activeSignal.signal })
    activeSignal.abort('execution-owner-cancel')
    assert.equal(governor.active, true)
    assert.equal(activeLease.state, 'active')

    const cancelledController = new AbortController()
    const cancelledTicket = governor.enqueue(request('cancelled'))
    const cancelled = governor.acquire(cancelledTicket, { signal: cancelledController.signal })
    const nextTicket = governor.enqueue(request('next'))
    const next = governor.acquire(nextTicket)
    cancelledController.abort()

    await assert.rejects(cancelled, { name: 'AbortError' })
    assert.equal(cancelledTicket.state, 'cancelled')
    assert.equal(governor.waiting, 1)
    assert.equal(governor.active, true)

    activeLease.release()
    const nextLease = await next
    assert.equal(nextLease.ticketId, nextTicket.id)
    nextLease.release()
    assert.equal(governor.active, false)
    assert.equal(governor.waiting, 0)
  })

  it('keeps normal FIFO ahead of queued prewarm and preempts only the exact active prewarm owner', async () => {
    const governor = deterministicGovernor()
    const prewarmController = new AbortController()
    const activePrewarmTicket = governor.enqueue(
      request('prewarm-active', { operation: 'model_prewarm', priority: 'prewarm' }),
    )
    const activePrewarm = await governor.acquire(activePrewarmTicket, {
      signal: prewarmController.signal,
      preemptOwner: () => prewarmController.abort('normal-arrived'),
    })
    prewarmController.signal.addEventListener('abort', () => activePrewarm.release(), {
      once: true,
    })

    const queuedPrewarmController = new AbortController()
    const queuedPrewarmTicket = governor.enqueue(
      request('prewarm-queued', { operation: 'model_prewarm', priority: 'prewarm' }),
    )
    const queuedPrewarm = governor.acquire(queuedPrewarmTicket, {
      signal: queuedPrewarmController.signal,
    })
    const queuedPrewarmRejected = assert.rejects(queuedPrewarm, { name: 'AbortError' })

    const order: string[] = []
    const firstNormalTicket = governor.enqueue(request('normal-first'))
    const firstNormal = governor.acquire(firstNormalTicket).then((lease) => {
      order.push('normal-first')
      return lease
    })
    const secondNormalTicket = governor.enqueue(request('normal-second'))
    const secondNormal = governor.acquire(secondNormalTicket).then((lease) => {
      order.push('normal-second')
      return lease
    })

    await queuedPrewarmRejected
    assert.equal(prewarmController.signal.aborted, true)
    assert.equal(queuedPrewarmTicket.state, 'cancelled')
    assert.equal(governor.cancel(queuedPrewarmTicket), false)
    assert.equal(governor.cancel(queuedPrewarmTicket), false)
    const firstLease = await firstNormal
    assert.equal(activePrewarm.state, 'released')
    activePrewarm.release()
    activePrewarm.release()
    assert.deepEqual(order, ['normal-first'])
    firstLease.release()
    const secondLease = await secondNormal
    assert.deepEqual(order, ['normal-first', 'normal-second'])
    secondLease.release()
    assert.equal(governor.active, false)
  })

  it('never admits prewarm while normal work exists and never aborts an active normal owner', async () => {
    const governor = deterministicGovernor()
    let normalAbortCalls = 0
    const normalTicket = governor.enqueue(request('normal-active'))
    const normalLease = await governor.acquire(normalTicket, {
      preemptOwner: () => {
        normalAbortCalls += 1
      },
    })

    assert.throws(
      () =>
        governor.enqueue(
          request('prewarm-denied', {
            operation: 'model_prewarm',
            priority: 'prewarm',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ResourceGovernorError)
        assert.equal(error.code, 'prewarm_normal_work_present')
        return true
      },
    )
    assert.equal(normalAbortCalls, 0)
    assert.equal(governor.waiting, 0)
    assert.equal(governor.snapshot().lastDecision?.decisionCode, 'prewarm_skipped_normal_work')
    normalLease.release()
  })

  it('gives normal work the only lease for both simultaneous callback orders in 10 repeats', async () => {
    for (let repeat = 0; repeat < 10; repeat += 1) {
      for (const normalFirst of [true, false]) {
        const governor = deterministicGovernor()
        let simultaneousActive = 0
        let maxActive = 0
        const entered: string[] = []

        const runNormal = async () => {
          const ticket = governor.enqueue(request(`normal-${repeat}`))
          const lease = await governor.acquire(ticket)
          simultaneousActive += 1
          maxActive = Math.max(maxActive, simultaneousActive)
          entered.push('normal')
          simultaneousActive -= 1
          lease.release()
        }
        const runPrewarm = async () => {
          let ticket
          try {
            ticket = governor.enqueue(
              request(`prewarm-${repeat}`, {
                operation: 'model_prewarm',
                priority: 'prewarm',
              }),
            )
          } catch (error) {
            assert.ok(error instanceof ResourceGovernorError)
            assert.equal(error.code, 'prewarm_normal_work_present')
            return
          }
          const controller = new AbortController()
          const lease = await governor.acquire(ticket, {
            signal: controller.signal,
            preemptOwner: () => controller.abort('normal-arrived'),
          })
          if (controller.signal.aborted) {
            lease.release()
            return
          }
          simultaneousActive += 1
          maxActive = Math.max(maxActive, simultaneousActive)
          entered.push('prewarm')
          simultaneousActive -= 1
          lease.release()
        }

        if (normalFirst) await Promise.all([runNormal(), runPrewarm()])
        else await Promise.all([runPrewarm(), runNormal()])
        assert.equal(maxActive, 1)
        assert.equal(entered.filter((entry) => entry === 'normal').length, 1)
        assert.equal(governor.active, false)
      }
    }
  })

  it('rejects exact and conservative unload conflicts without leaking private values', async () => {
    const governor = deterministicGovernor()
    const privateModel = 'model private-prompt /tmp/private secret-token'
    const ticket = governor.enqueue(
      request('active-owner', { model: { provider: 'ollama', name: privateModel } }),
    )
    const lease = await governor.acquire(ticket)

    for (const fixture of [
      {
        model: { provider: 'ollama' as const, name: privateModel },
        code: 'unload_active_model',
      },
      {
        model: { provider: 'ollama' as const, name: 'unrelated-model' },
        code: 'unload_conservative_active_owner',
      },
    ]) {
      assert.throws(
        () => governor.assertCanUnload(fixture.model),
        (error: unknown) => {
          assert.ok(error instanceof ResourceGovernorError)
          assert.equal(error.code, fixture.code)
          assert.doesNotMatch(
            JSON.stringify({ code: error.code, message: error.message }),
            /private-prompt|\/tmp\/private|secret-token/,
          )
          return true
        },
      )
    }

    lease.release()
    assert.doesNotThrow(() =>
      governor.assertCanUnload({ provider: 'ollama', name: privateModel }),
    )
  })

  it('bounds diagnostics to live state after a large acquire/release sequence', async () => {
    const governor = deterministicGovernor()
    for (let index = 0; index < 1_000; index += 1) {
      const ticket = governor.enqueue(request(`bounded-${index}`))
      const lease = await governor.acquire(ticket)
      lease.release()
      assert.equal(ticket.state, 'released')
    }

    const snapshot = governor.snapshot()
    assert.equal(snapshot.queued.length, 0)
    assert.equal(snapshot.activeLease, null)
    assert.equal(snapshot.lastDecision?.decisionCode, 'released')
    assert.ok(JSON.stringify(snapshot).length < 2_000)
    assert.equal(governor.explain('never-issued').decisionCode, 'unknown_ticket')
  })

  it('closes idempotently, aborts owners, rejects waiters, and never transfers twice in 10 repeats', async () => {
    for (let repeat = 0; repeat < 10; repeat += 1) {
      const governor = deterministicGovernor()
      const requestOptions =
        repeat % 2 === 0
          ? {}
          : ({ operation: 'model_prewarm', priority: 'prewarm' } as const)
      const activeController = new AbortController()
      const activeTicket = governor.enqueue(request(`active-${repeat}`, requestOptions))
      const activeLease = await governor.acquire(activeTicket, {
        signal: activeController.signal,
        abortOwner: () => activeController.abort('application-shutdown'),
      })
      activeController.signal.addEventListener('abort', () => activeLease.release(), {
        once: true,
      })

      const waitingController = new AbortController()
      const waitingTicket = governor.enqueue(request(`waiting-${repeat}`, requestOptions))
      const waiting = governor.acquire(waitingTicket, {
        signal: waitingController.signal,
        abortOwner: () => waitingController.abort('application-shutdown'),
      })
      const closed = governor.close()
      assert.equal(governor.close(), closed)
      await assert.rejects(waiting, ResourceGovernorError)
      await closed

      activeLease.release()
      activeLease.release()
      assert.equal(governor.cancel(waitingTicket), false)
      assert.equal(governor.cancel(waitingTicket), false)
      assert.equal(governor.snapshot().accepting, false)
      assert.equal(governor.snapshot().activeLease, null)
      assert.equal(governor.snapshot().queued.length, 0)
      assert.throws(() => governor.enqueue(request(`late-${repeat}`)), {
        name: 'ResourceGovernorError',
      })
      await assert.rejects(governor.acquire(activeTicket), {
        name: 'ResourceGovernorError',
      })
    }
  })
})

describe('ResourceGovernor composition inventory', () => {
  it('routes Chat, compaction, and warm/load through context.governor with no legacy bridge', () => {
    const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
    const context = readFileSync(`${sourceRoot}/context.ts`, 'utf8')
    const chat = readFileSync(`${sourceRoot}/jobs/chat-execution.ts`, 'utf8')
    const threads = readFileSync(`${sourceRoot}/http/threads-routes.ts`, 'utf8')
    const models = readFileSync(`${sourceRoot}/http/models-routes.ts`, 'utf8')
    const combined = [context, chat, threads, models].join('\n')

    assert.match(context, /const governor = new ResourceGovernor\(\)/)
    assert.match(context, /chatExecution: new ChatJobExecutionOwner\(base\)/)
    assert.match(chat, /operation: 'chat'/)
    assert.match(chat, /owner: \{ kind: 'job', jobId: association\.job\.id \}/)
    assert.match(threads, /operation: 'compaction'/)
    assert.match(models, /operation: 'model_warm'/)
    assert.match(models, /governor\.assertCanUnload/)
    assert.doesNotMatch(combined, /ExclusiveInferenceBridge|app\.inference/)
    assert.equal(existsSync(`${sourceRoot}/runtime/exclusive-inference.ts`), false)
  })
})
