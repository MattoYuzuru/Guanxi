import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext } from './context.mjs'
import { classStrings, scanLiterals, cssFindings, counts } from './scan.mjs'
import { checks } from './checks.mjs'
import ts from 'typescript'

const ctx = await createContext()
test('H3: bound class maps follow element/property access, spreads and lexical scopes once', () => {
  const code = `const tones = { bad: 'bg-red-500', ok: 'bg-canvas' } as const;
    const extra = { danger: 'text-[#f00]' };
    const buttonClasses = { ...extra, neutral: 'p-[13px]' };
    function A({ tone }) { const tones = { bad: 'w-[17px]' }; return <div className={tones[tone]}/> }
    function B({ tone }) { return <><div className={tones[tone]}/><div wrapperClassName={tones.bad}/><div className={buttonClasses[tone]}/></> }`
  const words = classStrings('fixture.tsx', code).map(t => t.value)
  for (const word of ['bg-red-500', 'bg-canvas', 'text-[#f00]', 'p-[13px]', 'w-[17px]']) assert.equal(words.filter(w => w === word).length, 1, word)
  for (const key of ['bad', 'ok', 'danger', 'neutral']) assert.ok(!words.includes(key), key)
})
test('H3: function-returned classes and *ClassName props are scanned', () => {
  const code = `function style() { return 'bg-red-500' }
    const arrow = () => 'text-[#f00]'; export const A = () => <X outerClassName={style()} innerClassName={arrow()} footerClassName="p-[13px]"/>`
  assert.deepEqual(classStrings('fixture.jsx', code).map(t => t.value).sort(), ['bg-red-500', 'p-[13px]', 'text-[#f00]'])
})
test('H3 self-review: nested maps and conditional/array helper objects retain class meaning', () => {
  for (const code of [
    `const palette = { danger: { base: 'bg-red-500' } }; const A = <div className={palette[tone].base}/>`,
    `const base = { danger: { base: 'bg-red-500' } }; const palette = { ...base }; const A = <div className={palette.danger['base']}/>`,
    `const palette = [{ base: 'bg-red-500' }]; const A = <div className={palette[index].base}/>`,
    `const A = clsx([{ 'bg-red-500': true }])`,
    `const A = cn(ok ? { 'bg-red-500': true } : {})`,
    `const A = cx(ok && { 'bg-red-500': true })`,
    `const conditions = [{ 'bg-red-500': true }]; const A = clsx([...conditions])`,
    `const conditions = () => ({ 'bg-red-500': true }); const A = clsx(conditions())`,
    `function conditions() { return { 'bg-red-500': true } }; const A = cn(conditions())`,
  ]) assert.deepEqual(classStrings('fixture.tsx', code).map(t => t.value), ['bg-red-500'], code)
})
test('H3: every lexical legacy arbitrary-class occurrence is covered by the freeze', async () => {
  const allowances = await ctx.json('packages/ui/gates/legacy-allowlist.json')
  const lexical = {}
  for (const file of ctx.files.filter(file => /^packages\/web\/src\/.*\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file))) {
    const ast = ts.createSourceFile(file, await ctx.read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) for (const word of node.text.split(/\s+/)) if (/^[!\w:/.-]*-\[[^\]]+\][\w/.-]*$/.test(word)) {
        const key = `G5|${file}|${word}`
        lexical[key] = (lexical[key] ?? 0) + 1
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  for (const [key, count] of Object.entries(lexical)) assert.ok((allowances[key] ?? 0) >= count, `${key}: ${count} lexical > ${allowances[key] ?? 0} frozen`)
})
test('M3: Tailwind v4 variable shorthand is resolved and always checked as arbitrary', async () => {
  for (const value of ['bg-(--made-up)', 'text-(color:--missing)']) {
    const seeded = await ctx.withFiles({ 'packages/ui/src/fixture.jsx': `export const A = () => <div className="${value}"/>` })
    assert.equal((await checks.G4(seeded)).ok, false)
    assert.ok((await scanLiterals(seeded)).some(f => f.file.endsWith('fixture.jsx') && f.gate === 'G5'))
  }
  const valid = await ctx.withFiles({ 'packages/ui/src/fixture.js': `const color = 'text-(color:--color-text-primary)'` })
  assert.equal((await checks.G4(valid)).ok, true)
})
test('M4: CSS apply parameters are subject to the raw-motion gate', async () => {
  const findings = await scanLiterals(await ctx.withFiles({ 'packages/ui/src/fixture.css': '.x { @apply duration-300 delay-150; }' }))
  for (const value of ['duration-300', 'delay-150']) assert.ok(findings.some(f => f.file.endsWith('fixture.css') && f.gate === 'G7' && f.value === value))
})
test('M4 self-review: every semantic easing, duration and delay is allowed in JSX and CSS apply', async () => {
  const { easing, duration } = (await ctx.json('packages/ui/tokens/primitive/motion.tokens.json')).primitive
  const classes = [...Object.keys(easing).map(name => `ease-${name}`), ...Object.keys(duration).flatMap(name => [`duration-${name}`, `delay-${name}`])].join(' ')
  for (const [file, text] of [
    ['packages/ui/src/fixture.jsx', `<div className="${classes}"/>`],
    ['packages/ui/src/fixture.css', `.x { @apply ${classes}; }`],
  ]) assert.deepEqual((await scanLiterals(await ctx.withFiles({ [file]: text }))).filter(f => f.file === file), [], file)
})
test('M5/L3: feature directories and HTML/JSX/SCSS extensions cannot evade scanning', async () => {
  for (const segment of ['tokens', 'test', 'brand', 'fonts', 'generated', 'gates']) {
    const file = `packages/web/src/features/${segment}/Widget.jsx`
    const seeded = await ctx.withFiles({ [file]: 'export const A = () => <div className="bg-red-500" style={{ color: "var(--missing)" }}/>' })
    assert.ok((await scanLiterals(seeded)).some(f => f.file === file && f.gate === 'G5'), file)
    assert.equal((await checks.G4(seeded)).ok, false, file)
  }
  for (const [file, text, gates] of [
    ['packages/ui/src/fixture.html', '<div class="bg-red-500" style="color:red;transition:all 2s ease"></div>', ['G5', 'G6', 'G7']],
    ['packages/ui/src/fixture.scss', '.x { color:var(--missing); filter:blur(13px); }', ['G6']],
  ]) {
    const findings = await scanLiterals(await ctx.withFiles({ [file]: text }))
    for (const gate of gates) assert.ok(findings.some(f => f.file === file && f.gate === gate), `${file}/${gate}`)
  }
})
test('L3: colour, geometry and function properties reject raw values, including var fallbacks', () => {
  for (const value of ['accent-color:red', 'caret-color:#f00', 'text-decoration-color:red', 'scrollbar-color:red blue', 'filter:drop-shadow(0 0 2px red)', 'backdrop-filter:blur(20px)', 'transform:translateY(8px)', 'color:var(--token, #ff0000)', 'color:var(--token, var(--other, rgb(255 0 0)))', 'color:RGB(0 0 0)', 'color:var(--token, RGBA(0, 0, 0, 0))']) assert.ok(cssFindings('fixture.scss', `.x { ${value} }`).some(f => f.gate === 'G6'), value)
  assert.deepEqual(cssFindings('fixture.css', '.x { color:var(--token, var(--other)); transform:translateY(var(--motion-distance-sm)); }'), [])
})
test('L7: off-scale spacing fails in JSX and CSS apply; accepted scale and zero compile', async () => {
  for (const value of ['p-2.5', 'hover:p-3.5', 'gap-7', 'mx-px', 'start-2.5', 'end-3.5', 'scroll-mt-7', 'scroll-p-7', 'indent-2.5']) {
    for (const [file, text] of [['packages/ui/src/fixture.jsx', `<div className="${value}"/>`], ['packages/ui/src/fixture.css', `.x { @apply ${value}; }`]]) assert.ok((await scanLiterals(await ctx.withFiles({ [file]: text }))).some(f => f.file === file && f.gate === 'G5'), value)
  }
  const file = 'packages/ui/src/fixture.jsx'
  assert.ok(!(await scanLiterals(await ctx.withFiles({ [file]: '<div className="p-0 p-0.5 p-1.5 p-2 p-3 p-4 p-5 p-6 p-8 p-10 p-12 p-16 start-2 end-3 scroll-mt-8 scroll-p-3 indent-2"/>' }))).some(f => f.file === file))
})

test('N4: G6 rejects seeded JSX style literals and SVG paints in UI and new web paths', async () => {
  for (const file of ['packages/ui/src/fixture.tsx', 'packages/web/src/features/new/Widget.jsx', 'packages/web/src/components/new-ui.tsx']) {
    for (const [source, expected] of [
      [`<div style={{ color: '#ff0000', zIndex: 999, padding: 13 }}/>`, ['color:#ff0000', 'z-index:999', 'padding:13']],
      [`<div style={{ backgroundColor: 'rgb(255 0 0)', marginTop: -13 }}/>`, ['background-color:rgb(255 0 0)', 'margin-top:-13']],
      [`<div style={ok ? { borderColor: '#ff0000' } : { color: 'var(--color-text-primary, red)' }}/>`, ['border-color:#ff0000', 'color:var(--color-text-primary, red)']],
      [`<svg><path fill="#ff0000" stroke={'red'}/></svg>`, ['fill:#ff0000', 'stroke:red']],
    ]) {
      const seeded = await ctx.withFiles({ [file]: source })
      const findings = (await scanLiterals(seeded)).filter(f => f.file === file && f.gate === 'G6')
      assert.deepEqual(findings.map(f => f.value).sort(), expected.sort(), `${file}: ${source}`)
      const report = await checks.G6(seeded)
      for (const value of expected) assert.ok(report.errors.some(e => e.includes(`${file}|${value}:`) && e.includes('new violation')), value)
    }
  }
  for (const file of ['packages/ui/src/icon.svg', 'packages/ui/src/fixture.html']) {
    const report = await checks.G6(await ctx.withFiles({ [file]: '<svg><path fill="#ff0000" stroke="red"/></svg>' }))
    for (const value of ['fill:#ff0000', 'stroke:red']) assert.ok(report.errors.some(e => e.includes(`${file}|${value}:`) && e.includes('new violation')), `${file}/${value}`)
  }
})

test('N4: semantic JSX styles and SVG paints pass; the legacy inline debt stays with G9', async () => {
  const file = 'packages/ui/src/fixture.tsx'
  const source = `<svg style={{ color: 'var(--color-text-primary)', zIndex: 'var(--elevation-2-z-index)', padding: 0, borderTopColor: 'transparent' }}>
    <path fill="none" stroke="currentColor"/><path fill={'var(--color-background-accent)'} stroke="var(--color-border-control)"/>
  </svg>`
  assert.deepEqual((await scanLiterals(await ctx.withFiles({ [file]: source }))).filter(f => f.file === file), [])
  const legacy = 'packages/web/src/components/ui.tsx'
  const findings = await scanLiterals(ctx)
  assert.ok(!findings.some(f => f.file === legacy && f.gate === 'G6'))
  assert.deepEqual(counts(findings), await ctx.json('packages/ui/gates/legacy-allowlist.json'), 'N4 must not grow or rebaseline the legacy ledger')
})
