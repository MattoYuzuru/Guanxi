import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Budget } from '../src/budget.ts'
import { fixtureExecutor, runBench } from '../src/runner.ts'
import { plan } from './helpers.ts'

test('over-cap experiment is refused BEFORE dispatch, including the whole run and equal per-arm limits', async () => {
  const budget = new Budget(':memory:'); let launched = 0
  const p = plan({ connection: 'secret://k3/bench', maxTrialMicrousd: 101, maxTrialTokens: 1, dailyTokenCap: 1000, armCapMicrousd: 1000 })
  await assert.rejects(runBench(p, budget, { boundedBilling: true, async run() { launched++; return [] } }, { paidApproval: { experiment: p.id, approvedBy: 'integrator' } }), /budget_cap_exceeded/)
  assert.equal(launched, 0); assert.equal(budget.rows().length, 0); budget.close()
})
test('D-150 monthly cap and provider daily token cap are cumulative across reopened ledgers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b1-ledger-')); const file = join(dir, 'budget.sqlite')
  const paid = plan({ tasks: plan().tasks.slice(0, 1), arms: plan().arms.slice(0, 1), connection: 'secret://k3/bench', maxTrialMicrousd: 100_000_000, maxTrialTokens: 5, dailyTokenCap: 10, armCapMicrousd: 100_000_000 })
  const now = new Date('2026-10-21T00:00:00Z')
  const first = new Budget(file); first.reserve(paid, now); first.close()
  const a = new Budget(file); const b = new Budget(file)
  b.reserve({ ...paid, id: 'second' }, now)
  assert.throws(() => a.reserve({ ...paid, id: 'third' }, now), /budget_cap_exceeded/)
  assert.equal(a.rows().length, 2)
  // Month rollover does not erase the previous month's reservations.
  a.reserve({ ...paid, id: 'next-month' }, new Date('2026-11-01T00:00:00Z'))
  assert.equal(a.rows().length, 3)
  a.close(); b.close(); rmSync(dir, { recursive: true })
})
test('daily token cap covers all arms and reservations; a different provider has its own limit', () => {
  const budget = new Budget(':memory:')
  const p = plan({ maxTrialTokens: 2, dailyTokenCap: 40 })
  budget.reserve(p)
  assert.throws(() => budget.reserve({ ...p, id: 'another' }), /budget_cap_exceeded/)
  budget.reserve({ ...p, id: 'other-provider', provider: 'another' })
  assert.equal(budget.rows().length, 2); budget.close()
})
test('crashes and duplicate/restarted IDs retain the reservation and never dispatch again', async () => {
  const budget = new Budget(':memory:'); let launches = 0
  const executor = { async run() { launches++; throw new Error('fixture_crash') } }
  await assert.rejects(runBench(plan(), budget, executor), /fixture_crash/)
  await assert.rejects(runBench(plan(), budget, executor), /run_already_reserved/)
  assert.equal(launches, 1); assert.equal(budget.rows()[0]!.state, 'reserved'); budget.close()
})
test('successful fixture run settles; paid execution needs both explicit approval and bounded billing', async () => {
  const budget = new Budget(':memory:')
  const rows = await runBench(plan(), budget, fixtureExecutor())
  assert.equal(rows.length, 20); assert.equal(budget.rows()[0]!.state, 'settled')
  const paid = plan({ id: 'paid', connection: 'secret://k3/bench', maxTrialMicrousd: 1, maxTrialTokens: 1, armCapMicrousd: 100, dailyTokenCap: 100 })
  let launched = 0
  const executor = { async run() { launched++; return [] } }
  await assert.rejects(runBench(paid, budget, executor), /paid_run_requires_integrator/)
  await assert.rejects(runBench(paid, budget, executor, { paidApproval: { experiment: 'paid', approvedBy: 'integrator' } }), /bounded_gateway/)
  assert.equal(launched, 0); assert.equal(budget.rows().length, 1); budget.close()
})
test('cancel before launch has no charge; reported trial overspend fails closed and keeps the hold', async () => {
  const budget = new Budget(':memory:')
  await assert.rejects(runBench(plan(), budget, fixtureExecutor(), { signal: AbortSignal.abort() }))
  assert.equal(budget.rows().length, 0)
  await assert.rejects(runBench(plan(), budget, { async run(p) { return (await fixtureExecutor().run(p) as any[]).map(x => ({ ...x, costMicrousd: 1 })) } }), /trial_bound_violated/)
  assert.equal(budget.rows()[0]!.state, 'reserved'); budget.close()
})

test('a metered run cannot straddle a UTC budget day or month', () => {
  const budget = new Budget(':memory:')
  assert.throws(() => budget.reserve(plan({ maxTrialTokens: 1, dailyTokenCap: 100 }), new Date('2026-10-31T23:59:50Z')), /crosses_utc_budget_day/)
  assert.equal(budget.rows().length, 0); budget.close()
})

test('monthly money ceiling alone refuses dispatch with other caps nonbinding', async () => {
  const budget = new Budget(':memory:', () => new Date('2026-10-21T12:00:00Z'))
  const p = plan({ tasks: plan().tasks.slice(0, 1), arms: plan().arms.slice(0, 1),
    connection: 'secret://k3/bench', maxTrialMicrousd: 150_000_000, maxTrialTokens: 1,
    dailyTokenCap: 1_000_000, armCapMicrousd: 200_000_000 })
  budget.reserve(p, new Date('2026-10-01T12:00:00Z'))
  const next = { ...p, id: 'over-monthly', maxTrialMicrousd: 60_000_000 }
  let launched = 0
  await assert.rejects(runBench(next, budget, { boundedBilling: true, async run() { launched++; return [] } }, { paidApproval: { experiment: next.id, approvedBy: 'integrator' } }), /budget_cap_exceeded/)
  assert.equal(launched, 0)
  assert.equal(budget.rows().length, 1)
  budget.close()
})
