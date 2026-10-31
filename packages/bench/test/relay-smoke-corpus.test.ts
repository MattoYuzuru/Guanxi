import assert from 'node:assert/strict'
import test from 'node:test'
import { relayPlanSchema } from '@guanxi/contract'
import { LEDGER_LITE, SMOKE_BASE_COMMIT, SMOKE_TASKS, SMOKE_TASK_IDS, smokeDigests, smokePlan, smokeVerifierBlobs } from '../src/relay-smoke-corpus.ts'

test('the cohort is five tasks of five items, at most the D-219 default', () => {
  assert.equal(SMOKE_TASKS.length, 5)
  for (const t of SMOKE_TASKS) assert.equal(t.items.length, 5, t.id)
  assert.equal(new Set(SMOKE_TASK_IDS).size, 5)
})

test('every task is a valid relay plan whose dependencies are closed inside the plan', () => {
  for (const task of SMOKE_TASKS) {
    const plan = relayPlanSchema.parse(smokePlan(task.id))
    assert.equal(plan.base, SMOKE_BASE_COMMIT)
    assert.equal(plan.revision, task.id)
    assert.deepEqual(plan.items.map(i => i.id), task.items)
    for (const item of plan.items) {
      const spec = LEDGER_LITE[item.id]!
      assert.deepEqual(item.acceptance, ['node', '--test', spec.test], 'argv, never a shell string')
      assert.deepEqual(item.protectedPaths, ['test'])
      assert.deepEqual(item.dependsOn, spec.dependsOn)
      assert.ok(item.dependsOn.every(d => task.items.includes(d)), `${task.id}/${item.id} depends outside the plan`)
      assert.match(item.title, new RegExp(`SPEC.md section "${item.id} — `), 'the title names its section so the executor reads it')
    }
    assert.deepEqual(plan.protectedPaths, ['test'])
  }
})

test('the plan goal fits the relay goal bound and forbids editing tests', () => {
  const goal = smokePlan('ll-money-text').goal
  assert.ok(Buffer.byteLength(goal) <= 512)
  assert.match(goal, /Never edit anything under test\//)
})

test('verifier blobs are pinned for exactly the tests the selected tasks use', () => {
  const blobs = smokeVerifierBlobs(['ll-money-text'])
  assert.deepEqual(blobs.map(b => b.path), ['test/01-money.test.mjs', 'test/02-money-ops.test.mjs', 'test/03-dates.test.mjs', 'test/04-payees.test.mjs', 'test/05-csv.test.mjs'])
  for (const b of smokeVerifierBlobs(SMOKE_TASK_IDS)) assert.match(b.blob, /^[a-f0-9]{40}$/)
  assert.equal(Object.keys(LEDGER_LITE).length, 20)
  assert.equal(new Set(Object.values(LEDGER_LITE).map(i => i.blob)).size, 20, 'twenty distinct protected tests')
})

test('digests are deterministic, order independent and depend on the selection', () => {
  const all = smokeDigests(SMOKE_TASK_IDS)
  assert.deepEqual(all, smokeDigests([...SMOKE_TASK_IDS].reverse()))
  const one = smokeDigests(['ll-money-text'])
  for (const key of ['taskManifestSha256', 'acceptanceSha256', 'verifierSetSha256'] as const) {
    assert.match(all[key], /^[a-f0-9]{64}$/)
    assert.notEqual(all[key], one[key], key)
  }
  assert.throws(() => smokeDigests(['ll-unknown']), /smoke_task_unknown/)
})

test('the cohort digests are pinned; changing any item, argv, dependency or blob must be deliberate', () => {
  assert.deepEqual(smokeDigests(SMOKE_TASK_IDS), {
    taskManifestSha256: '576c9d4d1d9064abfd21be5efebe747a835a99fddf5c8f8f57d04f7cd4f51043',
    acceptanceSha256: 'f64e1f3e18ce9c9216cff35ecb2e0a127702b8ee3a5b225c7316b1cd9de8ee31',
    verifierSetSha256: '63edf009c61afd934a601454ac171d2e0664ae8a0ad93194202ef63f6c8fb5f7',
  })
})
