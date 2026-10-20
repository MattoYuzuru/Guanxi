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
    for (const item of seeded) {
      assert.equal(item.actual, 'fail', `${item.gate} ${item.seeded} passed`)
      assert.ok(item.ok, `${item.gate} ${item.seeded} failed for another reason: ${messages(item)}`)
    }
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

  it('G11 does not let an unsigned deprecation put a draft on a product screen', () => {
    assert.match(messages(find('G11', 'deprecated-laundering')), /product code uses deprecated component "badge"/)
  })

  it('G12 fails closed without a base, on a branch-bootstrapped key and on a restored approval', () => {
    assert.match(messages(find('G12', 'base-branch-unknown')), /cannot verify the trusted key set: no base branch/)
    assert.match(messages(find('G12', 'agent-key-bootstrapped-on-branch')), /first trusted key was added outside the base branch/)
    assert.match(messages(find('G12', 'old-approval-restored')), /does not follow the signed revocation/)
    assert.match(messages(find('G12', 'approval-over-base-deprecation')), /approval restores a component deprecated on main/)
    assert.match(messages(find('G12', 'approval-revoked-in-record')), /approval is invalid: revoked/)
    assert.match(messages(find('G12', 'key-version-reset')), /version_changed_without_rotation/)
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

describe('new-component scaffold', () => {
  it('creates a draft folder with a story per state that G10 rejects until the docs are written', async () => {
    const { execFileSync } = await import('node:child_process')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { createScratch } = await import('../lib/scratch.ts')
    const { readFolder } = await import('../../../catalog/tooling/inventory.ts')
    const { buildManifest, serialiseManifest } = await import('../../../catalog/tooling/manifest.ts')
    const { defaultUsageScope } = await import('../../../catalog/tooling/usage.ts')
    const { g10 } = await import('../g10-catalog-complete.ts')
    const scratch = createScratch(join(import.meta.dirname, '..', '..', '..', '..', '..'))
    try {
      const script = join(import.meta.dirname, '..', '..', '..', '..', '..', '.agents', 'skills', 'guanxi-ui', 'scripts', 'new-component.mjs')
      execFileSync(process.execPath, [script, 'context-ring', '--level', 'pattern', '--states', 'default,unknown', '--repo', scratch.repoRoot])
      const folder = readFolder(scratch.uiRoot, 'context-ring')
      assert.deepEqual(folder.stories.map((story) => story.name), ['default', 'unknown'])
      assert.equal(JSON.parse(readFileSync(join(folder.dir, 'context-ring.review.json'), 'utf8')).status, 'draft')
      writeFileSync(join(scratch.uiRoot, 'catalog', 'manifest.json'), serialiseManifest(buildManifest(scratch.uiRoot, defaultUsageScope(scratch.repoRoot))))
      const context = { repoRoot: scratch.repoRoot, uiRoot: scratch.uiRoot, usageScope: defaultUsageScope(scratch.repoRoot), release: false }
      const before = await g10.run(context)
      assert.equal(before.status, 'fail')
      assert.ok(before.findings.every((finding) => /still has a TODO/.test(finding.message)), JSON.stringify(before.findings))
      const docs = join(folder.dir, 'context-ring.docs.md')
      writeFileSync(docs, readFileSync(docs, 'utf8').replaceAll('TODO: write this section.', 'Written.'))
      const after = await g10.run(context)
      assert.equal(after.status, 'pass', JSON.stringify(after.findings))
    } finally {
      scratch.dispose()
    }
  })
})
