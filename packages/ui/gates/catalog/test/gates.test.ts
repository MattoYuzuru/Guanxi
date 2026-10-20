/**
 * The catalog gates pass on the repository and fail on every seeded violation, for the
 * reason the violation targets (G17's contract for G10–G12 and G15).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { catalogGates } from '../registry.ts'
import { runSelftest, type SelftestCase } from '../run.ts'

const fast = catalogGates.filter((gate) => gate.mode === 'fast')
const cases: SelftestCase[] = await runSelftest(fast)

function find(gate: string, seeded: string | null): SelftestCase {
  const found = cases.find((item) => item.gate === gate && item.seeded === seeded)
  assert.ok(found, `no self-test case ${gate} ${seeded}`)
  return found
}

function messages(item: SelftestCase): string {
  return item.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message).join('\n')
}

describe('catalog gates self-test', () => {
  it('registers G10, G11, G12 and G15 as fast gates, each with a seeded violation', () => {
    assert.deepEqual(fast.map((gate) => gate.id), ['G10', 'G11', 'G12', 'G15'])
    for (const gate of fast) assert.ok(gate.seeded.length > 0, `${gate.id} has no seeded violation`)
  })

  it('passes every gate on a clean scratch copy of the repository', () => {
    for (const gate of fast) {
      const clean = find(gate.id, null)
      assert.equal(clean.actual, 'pass', `${gate.id}: ${messages(clean)}`)
    }
  })

  it('fails every seeded violation', () => {
    const seeded = cases.filter((item) => item.seeded !== null)
    assert.equal(seeded.length, fast.reduce((sum, gate) => sum + gate.seeded.length, 0))
    for (const item of seeded) assert.equal(item.actual, 'fail', `${item.gate} ${item.seeded} passed`)
  })

  it('G10 names the export without a catalog entry and the state without a story', () => {
    const missing = messages(find('G10', 'export-without-catalog-entry'))
    assert.match(missing, /missing new-thing\.stories\.tsx/)
    assert.match(missing, /missing new-thing\.docs\.md/)
    assert.match(missing, /missing new-thing\.review\.json/)
    assert.match(messages(find('G10', 'state-without-story')), /declared state "pressed" has no story/)
  })

  it('G11 fails a draft component on a product screen and names the file', () => {
    const item = find('G11', 'draft-on-product-screen')
    const error = item.findings.find((finding) => finding.severity === 'error')
    assert.equal(error?.component, 'button')
    assert.equal(error?.file, 'packages/web/src/features/seeded/SeededScreen.tsx')
    assert.match(error?.message ?? '', /uses draft component "button"/)
  })

  it('G12 fails agent-written approvals, edited signatures and unsigned key additions for their own reasons', () => {
    assert.match(messages(find('G12', 'agent-written-approved')), /approval is invalid: untrusted_key/)
    assert.match(messages(find('G12', 'agent-written-approved-unsigned')), /approval is invalid: unsigned_approval/)
    assert.match(messages(find('G12', 'signed-then-edited')), /approval is invalid: bad_signature/)
    assert.match(messages(find('G12', 'key-added-without-rotation')), /trusted keys changed without a valid rotation \(unsigned_change\)/)
  })

  it('G15 points at the literal text', () => {
    assert.match(messages(find('G15', 'literal-jsx-text')), /literal user-facing text "Save"/)
  })
})
