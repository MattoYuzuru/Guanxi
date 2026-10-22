import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { admissionPolicyDigest } from '../../src/external-agents/admission.ts'
import { ExternalStore } from '../../src/external-agents/store.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'

const scrubber = { isReady: () => true, scrub: <T>(value: T) => value } as unknown as EgressScrubber
const owner = 'learning-owner'
const account = 'learning-account'
const adapter = 'codex' as const

async function twoStores(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'k5-learning-'))
  const left = new ExternalStore(join(root, 'sidecar.sqlite'), scrubber)
  const right = new ExternalStore(join(root, 'sidecar.sqlite'), scrubber)
  t.after(async () => { left.close(); right.close(); await rm(root, { recursive: true, force: true }) })
  return { left, right }
}

/** Commit through the right handle immediately before the left handle's actual concurrency write.
 * This is a real two-handle statement boundary, not a fake learning result. */
function beforeWrite(t: TestContext, left: ExternalStore, inject: () => void) {
  const prepare = left.db.prepare.bind(left.db)
  let injected = false
  const hook = t.mock.method(left.db, 'prepare', (sql: string) => {
    const statement = prepare(sql)
    if (/^INSERT(?: OR REPLACE)? INTO concurrency/.test(sql.trimStart())) {
      const run = statement.run.bind(statement)
      t.mock.method(statement, 'run', (...args: any[]) => {
        if (!injected) { injected = true; inject() }
        return run(...args)
      })
    }
    return statement
  })
  return { get injected() { return injected }, restore: () => hook.mock.restore() }
}

function admission(ceiling = 3) {
  const install = { nodeId: 'learning-node', ownerAccountId: owner, adapter, billingAccount: account, concurrency: ceiling }
  return { instanceId: 'learning-instance', owner, adapter, billingAccount: account,
    policyDigest: admissionPolicyDigest(install), kind: 'run' as const, ceiling }
}

test('a concurrent success cannot erase a stricter rejection at the write boundary', async t => {
  const { left, right } = await twoStores(t)
  const hook = beforeWrite(t, left, () => {
    right.learn(owner, account, adapter, 2, 'concurrency_rejected', '2026-10-22T00:00:01.000Z')
  })
  try {
    left.learn(owner, account, adapter, 1, 'success', '2026-10-22T00:00:02.000Z')
  } finally { hook.restore() }

  assert.equal(hook.injected, true)
  const learned = right.learning(owner, account, adapter)
  assert.equal(learned.successful, 1)
  assert.equal(learned.rejectedAt, 2)
  assert.equal(learned.observedAt, '2026-10-22T00:00:02.000Z')

  const request = admission()
  const first = left.acquire(request)
  try {
    assert.throws(() => right.acquire({ ...request, instanceId: 'learning-peer' }),
      (error: unknown) => (error as { code?: string }).code === 'account_busy')
    assert.equal(left.occupancy(owner, adapter, account).total, 1)
  } finally { left.release(first.holder) }
})

test('a later success retains an existing stricter rejection', async t => {
  const { left, right } = await twoStores(t)
  right.learn(owner, account, adapter, 2, 'concurrency_rejected', '2026-10-22T00:00:01.000Z')
  left.learn(owner, account, adapter, 3, 'success', '2026-10-22T00:00:02.000Z')

  const learned = left.learning(owner, account, adapter)
  assert.equal(learned.successful, 3)
  assert.equal(learned.rejectedAt, 2)
  assert.equal(learned.observedAt, '2026-10-22T00:00:02.000Z')
})

test('success observations racing at the write boundary retain the highest value', async t => {
  const { left, right } = await twoStores(t)
  const hook = beforeWrite(t, left, () => {
    right.learn(owner, account, adapter, 3, 'success', '2026-10-22T00:00:01.000Z')
  })
  try {
    left.learn(owner, account, adapter, 1, 'success', '2026-10-22T00:00:02.000Z')
  } finally { hook.restore() }

  assert.equal(hook.injected, true)
  const learned = left.learning(owner, account, adapter)
  assert.equal(learned.successful, 3)
  assert.equal(learned.rejectedAt, null)
  assert.equal(learned.observedAt, '2026-10-22T00:00:02.000Z')
})

test('first observations keep the missing outcome unknown and groups stay isolated', async t => {
  const { left } = await twoStores(t)
  assert.deepEqual(left.learning(owner, account, adapter), {
    successful: null, rejectedAt: null, source: 'local_dispatch_observations', observedAt: null, confidence: 'unknown',
  })

  left.learn(owner, account, adapter, 2, 'success', '2026-10-22T00:00:01.000Z')
  let learned = left.learning(owner, account, adapter)
  assert.equal(learned.successful, 2)
  assert.equal(learned.rejectedAt, null)
  assert.deepEqual({ source: learned.source, confidence: learned.confidence },
    { source: 'local_dispatch_observations', confidence: 'low' })

  left.learn(owner, account, adapter, 3, 'concurrency_rejected', '2026-10-22T00:00:02.000Z')
  learned = left.learning(owner, account, adapter)
  assert.equal(learned.successful, 2)
  assert.equal(learned.rejectedAt, 3)
  assert.equal(learned.observedAt, '2026-10-22T00:00:02.000Z')

  left.learn('learning-other-owner', account, adapter, 2, 'concurrency_rejected', '2026-10-22T00:00:03.000Z')
  const otherOwner = left.learning('learning-other-owner', account, adapter)
  assert.equal(otherOwner.successful, null)
  assert.equal(otherOwner.rejectedAt, 2)

  left.learn(owner, 'learning-other-account', adapter, 4, 'success', '2026-10-22T00:00:04.000Z')
  const otherAccount = left.learning(owner, 'learning-other-account', adapter)
  assert.equal(otherAccount.successful, 4)
  assert.equal(otherAccount.rejectedAt, null)

  left.learn(owner, account, 'claude-code', 1, 'concurrency_rejected', '2026-10-22T00:00:05.000Z')
  const otherAdapter = left.learning(owner, account, 'claude-code')
  assert.equal(otherAdapter.successful, null)
  assert.equal(otherAdapter.rejectedAt, 1)

  learned = left.learning(owner, account, adapter)
  assert.equal(learned.successful, 2)
  assert.equal(learned.rejectedAt, 3)
})
