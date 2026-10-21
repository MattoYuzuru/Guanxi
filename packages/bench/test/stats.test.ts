import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { conclusion, holm, mcnemar, mean, noiseFloor, pairedBootstrap } from '../src/stats.ts'
import { passHat } from '../src/reducers.ts'

test('matches upstream Inspect AI scalar mean and pass^k fixture, including fewer than k epochs', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/inspect-reducers.json', import.meta.url), 'utf8'))
  assert.equal(fixture.rows.length, 20)
  for (const row of fixture.rows) {
    assert.equal(mean(row.scores), row.mean)
    const actual = passHat(row.scores, row.k)
    if (row.passHat === null) assert.equal(actual, null)
    else assert.ok(actual !== null && Math.abs(actual - row.passHat) < 1e-12)
  }
  assert.equal(passHat([1, 1, 0, 0], 2), 1 / 6)
})
test('detects a planted 10-point regression at 80 tasks x 3 seeds; no false non-inferiority', () => {
  const pairs = Array.from({ length: 80 }, (_, i) => ({ task: `${i}`, control: [1, 1, 1], candidate: Array(3).fill(i < 8 ? 0 : 1) }))
  const ci = pairedBootstrap(pairs)
  assert.ok(Math.abs(ci.delta + 0.1) < 1e-12)
  // MUTATION: regression-detection
  assert.ok(ci.upper < 0, JSON.stringify(ci))
  assert.equal(conclusion(ci, 'simplification', 0).regression, true)
  assert.equal(conclusion(ci, 'simplification', 0).nonInferior, false)
  assert.ok(Math.abs(mcnemar(pairs.map(() => 1), pairs.map(p => p.candidate[0])).p - 0.0078125) < 1e-14)
})
test('bootstrap clusters by task and averages seeds instead of treating epochs as independent', () => {
  const pairs = Array.from({ length: 20 }, (_, i) => ({ task: `${i}`, control: [1], candidate: [Number(i % 2 === 0)] }))
  const a = pairedBootstrap(pairs)
  const b = pairedBootstrap(pairs.map(p => ({ ...p, control: Array(5).fill(p.control[0]), candidate: Array(5).fill(p.candidate[0]) })))
  assert.deepEqual(a, b)
  assert.equal(a.delta, -0.5)
  assert.deepEqual(pairedBootstrap(pairs), a)
  assert.throws(() => pairedBootstrap([pairs[0]!, pairs[0]!]), /duplicate_task/)
  assert.throws(() => pairedBootstrap([{ task: 'a', control: [1], candidate: [1, 0] }, pairs[1]!]), /unpaired_seeds/)
})
test('exact McNemar is symmetric, handles all ties and large discordant counts', () => {
  assert.deepEqual(mcnemar([1, 1], [1, 1]), { lost: 0, won: 0, p: 1 })
  const a = mcnemar([1, 1, 1, 0], [0, 0, 0, 1])
  assert.equal(a.p, 0.625)
  assert.equal(mcnemar([0, 0, 0, 1], [1, 1, 1, 0]).p, a.p)
  assert.ok(mcnemar(Array(2000).fill(1), Array(2000).fill(0)).p < 0.001)
})
test('Holm preserves input order and monotonic adjusted p-values', () => {
  assert.deepEqual(holm([0.04, 0.001, 0.02, 0.8]), [0.08, 0.004, 0.06, 0.8])
  assert.throws(() => holm([NaN]))
})
test('protected margins are strict; additions require superiority or 15% saving plus non-inferiority', () => {
  assert.equal(conclusion({ lower: -0.05, upper: 0.1 }, 'simplification', 0).statisticalEligibility, false)
  assert.equal(conclusion({ lower: 0, upper: 0.1 }, 'addition', 0).statisticalEligibility, false)
  assert.equal(conclusion({ lower: -0.01, upper: 0.1 }, 'addition', 0.149).statisticalEligibility, false)
  assert.equal(conclusion({ lower: -0.01, upper: 0.1 }, 'addition', 0.15).statisticalEligibility, true)
  assert.equal(conclusion({ lower: 0.001, upper: 0.1 }, 'addition', 0).statisticalEligibility, true)
})
test('one arm noise floor requires exactly five seeds and reports observed variation', () => {
  assert.deepEqual(noiseFloor([[1, 0, 1, 0, 1], [1, 1, 1, 0, 1]]).rates, [1, 0.5, 1, 0, 1])
  assert.equal(noiseFloor([[1, 0, 1, 0, 1], [1, 1, 1, 0, 1]]).range, 1)
  assert.throws(() => noiseFloor([[1], [0]]))
  assert.throws(() => passHat([0.5], 1))
})
