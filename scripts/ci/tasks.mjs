import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '../..')
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'))
const npm = (script, workspace) => ['npm', 'run', script, ...(workspace ? ['--workspace', workspace] : [])]
export const tasks = [
  { id: 'quality', commands: [npm('typecheck'), npm('lint'), npm('lint:md'), npm('check:licenses'), npm('ui:check'), ['node', '--test', 'scripts/*.test.mjs', 'scripts/ci/*.test.mjs']] },
  { id: 'gate-tests', commands: [npm('test:codemods'), npm('test:gates', '@guanxi/ui')] },
  ...[1, 2, 3].map(shard => ({ id: `core-${shard}`, native: true, coreShard: `${shard}/3` })),
  { id: 'units', commands: [npm('test:kernel'), npm('test:bench'), npm('test:web'), npm('test:ui')] },
  ...[1, 2].map(shard => ({ id: `web-browser-${shard}`, browser: true, commands: [['npm', 'run', 'test:browser', '--workspace', '@guanxi/web', '--', `--shard=${shard}/2`]] })),
  { id: 'catalog-browser', os: 'ubuntu-24.04-arm', browser: true, catalog: true, commands: [npm('ui:check:browser')] },
  // The CLI bundles the web output. Keep the canonical root build's dependency order.
  { id: 'build', commands: [npm('build')] },
  { id: 'storybook', commands: [npm('build-storybook', '@guanxi/ui')] },
  // Electron shell (U2): pure units on Linux; the Electron-launching suites on macOS, where the shell ships first (D-221).
  { id: 'desktop', commands: [npm('build', '@guanxi/desktop'), npm('test', '@guanxi/desktop')] },
  { id: 'desktop-electron', os: 'macos-15', commands: [npm('test:electron', '@guanxi/desktop')] },
  { id: 'mac-signer', os: 'macos-15', commands: [['node', '--import', './packages/server/test/setup/no-ambient-key-file.mjs', '--test', '--test-concurrency=1', 'packages/server/test/ui-catalog-signer-helper.test.ts', 'packages/server/test/ui-catalog-signer-install.test.ts', 'packages/server/test/ui-catalog-signer-exit-gates.test.ts']] },
]

// Classify new test/build entrypoints explicitly: unknown coverage must fail, not disappear.
export const coverage = {
  'guanxi-monorepo': ['test', 'test:core', 'test:kernel', 'test:web', 'test:web:browser', 'test:ui', 'test:bench', 'test:codemods', 'build', 'tokens:build'],
  '@guanxi/bench': ['test', 'test:mutations'], // Mutation campaign is a separate opt-in experiment.
  guanxi: ['test', 'build'],
  '@guanxi/contract': [],
  '@guanxi/desktop': ['test', 'test:electron', 'build'],
  '@guanxi/kernel': ['test'],
  '@guanxi/server': ['test', 'build'],
  '@guanxi/ui': ['test', 'test:gates', 'build-storybook', 'harness:build', 'tokens:build'], // Harness in browser gate; generated tokens checked by G2.
  '@guanxi/web': ['test', 'test:browser', 'build'],
}
const rootTests = ['ui:check', 'test:codemods', 'test:gates --workspace @guanxi/ui', 'test:core', 'test:kernel', 'test:web', 'test:ui', 'test:bench']
// These canonical entrypoints are covered indirectly (shards, wrappers or byte-for-byte
// generator checks). A new step in their bodies needs an explicit coverage decision.
export const indirectScripts = {
  'guanxi-monorepo': {
    'test:core': "node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test 'packages/server/test/**/*.test.ts' 'packages/cli/test/**/*.test.ts'",
    'test:web:browser': 'npm run test:browser --workspace @guanxi/web',
    'tokens:build': 'npm run tokens:build --workspace @guanxi/ui',
  },
  guanxi: { test: "node --test 'test/**/*.test.ts'" },
  '@guanxi/server': { test: "node --import ./test/setup/no-ambient-key-file.mjs --test 'test/**/*.test.ts'" },
  '@guanxi/kernel': { test: "node --test 'test/**/*.test.ts'" },
  '@guanxi/ui': {
    'tokens:build': 'node tokens/build.mjs',
    'harness:build': 'vite build --config catalog/harness/vite.config.ts',
  },
}
export function inventory(projectRoot = root) {
  return [readJSON(resolve(projectRoot, 'package.json')), ...readdirSync(resolve(projectRoot, 'packages'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => readJSON(resolve(projectRoot, 'packages', d.name, 'package.json')))]
}
export function validateInventory(packages = inventory()) {
  const errors = []
  if (JSON.stringify(packages[0].workspaces) !== JSON.stringify(['packages/*'])) errors.push('Workspace layout changed: extend CI discovery and classify every new workspace')
  for (const pkg of packages) {
    if (!(pkg.name in coverage)) errors.push(`Unclassified workspace ${pkg.name}: add its checks/builds to scripts/ci/tasks.mjs`)
    for (const [name, body] of Object.entries(indirectScripts[pkg.name] ?? {})) {
      if (pkg.scripts?.[name] !== body) errors.push(`Indirect entrypoint changed ${pkg.name}:${name}: reconcile its actual CI coverage before accepting this body`)
    }
    for (const name of Object.keys(pkg.scripts ?? {})) {
      if (/^(test|build)(:|-|$)|:build$/.test(name) && !coverage[pkg.name]?.includes(name)) errors.push(`Unclassified entrypoint ${pkg.name}:${name}`)
    }
  }
  const composed = packages[0].scripts.test.split(' && ').map(s => s.replace(/^npm run /, ''))
  if (JSON.stringify(composed) !== JSON.stringify(rootTests)) errors.push('Root npm test changed: update and verify CI leaf coverage')
  for (const [name, scripts] of Object.entries(coverage)) {
    const pkg = packages.find(p => p.name === name)
    if (!pkg) errors.push(`Missing workspace ${name}: reconcile CI inventory`)
    for (const script of scripts) if (pkg && !pkg.scripts?.[script]) errors.push(`Missing entrypoint ${name}:${script}: reconcile CI inventory`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

export function coreArguments(script, shard, report) {
  // Accept only the existing literal Node invocation; reject shell syntax on future changes.
  if (!/^node\s/.test(script) || /[;&|`$<>\\]/.test(script)) throw new Error('test:core must remain a literal node command; reconcile the CI runner')
  const args = script.match(/'[^']*'|"[^"]*"|[^\s]+/g).slice(1).map(x => x.replace(/^(['"])(.*)\1$/, '$2'))
  const index = args.indexOf('--test')
  if (index < 0 || !/^\d+\/\d+$/.test(shard)) throw new Error('Invalid core test command/shard')
  // Node ignores test flags placed after file patterns: insert before them.
  args.splice(index + 1, 0, `--test-shard=${shard}`, '--test-concurrency=2', '--test-reporter=spec', '--test-reporter=junit', '--test-reporter-destination=stdout', `--test-reporter-destination=${report}`)
  return args
}

export function matrix(full) {
  return { include: tasks.filter(t => full || t.id === 'quality').map(t => ({ id: t.id, os: t.os ?? 'ubuntu-24.04', native: !!t.native, browser: !!t.browser, catalog: !!t.catalog })) }
}
