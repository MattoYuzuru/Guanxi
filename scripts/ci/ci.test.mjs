import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { affected } from './affected.mjs'
import { candidateArtifact, completion } from './finish.mjs'
import { coreArguments, indirectScripts, inventory, matrix, tasks, validateInventory } from './tasks.mjs'

test('current root composition and workspace build/test entrypoints are classified', () => validateInventory())
test('new workspaces, build/test entrypoints and root composition cannot silently disappear', () => {
  assert.throws(() => validateInventory([...inventory(), { name: '@guanxi/future', scripts: { build: 'tool build' } }]), /Unclassified workspace/)
  for (const script of ['test:future', 'build:desktop', 'bundle:build']) {
    const packages = structuredClone(inventory()); packages[1].scripts[script] = 'tool'
    assert.throws(() => validateInventory(packages), /Unclassified entrypoint/)
  }
  const packages = structuredClone(inventory()); packages[0].scripts.test += ' && npm run test:future'
  assert.throws(() => validateInventory(packages), /Root npm test changed/)
  const layout = structuredClone(inventory()); layout[0].workspaces.push('plugins/*')
  assert.throws(() => validateInventory(layout), /Workspace layout changed/)
})
test('draft matrix is quick; ready matrix contains every unique declared task', () => {
  assert.deepEqual(matrix(false).include.map(x => x.id), ['quality'])
  assert.deepEqual(matrix(true).include.map(x => x.id), tasks.map(x => x.id))
  assert.equal(new Set(tasks.map(x => x.id)).size, tasks.length)
  assert.equal(matrix(true).include.filter(x => x.native).length, 3)
  assert.equal(matrix(true).include.find(x => x.catalog).os, 'ubuntu-24.04-arm', 'exact G13 baselines use the observed ARM raster platform')
})
test('adding steps to an indirectly covered existing entrypoint cannot silently omit them', () => {
  for (const [workspace, scripts] of Object.entries(indirectScripts)) for (const script of Object.keys(scripts)) {
    const packages = structuredClone(inventory())
    const pkg = packages.find(p => p.name === workspace)
    pkg.scripts[script] += ' && node newly-required-step.mjs'
    assert.throws(() => validateInventory(packages), /Indirect entrypoint changed/, `${workspace}:${script}`)
  }
})
test('Node shards execute disjoint files and preserve import guards (flags precede paths)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'guanxi-ci-shards-'))
  try {
    const guard = join(directory, 'guard.mjs'); writeFileSync(guard, 'process.env.CI_TEST_GUARD="yes"')
    const files = [1, 2, 3, 4].map(n => {
      const file = join(directory, `${n}.test.mjs`)
      writeFileSync(file, `import {test} from 'node:test'; import assert from 'node:assert/strict'; test('fixture-${n}',()=>assert.equal(process.env.CI_TEST_GUARD,'yes'))`)
      return file
    })
    const counts = []
    for (const n of [1, 2]) {
      const report = join(directory, `${n}.xml`)
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
      execFileSync(process.execPath, coreArguments(`node --import '${guard}' --test ${files.map(f => `'${f}'`).join(' ')}`, `${n}/2`, report), { env })
      const xml = readFileSync(report, 'utf8'); counts.push([...xml.matchAll(/name="fixture-(\d)"/g)].map(m => m[1]))
    }
    assert.equal(counts[0].length, 2); assert.equal(counts[1].length, 2)
    assert.deepEqual([...new Set(counts.flat())].sort(), ['1', '2', '3', '4'])
    assert.throws(() => coreArguments('node --test test.ts && false', '1/2', 'report'), /literal node/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

function green() {
  return {
    head: 'head', pr: { draft: false, state: 'open', head: { sha: 'head' }, base: { sha: 'base' }, merge_commit_sha: 'merge' },
    run: { head_sha: 'head', event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/run' },
    candidate: { head: 'head', base: 'base', tested: 'merge' },
    jobs: ['Full gate', ...tasks.map(t => `check / ${t.id}`)].map(name => ({ name, status: 'completed', conclusion: 'success' })),
  }
}
test('completion accepts only current reviewed candidate with every job actually successful', () => {
  assert.equal(completion(green()).ok, true)
  for (const change of [
    x => { x.pr.head.sha = 'new' }, x => { x.run.head_sha = 'old' },
    x => { x.pr.base.sha = 'new' }, x => { x.pr.merge_commit_sha = 'new' },
    x => { x.pr.draft = true }, x => { x.run.event = 'workflow_dispatch' },
    x => { x.run.conclusion = 'cancelled' }, x => { x.run.status = 'in_progress' },
    x => { x.jobs.pop() }, x => { x.jobs.push(x.jobs[0]) },
    x => { x.jobs[1].conclusion = 'skipped' }, x => { x.jobs[1].conclusion = 'failure' },
  ]) { const value = green(); change(value); assert.equal(completion(value).ok, false) }
})
test('rerun of failed jobs reuses the successful plan artifact from the same workflow run', () => {
  const value = green(); value.run.run_attempt = 2
  assert.equal(completion(value).ok, true)
  const workflow = readFileSync(new URL('../../.github/workflows/full-gate.yml', import.meta.url), 'utf8')
  assert.match(workflow, new RegExp(`name: ${candidateArtifact}\\n`))
  assert.equal(candidateArtifact, 'candidate')
})
test('affected guidance widens unknown/contract scope and does not execute checks', () => {
  assert.deepEqual(affected(['docs/example.md']).areas, ['docs'])
  assert.deepEqual(affected(['packages/contract/src/index.ts']).areas, ['shared'])
  assert.deepEqual(affected(['packages/web/src/App.tsx', 'packages/ui/tokens/base.tokens.json']).areas, ['ui', 'web'])
  assert.deepEqual(affected(['packages/future/src/new.ts']).areas, ['shared'])
  assert.match(affected(['packages/cli/src/bin.ts']).guidance[0].commands.join(' '), /typecheck --workspace guanxi/)
  assert.match(affected(['packages/ui/src/index.ts']).guidance[0].commands.join(' '), /typecheck --workspace @guanxi\/ui/)
})
test('catalog config uses the explicit retained artifact directory in host/container runs', async () => {
  const original = process.env.GUANXI_GATE_ARTIFACTS
  try {
    process.env.GUANXI_GATE_ARTIFACTS = '/work/.ci-results/catalog/G13-fixture'
    const { default: config } = await import('../../packages/ui/gates/catalog/browser/playwright.config.ts')
    assert.equal(config.outputDir, process.env.GUANXI_GATE_ARTIFACTS)
    const source = readFileSync(new URL('../../packages/ui/gates/catalog/browser/gates.ts', import.meta.url), 'utf8')
    assert.match(source, /GUANXI_GATE_ARTIFACTS: join\(docker \? '\/work'/)
  } finally {
    if (original === undefined) delete process.env.GUANXI_GATE_ARTIFACTS
    else process.env.GUANXI_GATE_ARTIFACTS = original
  }
})
