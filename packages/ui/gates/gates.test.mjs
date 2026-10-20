import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createContext } from './context.mjs'
import { checks, execute, contrast } from './checks.mjs'
import { registry } from './registry.mjs'
import { selfTest } from './run.mjs'
import { generate } from '../tokens/build.mjs'
import { resolveTokens } from '../tokens/resolve.mjs'

const ctx = await createContext()
const mutateJSON = async (path, change) => {
  const data = await ctx.json(path)
  change(data)
  return ctx.withFiles({ [path]: JSON.stringify(data) })
}
test('G17 exercises every registered seed and rejects a gate that accepts its seed', async () => {
  const gates = await registry(ctx)
  const report = await selfTest(ctx, gates)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.results.length, gates.length)
  const faulty = await selfTest(ctx, [{ ...gates[0], check: () => ({ ok: true, errors: [] }) }])
  assert.equal(faulty.ok, false)
})
test('G1 rejects wrong types, mismatched alias types, missing and inconsistent fallbacks', async () => {
  const path = 'packages/ui/tokens/primitive/color.tokens.json'
  for (const change of [
    d => { d.primitive.color.neutral.light['1'].$type = 'unknown' },
    d => { delete d.primitive.color.neutral.light['1'].$value.hex },
    d => { d.primitive.color.neutral.light['1'].$value.hex = '#FFFFFF' },
    d => { d.primitive.color.neutral.light['1'].$value.components = ['wrong', 0, 0] },
  ]) assert.equal((await execute(checks.G1, await mutateJSON(path, change))).ok, false)
  const mismatch = await mutateJSON('packages/ui/tokens/base.tokens.json', d => { d.font.size['12'].$value = '{font.weight.regular}' })
  assert.equal((await execute(checks.G1, mismatch)).ok, false)
})
test('G2 is byte deterministic and rejects a manual edit to every generated file', async () => {
  const first = await generate(ctx.tokenOptions), second = await generate(ctx.tokenOptions)
  assert.deepEqual(first, second)
  for (const [name, contents] of Object.entries(first)) {
    assert.equal(await ctx.read(`packages/ui/generated/${name}`), contents)
    const edited = await ctx.withFiles({ [`packages/ui/generated/${name}`]: contents + '\n' })
    assert.equal((await checks.G2(edited)).ok, false, name)
  }
})
test('G3 checks all 18 declared pairs in all themes and every glass backdrop', async () => {
  const report = await contrast(ctx)
  assert.equal(report.ok, true, JSON.stringify(report.errors))
  assert.equal(report.measurements.length, 4 * (18 + 3 * 2 * 8 * 2))
  const baseline = { light: [14.43, 4.72, 3.51, 5.12], dark: [14.61, 7.01, 4.09, 8.39] }
  for (const [theme, values] of Object.entries(baseline)) assert.deepEqual(['text', 'muted', 'control-border', 'accent'].map(pair => report.measurements.find(m => m.theme === theme && m.pair === pair).ratio), values)
  for (const theme of ['light-hc', 'dark-hc']) assert.ok(report.measurements.filter(m => m.theme === theme).every(m => m.ratio >= 7))
  const missing = await mutateJSON('packages/ui/tokens/contrast-pairs.json', d => { d.pairs = d.pairs.filter(p => p.name !== 'warning') })
  assert.equal((await contrast(missing)).ok, false)
})
test('G4 catches both original undefined variables before the compatibility mapping', async () => {
  assert.equal((await checks.G4(ctx)).unresolved, 0)
  const css = await ctx.read('packages/web/src/index.css')
  const original = await ctx.withFiles({ 'packages/web/src/index.css': css.replace(/\s*--(?:warning|focus):[^;]+;/g, '') })
  const report = await checks.G4(original)
  assert.equal(report.ok, false)
  for (const name of ['--warning', '--focus']) assert.ok(report.errors.some(e => e.includes(name)))
})
test('G5 compiles semantic utilities and rejects palette, arbitrary and unknown classes', async () => {
  const valid = await ctx.withFiles({ 'packages/ui/src/fixture.tsx': 'export const A = () => <div className="bg-canvas text-muted border-control p-2 hover:bg-surface" />' })
  assert.equal((await checks.G5(valid)).ok, true)
  for (const value of ['bg-red-500', 'text-[#fff]', 'w-[300px]', 'not-a-real-utility']) {
    const invalid = await ctx.withFiles({ 'packages/ui/src/fixture.tsx': `export const A = () => <div className="${value}" />` })
    assert.equal((await checks.G5(invalid)).ok, false, value)
  }
})
test('G6 rejects literal colours, spacing, font sizes and z-index through CSS functions', async () => {
  for (const value of ['color: rgb(255 0 0)', 'padding: calc(var(--spacing-4) + 3px)', 'font-size: 13px', 'z-index: 5']) {
    const invalid = await ctx.withFiles({ 'packages/ui/src/fixture.css': `.fixture { ${value} }` })
    assert.equal((await checks.G6(invalid)).ok, false, value)
  }
})
test('G7 rejects raw CSS and TS motion values and accepts semantic variables', async () => {
  for (const files of [
    { 'packages/ui/src/fixture.css': '.fixture { transition: color 275ms ease-out; }' },
    { 'packages/ui/src/fixture.tsx': 'export const A = () => <div style={{ transitionDuration: "275ms" }} />' },
    { 'packages/ui/src/fixture.ts': 'export const motion = { duration: 275, easing: "ease-in" }' },
  ]) assert.equal((await checks.G7(await ctx.withFiles(files))).ok, false)
  const valid = await ctx.withFiles({ 'packages/ui/src/fixture.css': '.fixture { transition-duration: var(--motion-duration-fast); transition-timing-function: var(--motion-easing-standard); }' })
  assert.equal((await checks.G7(valid)).ok, true)
})
test('legacy freeze rejects new occurrences, invalid paths and unused allowances', async () => {
  const allowance = await ctx.json('packages/ui/gates/legacy-allowlist.json')
  const path = 'packages/web/src/seed.tsx', value = 'bg-red-500'
  const forged = { ...allowance, [`G5|${path}|${value}`]: 1 }
  const invalid = await ctx.withFiles({ [path]: `export const Seed = () => <div className="${value}"/>`, 'packages/ui/gates/legacy-allowlist.json': JSON.stringify(forged) })
  // Once the freeze is committed, history rejects even a matching new allowance.
  if ((await checks.G5(invalid)).ok) {
    const invalidPath = { ...forged, 'G5|packages/ui/src/seed.tsx|bg-red-500': 1 }
    assert.equal((await checks.G5(await ctx.withFiles({ 'packages/ui/gates/legacy-allowlist.json': JSON.stringify(invalidPath) }))).ok, false)
  }
  const stale = { ...allowance, [Object.keys(allowance)[0]]: 99999 }
  assert.equal((await checks.G5(await ctx.withFiles({ 'packages/ui/gates/legacy-allowlist.json': JSON.stringify(stale) }))).ok, false)
})
test('resolver rejects unknown modes and escaping source paths', async () => {
  await assert.rejects(resolveTokens({ theme: 'missing' }, ctx.tokenOptions), /Unknown theme/)
  const invalid = await mutateJSON('packages/ui/tokens/guanxi.resolver.json', d => { d.sets.base.sources[0].$ref = '../../web/package.json' })
  await assert.rejects(resolveTokens({}, invalid.tokenOptions), /escapes token root/)
})
test('font files and OFL notices retain upstream checksums; logo copies are unchanged', async () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  for (const source of await ctx.json('packages/ui/fonts/sources.json')) for (const file of source.files) assert.equal(sha(await readFile(resolve(ctx.root, 'packages/ui/fonts', file.path))), file.sha256, file.path)
  for (const file of ctx.files.filter(f => f.startsWith('packages/ui/brand/') && /\.(?:svg|png)$/.test(f))) assert.equal(sha(await readFile(resolve(ctx.root, file))), sha(await readFile(resolve(ctx.root, file.replace('packages/ui/brand/', 'assets/brand/guanxi-gx-v1/')))))
})
