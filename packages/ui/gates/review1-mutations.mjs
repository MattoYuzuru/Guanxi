// Review 1 mutate.mjs survivors, narrowed to independent regression assertions.
// Opt-in: node packages/ui/gates/review1-mutations.mjs; sources are always restored.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const plugin = 'packages/ui/gates/lint/eslint-plugin.mjs'
const mutations = [
  ['SVG paint loop', plugin, 'for (const match of text.matchAll(/\\b(fill|stroke|stop-color|flood-color|lighting-color)', 'for (const match of [] || text.matchAll(/\\b(fill|stroke|stop-color|flood-color|lighting-color)', 'L5 standalone SVG'],
  ['custom colour property', plugin, '|| /^(?:--.*(?:color|colour|background|foreground)|--(?:bg|fg)(?:-|$)|--.*-(?:bg|fg)(?:-|$))/.test(name)', '', 'L5 custom colour'],
  ['require.resolve', plugin, "keyOf(node.property) === 'resolve' && moduleLoader(node.object, context) || ", '', 'L5 require.resolve'],
  ['brand traversal', plugin, " && !value.includes('..')", '', 'L5 require.resolve'],
  ['ledger path', 'packages/ui/gates/lint/suppressions.mjs', '/^packages\\/web\\/src\\/.+', '/^.+', 'L5 native suppression ledger'],
  ['plugin discovery', 'packages/ui/gates/extensions/lint.gate.mjs', '...await additionalSources(ctx.root)]', ']', 'L5 plugin discovery'],
]
for (const [name, file, from, to, test] of mutations) {
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from)) throw Error(`Missing mutation: ${name}`)
  let result
  try {
    writeFileSync(file, original.replace(from, to))
    result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${test}`, 'packages/ui/gates/lint.test.mjs'], { encoding: 'utf8', timeout: 120000 })
  } finally { writeFileSync(file, original) }
  const output = result.stdout + result.stderr
  if (result.status !== 1 || !output.includes('AssertionError')) throw Error(`Survived or failed without an assertion: ${name}\n${output}`)
  process.stdout.write(`KILLED ${name}: ${output.split('\n').find(line => line.includes('AssertionError'))?.trim()}\n`)
}
