import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function files(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (['node_modules', 'dist', 'generated', 'test-results'].includes(entry.name) ? [] : files(join(root, entry.name))) : [join(root, entry.name)]) }
test('Dockview is exactly pinned, MIT, adapter-isolated and enterprise is explicitly denied', () => {
  const root = new URL('../../..', import.meta.url).pathname
  for (const name of ['dockview-core', 'dockview-react']) {
    const manifest = JSON.parse(readFileSync(join(root, 'packages/web/package.json'), 'utf8'))
    const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies[name], '8.6.1')
    assert.equal(installed.license, 'MIT')
  }
  for (const file of files(join(root, 'packages')).filter(file => /\.(?:tsx?|mjs|css)$/.test(file) && file.includes('/src/'))) {
    if (file.includes('/features/workspace/WorkspaceLayout/')) continue
    assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:from\s*|import\s*|import\s*\(\s*|@import\s*)['"]dockview(?:-core|-react|-enterprise)?(?:\/|['"])/, file)
  }
  assert.match(readFileSync(join(root, 'scripts/check-licenses.mjs'), 'utf8'), /DENIED_PACKAGES = new Set\(\['dockview-enterprise'\]\)/)
  assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages['node_modules/dockview-enterprise'], undefined)
})

test('licence gate rejects a synthetic enterprise package even if metadata claims MIT', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'guanxi-license-boundary-'))
  try {
    mkdirSync(join(fixture, 'packages'))
    const module = join(fixture, 'node_modules/dockview-enterprise')
    mkdirSync(module, { recursive: true })
    writeFileSync(join(module, 'package.json'), JSON.stringify({ name: 'dockview-enterprise', version: '0.0.0-fixture', license: 'MIT' }))
    const result = spawnSync(process.execPath, [new URL('../../../scripts/check-licenses.mjs', import.meta.url).pathname], { cwd: fixture, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /dockview-enterprise@0.0.0-fixture: denied package/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
