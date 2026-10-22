/**
 * G11 must apply the lifecycle policy to a product component's runtime component dependency
 * closure: a reviewed wrapper cannot hide a draft child, including through helper barrels,
 * aliases and cycles. The actual mounted shell is expected to fail this policy until the owner's
 * separate readiness decision; the test asserts that failure instead of promoting anything.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { defaultUsageScope } from '../../../catalog/tooling/usage.ts'
import { g11 } from '../g11-status-policy.ts'
import { createScratch, overlay, type Scratch } from '../lib/scratch.ts'
import type { GateContext, GateResult } from '../types.ts'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..')
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'g11')

function seededProductRoot(root: string): string {
  return join(root, 'packages', 'web', 'src', 'features', 'seeded')
}

function context(scratch: Scratch, release = false, productRoot = seededProductRoot(scratch.repoRoot)): GateContext {
  const usageScope = defaultUsageScope(scratch.repoRoot)
  return {
    repoRoot: scratch.repoRoot,
    uiRoot: scratch.uiRoot,
    usageScope: { ...usageScope, productRoots: [productRoot] },
    release,
    base: null,
  }
}

async function withFixture(name: string, run: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = createScratch(repoRoot)
  try {
    overlay(join(fixtures, name), scratch.repoRoot)
    await run(scratch)
  } finally {
    scratch.dispose()
  }
}

function errors(result: GateResult, file: string): GateResult['findings'] {
  return result.findings.filter((finding) => finding.severity === 'error' && finding.file === file)
}

describe('G11 transitive component lifecycle', () => {
  it('blocks the actual mounted shell on the draft components reached through its wrapper', async () => {
    for (const id of ['icon-button', 'menu', 'tooltip']) {
      const record = JSON.parse(
        readFileSync(join(repoRoot, 'packages/ui/src/components', id, `${id}.review.json`), 'utf8'),
      ) as { status: string }
      assert.equal(record.status, 'draft', `${id} must stay draft until the separate readiness decision`)
    }
    const result = await g11.run({
      repoRoot,
      uiRoot: join(repoRoot, 'packages/ui'),
      usageScope: defaultUsageScope(repoRoot),
      release: false,
      base: null,
    })
    const file = 'packages/web/src/features/shell/MountedShell.tsx'
    assert.deepEqual(errors(result, file).map((finding) => finding.component).sort(), ['icon-button', 'menu', 'tooltip'])
    assert.equal(result.status, 'fail')
    assert.ok(result.findings.some((finding) => finding.severity === 'warning' && finding.component === 'app-shell-chrome' && finding.file === file))
  })

  it('fails a reviewed wrapper on a draft child and names the child and product file', async () => {
    await withFixture('transitive-reviewed-wrapper', async (scratch) => {
      const result = await g11.run(context(scratch))
      const file = 'packages/web/src/features/seeded/G11WrapperUse.tsx'
      const error = result.findings.find((finding) => finding.severity === 'error' && finding.component === 'g11-child')
      assert.ok(error, JSON.stringify(result.findings))
      assert.equal(error.file, file)
      assert.match(error.message, /product code uses draft component "g11-child"/)
      assert.ok(result.findings.some((finding) => finding.severity === 'warning' && finding.component === 'g11-wrapper' && finding.file === file))
    })
  })

  it('finds two-hop and helper-barrel aliased drafts through the component graph', async () => {
    await withFixture('transitive-helper-alias', async (scratch) => {
      const result = await g11.run(context(scratch))
      const file = 'packages/web/src/features/seeded/G11ShellUse.tsx'
      assert.deepEqual(errors(result, file).map((finding) => finding.component).sort(), ['icon-button', 'tooltip'])
    })
  })

  it('terminates cycles and reports each component/file pair once', async () => {
    await withFixture('transitive-cycle', async (scratch) => {
      const result = await g11.run(context(scratch))
      const file = 'packages/web/src/features/seeded/G11CycleUse.tsx'
      const draft = errors(result, file).filter((finding) => finding.component === 'g11-cycle-b')
      assert.equal(draft.length, 1, JSON.stringify(result.findings))
      assert.match(draft[0]?.message ?? '', /product code uses draft component "g11-cycle-b"/)
    })
  })

  it('warns for reviewed dependencies in ordinary slices and fails for release', async () => {
    await withFixture('review-graph', async (scratch) => {
      const file = 'packages/web/src/features/seeded/G11ReviewUse.tsx'
      const ordinary = await g11.run(context(scratch))
      assert.deepEqual(
        ordinary.findings
          .filter((finding) => finding.severity === 'warning' && finding.file === file)
          .map((finding) => finding.component)
          .sort(),
        ['g11-review-a', 'g11-review-b', 'g11-review-c'],
      )
      assert.equal(ordinary.status, 'pass')
      const release = await g11.run(context(scratch, true))
      assert.deepEqual(
        errors(release, file).map((finding) => finding.component).sort(),
        ['g11-review-a', 'g11-review-b', 'g11-review-c'],
      )
      assert.equal(release.status, 'fail')
    })
  })

  it('ignores type-only and external edges', async () => {
    await withFixture('transitive-safe', async (scratch) => {
      const result = await g11.run(context(scratch))
      assert.equal(result.status, 'pass', JSON.stringify(result.findings))
      assert.ok(!result.findings.some((finding) => finding.component === 'tooltip'))
    })
  })

  it('keeps draft usage on the catalog-only route allowed', async () => {
    await withFixture('catalog-only-draft', async (scratch) => {
      const result = await g11.run({ ...context(scratch), usageScope: defaultUsageScope(scratch.repoRoot) })
      const file = 'packages/web/src/features/catalog/CatalogRoute.tsx'
      assert.ok(!result.findings.some((finding) => finding.file === file), JSON.stringify(result.findings.filter((finding) => finding.file === file)))
    })
  })
})
