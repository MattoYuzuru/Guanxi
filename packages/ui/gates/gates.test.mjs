import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createContext } from './context.mjs'
import { checks, execute, contrast } from './checks.mjs'
import { registry } from './registry.mjs'
import { selfTest, runGates } from './run.mjs'
import { generate } from '../tokens/build.mjs'
import { resolveTokens } from '../tokens/resolve.mjs'

const ctx = await createContext()
const mutateJSON = async (path, change) => {
  const data = await ctx.json(path)
  change(data)
  return ctx.withFiles({ [path]: JSON.stringify(data) })
}
test('G17 exercises every registered seed and rejects a gate that accepts its seed', async () => {
  const gates = (await registry(ctx)).filter(g => g.mode === 'fast')
  const report = await selfTest(ctx, gates)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.results.length, gates.length)
  const faulty = await selfTest(ctx, [{ ...gates[0], check: () => ({ ok: true, errors: [] }) }])
  assert.equal(faulty.ok, false)
})
test('fast checks and their G17 never launch registered browser checks', async () => {
  let browserCalls = 0
  const report = await runGates(ctx, [{ id: 'G13', name: 'Browser', mode: 'browser', seed: 'packages/ui/gates/seeds/G1.json', check() { browserCalls++; return { ok: true, errors: [] } } }])
  assert.equal(report.ok, true)
  assert.equal(report.scope, 'fast')
  assert.equal(browserCalls, 0)
  assert.deepEqual(report.registered, [{ id: 'G13', mode: 'browser' }])
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
  for (const name of ['bad.name', 'bad{name', 'bad}name']) {
    const invalid = await mutateJSON('packages/ui/tokens/base.tokens.json', d => { d.font[name] = { $type: 'number', $value: 1 } })
    assert.equal((await execute(checks.G1, invalid)).ok, false, name)
  }
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
test('animation manifest validation rejects unsafe, unknown, mistyped and duplicate compositions', async () => {
  const path = 'packages/ui/tokens/motion-animations.json'
  const base = await ctx.json(path)
  const cases = [
    [/must be an object/, data => { data.animations[0] = 'spinner' }],
    [/unsafe utility name/, data => { data.animations[0].utility = 'Bad Name' }],
    [/unsafe keyframe name/, data => { data.animations[0].keyframes = '../guanxi-spin' }],
    [/unsupported field/, data => { data.animations[0].speed = 2 }],
    [/unsupported field/, data => { data.extra = true }],
    [/requires a non-empty string duration/, data => { data.animations[0].duration = { $value: 'motion.duration.loop' } }],
    [/motion\.duration/, data => { data.animations[0].duration = 'motion.duration.unknown' }],
    [/motion\.duration/, data => { data.animations[0].duration = 'primitive.duration.slow' }],
    [/motion\.easing/, data => { data.animations[0].easing = 'motion.duration.loop' }],
    [/motion\.easing/, data => { data.animations[0].easing = 'motion.easing.unknown' }],
    [/Duplicate animation utility/, data => { data.animations[1].utility = data.animations[0].utility }],
    [/Duplicate animation keyframes/, data => { data.animations[1].keyframes = data.animations[0].keyframes }],
    [/iterations/, data => { data.animations[2].iterations = 0 }],
    [/iterations/, data => { data.animations[2].iterations = '2' }],
    [/iterations/, data => { data.animations[2].iterations = true }],
    [/non-empty animations array/, data => { data.animations = [] }],
  ]
  for (const [message, change] of cases) {
    const invalid = structuredClone(base)
    change(invalid)
    await assert.rejects(generate((await ctx.withFiles({ [path]: JSON.stringify(invalid) })).tokenOptions), message)
  }
})
test('generator reads the animation manifest through the provided options.read', async () => {
  const path = 'packages/ui/tokens/motion-animations.json'
  const overridden = await ctx.json(path)
  overridden.animations.find(animation => animation.utility === 'spinner').utility = 'spinner-read'
  const output = await generate((await ctx.withFiles({ [path]: JSON.stringify(overridden) })).tokenOptions)
  assert.match(output['theme.css'], /--animate-spinner-read:/)
  assert.doesNotMatch(output['theme.css'], /--animate-spinner:/)
})
test('G3 checks all 20 declared pairs in all themes and every glass backdrop', async () => {
  const report = await contrast(ctx)
  assert.equal(report.ok, true, JSON.stringify(report.errors))
  assert.equal(report.measurements.length, 4 * (20 + 3 * 2 * 8 * 2))
  // FOUNDATIONS §1.1–1.3, including text on the accent hover and pressed fills (2026-10-20).
  const baseline = { light: [14.43, 4.72, 3.51, 5.12, 6.28, 7.11], dark: [14.61, 7.01, 4.09, 8.39, 9.08, 9.9] }
  for (const [theme, values] of Object.entries(baseline)) assert.deepEqual(['text', 'muted', 'control-border', 'accent', 'on-accent-hover', 'on-accent-pressed'].map(pair => report.measurements.find(m => m.theme === theme && m.pair === pair).ratio), values)
  for (const theme of ['light-hc', 'dark-hc']) assert.ok(report.measurements.filter(m => m.theme === theme).every(m => m.ratio >= 7))
  const missing = await mutateJSON('packages/ui/tokens/contrast-pairs.json', d => { d.pairs = d.pairs.filter(p => p.name !== 'warning') })
  assert.equal((await contrast(missing)).ok, false)
})
test('G3 rejects transparent foregrounds, backgrounds and glass colours', async () => {
  const path = 'packages/ui/tokens/semantic/color.light.tokens.json'
  for (const change of [
    (d, ink) => { d.color.text.primary.$value = { ...ink, alpha: 0 } },
    (d, ink) => { d.color.background.primary.$value = { ...ink, alpha: 0 } },
    (d, ink) => { d.material.text.$value = { ...ink, alpha: 0 } },
  ]) {
    const ink = (await ctx.json('packages/ui/tokens/primitive/color.tokens.json')).primitive.color.neutral.light['12'].$value
    const invalid = await mutateJSON(path, d => change(d, ink))
    assert.equal((await execute(checks.G1, invalid)).ok, true)
    assert.equal((await contrast(invalid)).ok, false)
  }
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
test('G5 follows constants, cva variants, conditional helpers and CSS apply', async () => {
  for (const source of [
    'const buttonVariants = cva("bg-red-500"); export const A = () => <div className={buttonVariants()} />',
    'const choice = cva("p-2", { variants: { intent: { primary: "bg-red-500" } }, defaultVariants: { intent: "primary" } });',
    'const choice = cva("p-2", { compoundVariants: [{ intent: "primary", className: "bg-red-500" }] });',
    'const unsafe = "bg-red-500"; export const A = () => <div className={unsafe}/>',
    'export const A = () => <div className={clsx({ "bg-red-500": true })}/>',
  ]) assert.equal((await checks.G5(await ctx.withFiles({ 'packages/ui/src/fixture.tsx': source }))).ok, false, source)
  const valid = 'const choice = cva("p-2", { variants: { intent: { primary: "bg-canvas" } }, defaultVariants: { intent: "primary" } }); export const A = () => <div className={choice({ intent: "primary" })}/>'
  assert.equal((await checks.G5(await ctx.withFiles({ 'packages/ui/src/fixture.tsx': valid }))).ok, true)
  assert.equal((await checks.G5(await ctx.withFiles({ 'packages/ui/src/fixture.css': '.fixture { @apply bg-red-500; }' }))).ok, false)
})
test('G6 rejects literal colours, spacing, font sizes and z-index through CSS functions', async () => {
  for (const value of ['color: rgb(255 0 0)', 'padding: calc(var(--spacing-4) + 3px)', 'font-size: 13px', 'font: 19px Arial', 'z-index: 5']) {
    const invalid = await ctx.withFiles({ 'packages/ui/src/fixture.css': `.fixture { ${value} }` })
    assert.equal((await checks.G6(invalid)).ok, false, value)
  }
})
test('G7 rejects raw CSS and TS motion values and accepts semantic variables', async () => {
  for (const files of [
    { 'packages/ui/src/fixture.css': '.fixture { transition: color 275ms ease-out; }' },
    { 'packages/ui/src/fixture.tsx': 'export const A = () => <div style={{ transitionDuration: "275ms" }} />' },
    { 'packages/ui/src/fixture.ts': 'export const motion = { duration: 275, easing: "ease-in" }' },
    { 'packages/ui/src/fixture.tsx': 'export const A = () => <div style={{ transitionTimingFunction: "linear" }} />' },
    { 'packages/ui/src/fixture.tsx': 'export const A = () => <div style={{ animationTimingFunction: "step-start" }} />' },
    { 'packages/ui/src/fixture.ts': 'export const motion = { ease: [0.2, 0, 0, 1] }' },
  ]) assert.equal((await checks.G7(await ctx.withFiles(files))).ok, false)
  const valid = await ctx.withFiles({ 'packages/ui/src/fixture.css': '.fixture { transition-duration: var(--motion-duration-fast); transition-timing-function: var(--motion-easing-standard); }' })
  assert.equal((await checks.G7(valid)).ok, true)
})
test('G6/G7 reject a literal animation shorthand while generated utilities and @apply pass', async () => {
  const shorthand = await ctx.withFiles({ 'packages/ui/src/fixture.css': '.fixture { animation: guanxi-spin 1s linear infinite; }' })
  for (const check of [checks.G6, checks.G7]) {
    const report = await check(shorthand)
    assert.equal(report.ok, false)
    assert.ok(report.errors.some(error => error.includes('packages/ui/src/fixture.css|animation:')), JSON.stringify(report.errors))
  }
  const utility = await ctx.withFiles({ 'packages/ui/src/fixture.css': '.fixture { @apply animate-spinner; }' })
  for (const [id, check] of [['G5', checks.G5], ['G6', checks.G6], ['G7', checks.G7]]) {
    const report = await check(utility)
    assert.equal(report.ok, true, `${id}: ${JSON.stringify(report.errors)}`)
  }
})
test('legacy freeze rejects new occurrences, invalid paths and unused allowances', async () => {
  const allowance = await ctx.json('packages/ui/gates/legacy-allowlist.json')
  const path = 'packages/web/src/seed.tsx', value = 'bg-red-500'
  const forged = { ...allowance, [`G5|${path}|${value}`]: 1 }
  const invalid = await ctx.withFiles({ [path]: `export const Seed = () => <div className="${value}"/>`, 'packages/ui/gates/legacy-allowlist.json': JSON.stringify(forged) })
  assert.equal((await checks.G5(invalid)).ok, false)
  const invalidPath = { ...forged, 'G5|packages/ui/src/seed.tsx|bg-red-500': 1 }
  assert.equal((await checks.G5(await ctx.withFiles({ 'packages/ui/gates/legacy-allowlist.json': JSON.stringify(invalidPath) }))).ok, false)
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
  const sources = await ctx.json('packages/ui/fonts/sources.json')
  assert.deepEqual(sources.map(source => source.family).sort(), ['mono', 'sans'])
  const declared = sources.flatMap(source => source.files.filter(file => file.path.endsWith('.woff2')).map(file => `packages/ui/fonts/${file.path}`)).sort()
  assert.deepEqual(ctx.files.filter(file => file.startsWith('packages/ui/fonts/') && file.endsWith('.woff2')).sort(), declared)
  for (const source of sources) for (const file of source.files) assert.equal(sha(await readFile(resolve(ctx.root, 'packages/ui/fonts', file.path))), file.sha256, file.path)
  for (const file of ctx.files.filter(f => f.startsWith('packages/ui/brand/') && /\.(?:svg|png)$/.test(f))) assert.equal(sha(await readFile(resolve(ctx.root, file))), sha(await readFile(resolve(ctx.root, file.replace('packages/ui/brand/', 'assets/brand/guanxi-gx-v1/')))))
})
test('M1: every stylesheet font URL is relative and belongs to the upstream manifest', async () => {
  const sources = await ctx.json('packages/ui/fonts/sources.json')
  const allowed = new Set(sources.flatMap(source => source.files.filter(file => file.path.endsWith('.woff2')).map(file => file.path)))
  function verify(css) {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(match => match[1].trim())
    assert.equal(urls.length, 32)
    for (const url of urls) {
      assert.doesNotMatch(url, /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i)
      assert.ok(allowed.has(decodeURIComponent(url).replace(/^\.\//, '')), url)
    }
  }
  const css = await ctx.read('packages/ui/fonts/fonts.css')
  verify(css)
  assert.throws(() => verify(css.replace('./sans/', 'https://font-gate.invalid/')))
  assert.throws(() => verify(css.replace('./sans/', './unlisted/')))
})
test('M7: npm test runs both fast gates and gate tests before the regression suite', async () => {
  const script = (await ctx.json('package.json')).scripts.test
  const commands = script.split(/\s*&&\s*/)
  assert.ok(commands.includes('npm run ui:check'))
  assert.ok(commands.includes('npm run test:gates --workspace @guanxi/ui'))
  assert.ok(commands.indexOf('npm run ui:check') < commands.indexOf('npm run test:core'))
  assert.ok(commands.indexOf('npm run test:gates --workspace @guanxi/ui') < commands.indexOf('npm run test:core'))
})
test('extensions discover both MJS and erasable TypeScript registration modules', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'guanxi-gate-extension-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const extensions = resolve(directory, 'packages/ui/gates/extensions')
  await mkdir(extensions, { recursive: true })
  await writeFile(resolve(extensions, 'catalog.gate.ts'), `const id: string = 'G10'; export default { id, name:'Catalog', mode:'fast', seed:'fixture.json', check: async () => ({ok:true, errors:[]}) }`)
  await writeFile(resolve(extensions, 'browser.gate.mjs'), `export default {id:'G13',name:'Browser',mode:'browser',seed:'fixture.json',check:async()=>({ok:true,errors:[]})}`)
  const gates = await registry({ root: directory })
  assert.ok(gates.some(g => g.id === 'G10' && g.mode === 'fast'))
  assert.ok(gates.some(g => g.id === 'G13' && g.mode === 'browser'))
})
