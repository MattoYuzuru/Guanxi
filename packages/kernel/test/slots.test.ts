import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PluginContractError,
  contribute,
  createKernel,
  declareSlot,
  isActive,
  type Kernel,
} from '../src/index.ts'
import { testPlugin } from './helpers.ts'

const SLOT = 'sidebar.items'

function shell() {
  return testPlugin({ contributes: { slotDeclarations: [SLOT] } }, (ctx) => declareSlot(ctx, SLOT))
}

function item(id: string, label: string, order?: number) {
  return testPlugin({ contributes: { slots: [SLOT] } }, (ctx) => {
    contribute(ctx, SLOT, { id, order, value: { label } })
  })
}

function labels(kernel: Kernel): string[] {
  return kernel.slots.list<{ label: string }>(SLOT).map((entry) => entry.value.label)
}

describe('list slots', () => {
  it('shows a contribution, replaces it in place, and removes it on unload', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    let notifications = 0
    const unsubscribe = kernel.slots.subscribe(() => notifications++)
    await kernel.plugin(shell())
    const first = await kernel.plugin(item('projects', 'Projects v1'))
    assert.deepEqual(labels(kernel), ['Projects v1'])
    const snapshot = kernel.slots.list(SLOT)
    assert.equal(kernel.slots.list(SLOT), snapshot, 'stable snapshot between changes')

    // Hot update: dispose the old version, load the new one.
    await first.dispose()
    const second = await kernel.plugin(item('projects', 'Projects v2'))
    assert.deepEqual(labels(kernel), ['Projects v2'])
    assert.equal(kernel.slots.list(SLOT).length, 1, 'no duplicate after the update')

    await second.dispose()
    assert.deepEqual(labels(kernel), [])
    assert.ok(notifications >= 4)
    unsubscribe()
    await kernel.dispose()
    assert.deepEqual(kernel.counters(), before)
  })

  it('orders entries by order, then by contribution time', async () => {
    const kernel = createKernel()
    await kernel.plugin(shell())
    await kernel.plugin(item('b', 'B', 2))
    await kernel.plugin(item('a', 'A', 1))
    await kernel.plugin(item('c', 'C', 2))
    assert.deepEqual(labels(kernel), ['A', 'B', 'C'])
  })

  it('keeps contributors waiting until the slot exists, and unloads them before its owner', async () => {
    const kernel = createKernel()
    const contributor = await kernel.plugin(item('projects', 'Projects'))
    assert.equal(isActive(contributor.fiber), false)
    assert.deepEqual(labels(kernel), [])
    const owner = await kernel.plugin(shell())
    await contributor.fiber.await()
    assert.deepEqual(labels(kernel), ['Projects'])
    await owner.dispose()
    assert.equal(kernel.slots.isDeclared(SLOT), false)
    assert.equal(kernel.counters().slotEntries, 0)
    assert.equal(kernel.counters().slotOrphans, 0, 'contributors left before the slot did')
    await kernel.plugin(shell())
    await contributor.fiber.await()
    assert.deepEqual(labels(kernel), ['Projects'], 'contribution returns with its slot')
  })

  it('fails at load when a plugin contributes outside its manifest or twice', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await kernel.plugin(shell())
    const undeclared = testPlugin({ contributes: { slots: [SLOT] } }, (ctx) => {
      contribute(ctx, 'other.slot', { id: 'x', value: {} })
    })
    await assert.rejects(kernel.plugin(undeclared), PluginContractError)
    const twice = testPlugin({ contributes: { slots: [SLOT] } }, (ctx) => {
      contribute(ctx, SLOT, { id: 'x', value: {} })
      contribute(ctx, SLOT, { id: 'x', value: {} })
    })
    await assert.rejects(kernel.plugin(twice), /already has entry/)
    assert.equal(kernel.counters().slotEntries, 0, 'the failed plugin left no entry')
  })

  it('lets only one plugin own a slot, and only a declared one', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await kernel.plugin(shell())
    await assert.rejects(kernel.plugin(shell()), /already declared/)
    const undeclared = testPlugin({}, (ctx) => declareSlot(ctx, SLOT))
    await assert.rejects(kernel.plugin(undeclared), /not in contributes.slotDeclarations/)
    const silent = testPlugin({ contributes: { slotDeclarations: ['silent.slot'] } }, () => {})
    await assert.rejects(kernel.plugin(silent), /did not declare slot silent\.slot/)
  })
})
