import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, realpath, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext } from './context.mjs'
import { resolveTokens, resolvedFlat } from '../tokens/resolve.mjs'
import { generate } from '../tokens/build.mjs'
import { designSystem, classStrings } from './scan.mjs'
import { checks } from './checks.mjs'
import postcss from 'postcss'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import { resolveConfig } from 'vite'

const ctx = await createContext()
const document = await ctx.read('docs/design/FOUNDATIONS.md')
const section = prefix => document.slice(document.indexOf(prefix)).split(/\n(?=#{1,3} )/)[0]
function tables(text) {
  return [...text.matchAll(/(?:^\|.*\|\s*\n)+/gm)].map(match => match[0].trim().split('\n').map(row => row.split('|').slice(1, -1).map(cell => cell.replaceAll('`', '').trim())).filter(row => !row.every(cell => /^[-: ]+$/.test(cell))))
}
const numeric = text => [...text.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]))
const hex = text => text.match(/#[a-f\d]{6}/i)?.[0]
const ramps = tables(section('### 1.1'))[0].slice(1)
const neutralRoleSteps = Object.fromEntries([
  ['background.primary', /(\d+) canvas/], ['background.secondary', /(\d+) raised surface/],
  ['background.tertiary', /(\d+)–\d+ fills/], ['border.primary', /(\d+) = decorative divider/],
  ['border.control', /(\d+) control border/], ['text.tertiary', /(\d+) muted text/],
  ['text.secondary', /(\d+) secondary text/], ['text.primary', /(\d+) primary text/],
].map(([role, pattern]) => [role, Number(section('### 1.1').match(pattern)[1])]))
const statuses = tables(section('### 1.2'))[0].slice(1)
const data = tables(section('### 1.5'))[0].slice(1)
const density = tables(section('## 7.'))[0].slice(1)
const durations = tables(section('## 5.'))[0].filter(row => row[0].startsWith('duration.'))
const easings = tables(section('## 5.'))[0].filter(row => row[0].startsWith('easing.'))
const materials = tables(section('## 4.')).filter(table => table[0][0] === 'Level')
const materialDetails = tables(section('## 4.'))[0]
const expectedSpaces = numeric(document.match(/Spacing scale ([\d, ]+)/)[1])
const containers = [...section('## 3.').matchAll(/\b([a-z\d]+) (\d+)rem/g)].map(([, name, value]) => [name, Number(value)])
assert.equal(containers.length, 13, 'FOUNDATIONS container scale must be parsed in full')
const expectedRadii = numeric(document.match(/\*\*Radius\*\*[^\n]*(?:\n  [^\n]+)*/)[0])
// §1.3 interaction fills, §3 focus ring and layers (FOUNDATIONS addendum 2026-10-20).
const interactions = tables(section('### 1.3')).find(table => table[0][0] === 'Role').slice(1)
const focusRing = numeric(document.match(/\*\*Focus ring:\*\*[^\n]*(?:\n  [^\n]+)*/)[0])
const layerText = document.match(/\*\*Layers \(z-index\):\*\*([^\n]*(?:\n  [^\n]+)*)/)[1]
const layerNames = ['base', 'sticky', 'docked', 'floating', 'popover', 'scrim', 'dialog', 'toast', 'tooltip']
const layers = numeric(layerText.split('.')[0])
assert.equal(layers.length, layerNames.length, 'FOUNDATIONS layer scale must be parsed in full')
// "accent mixed N% toward ink (light) or white (dark)", channel by channel in sRGB.
function mixHex(from, to, amount) {
  const channels = h => h.slice(1).match(/../g).map(c => parseInt(c, 16))
  const [a, b] = [channels(from), channels(to)]
  return '#' + a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function verifyRuntimeNames(runtime, tailwind, legacy) {
  const declared = css => {
    const names = new Set()
    css.walkDecls(decl => { if (decl.prop.startsWith('--')) names.add(decl.prop) })
    return names
  }
  const reserved = declared(postcss.parse(tailwind))
  postcss.parse(legacy).walkAtRules('theme', rule => { for (const name of declared(rule)) reserved.add(name) })
  assert.deepEqual([...declared(postcss.parse(runtime))].filter(name => reserved.has(name)).sort(), [], 'runtime names collide with Tailwind or the legacy @theme')
}

async function verifyFoundations(context) {
  for (const theme of ['light', 'dark', 'light-hc', 'dark-hc']) for (const mode of ['compact', 'comfortable']) for (const motion of ['full', 'reduced']) {
    const entries = resolvedFlat((await resolveTokens({ theme, density: mode, motion }, context.tokenOptions)).tokens)
    const map = Object.fromEntries(entries.map(t => [t.name, t.$value]))
    const dark = theme.startsWith('dark'), hc = theme.endsWith('-hc'), column = dark ? 2 : 1, base = dark ? 'dark' : 'light'
    const eq = (name, expected) => assert.deepEqual(map[name], expected, `${theme}/${mode}/${motion}/${name}`)
    for (const row of ramps) assert.equal(map[`primitive.color.neutral.${base}.${row[0]}`].hex, hex(row[column]))
    for (const row of statuses.filter(row => row[0] !== 'text on accent fill')) {
      const role = row[0].split(' ')[0]
      assert.equal(map[`primitive.color.status.${base}.${role}`].hex, hex(row[column]))
      // HC's neutral status foregrounds are the authorized L6 residual, not new hues.
      const expected = map[hc ? `primitive.color.neutral.${base}.${neutralRoleSteps['text.secondary']}` : `primitive.color.status.${base}.${role}`]
      for (const group of ['background', 'text', 'border']) eq(`color.${group}.${role}`, expected)
    }
    for (const [role, step] of Object.entries(neutralRoleSteps)) {
      const hcStep = hc && (role.startsWith('border.') || role === 'text.tertiary') ? neutralRoleSteps['text.secondary'] : step
      eq(`color.${role}`, map[`primitive.color.neutral.${base}.${hcStep}`])
    }
    eq('color.ring.primary', map[hc ? `primitive.color.neutral.${base}.${neutralRoleSteps['text.secondary']}` : `primitive.color.status.${base}.accent`])
    assert.equal(map['color.text.on-accent'].hex, hex(statuses.find(row => row[0] === 'text on accent fill')[column]))
    for (const row of data) {
      assert.equal(map[`primitive.color.data.${base}.${row[0]}`].hex, hex(row[dark ? 3 : 2]))
      if (!theme.endsWith('-hc')) eq(`data.${row[0]}`, map[`primitive.color.data.${base}.${row[0]}`])
    }
    assert.deepEqual(entries.filter(t => t.path[0] === 'spacing').map(t => Number(t.path[1])).sort((a, b) => a - b), expectedSpaces)
    for (const n of expectedSpaces) eq(`spacing.${n}`, { value: n, unit: 'px' })
    assert.deepEqual(entries.filter(t => t.name.startsWith('layout.container.')).map(t => t.path[2]).sort(), containers.map(([name]) => name).sort())
    for (const [name, value] of containers) eq(`layout.container.${name}`, { value, unit: 'rem' })
    for (const [i, role] of ['inline', 'control', 'panel', 'glass'].entries()) eq(`border-radius.${role}`, { value: expectedRadii[i], unit: 'px' })
    eq('border-radius.app-tile-ratio', Number((expectedRadii[4] / 100).toFixed(6)))
    const metrics = ['font.text.size', 'control.height', 'row.height', 'panel.padding', 'pane.gap', 'grid.unit']
    for (const [i, name] of metrics.entries()) eq(name, { value: numeric(density[i][mode === 'compact' ? 1 : 2])[0], unit: 'px' })
    for (const row of durations) {
      const name = row[0].slice('duration.'.length), ms = numeric(row[1])[0]
      eq(`primitive.duration.${name}`, { value: ms, unit: 'ms' })
      eq(`motion.duration.${name}`, { value: motion === 'full' ? ms : 0, unit: 'ms' })
      eq(`motion.fade.${name}`, { value: motion === 'full' ? ms : Math.min(ms, numeric(durations.find(row => row[0] === 'duration.fast')[1])[0]), unit: 'ms' })
    }
    for (const row of easings) {
      const value = row[1] === 'linear' ? [0, 0, 1, 1] : numeric(row[1])
      eq(`primitive.easing.${row[0].slice(7)}`, value); eq(`motion.easing.${row[0].slice(7)}`, value)
    }
    const distances = numeric(tables(section('## 5.'))[0].find(row => row[0].startsWith('distance.'))[1])
    for (const [i, name] of ['sm', 'md', 'lg'].entries()) eq(`motion.distance.${name}`, { value: motion === 'full' ? distances[i] : 0, unit: 'px' })
    for (const row of materials[0].slice(1)) {
      const level = row[0].toLowerCase(), steps = [...row[1].matchAll(/step (\d+)/g)].map(m => Number(m[1]))
      const opacities = [...row[1].matchAll(/([\d.]+)%/g)].map(m => Number(m[1]) / 100)
      assert.equal(map[`material.${level}.fill`].hex, map[`primitive.color.neutral.${base}.${steps[dark ? 1 : 0]}`].hex)
      eq(`material.${level}.fill-opacity`, opacities[dark ? 1 : 0] ?? opacities[0])
      eq(`material.${level}.blur`, { value: Number(row[2].match(/blur\((\d+)px\)/)?.[1] ?? 0), unit: 'px' })
      eq(`material.${level}.saturation`, Number(row[2].match(/saturate\(([\d.]+)\)/)?.[1] ?? 1))
      const grains = [...row[3].matchAll(/([\d.]+)%/g)].map(m => Number(m[1]) / 100)
      eq(`material.${level}.grain-opacity`, grains[dark ? 1 : 0] ?? 0)
      const strong = materials[1].find(r => r[0] === row[0])
      const strongOpacities = [...strong[1].matchAll(/([\d.]+)%/g)].map(m => Number(m[1]) / 100)
      eq(`material.strong.${level}.fill-opacity`, strongOpacities[dark ? 1 : 0] ?? opacities[dark ? 1 : 0] ?? opacities[0])
      eq(`material.strong.${level}.blur`, { value: Number(strong[2].match(/blur\((\d+)px\)/)?.[1] ?? 0), unit: 'px' })
      eq(`material.strong.${level}.saturation`, map[`material.${level}.saturation`])
      if (level !== 'solid') assert.equal(map[`material.${level}.border`], undefined)
      else {
        const step = theme.endsWith('-hc') ? 11 : Number(row[1].match(/step-(\d+) border/)[1])
        eq('material.solid.border', map[`primitive.color.neutral.${base}.${step}`])
      }
    }
    for (const [role, label, expectedHex] of [['edge', 'Ice edge', '#FFFFFF'], ['seam', 'Ink seam', dark ? '#000000' : hex(ramps.at(-1)[1])]]) {
      assert.equal(map[`material.glass.${role}`].hex, expectedHex)
      assert.equal(map[`material.glass.${role}`].alpha, Number(materialDetails.find(row => row[0] === label)[column].match(/(\d+)%/)[1]) / 100)
    }
    for (const row of interactions) {
      const name = `color.${row[0].replace('background-', 'background.')}`, rule = row[3]
      if (/transparent/.test(row[column])) assert.equal(map[name].alpha, 0, `${theme}/${name}`)
      else if (/step \d+/.test(row[column])) eq(name, map[`primitive.color.neutral.${base}.${numeric(row[column])[0]}`])
      else {
        // HC themes have no hue of their own: the same mix applies to their accent fill.
        const accent = map['color.background.accent'].hex, toward = dark ? '#FFFFFF' : hex(ramps.at(-1)[1])
        const expected = hc ? mixHex(accent, toward, numeric(rule)[0] / 100) : hex(row[column])
        if (!hc) assert.equal(mixHex(accent, toward, numeric(rule)[0] / 100), expected, `FOUNDATIONS ${row[0]} follows its rule`)
        assert.equal(map[name].hex, expected, `${theme}/${name}`)
      }
    }
    eq('focus.ring.width', { value: focusRing[0], unit: 'px' })
    eq('focus.ring.offset', { value: focusRing[1], unit: 'px' })
    for (const [i, name] of layerNames.entries()) eq(`layer.${name}`, layers[i])
    eq('font.family.sans', ['IBM Plex Sans', 'system-ui', 'sans-serif'])
    eq('font.family.mono', ['IBM Plex Mono', 'ui-monospace', 'monospace'])
    eq('font.weight.regular', 400); eq('font.weight.label', 500); eq('font.weight.heading', 600)
    const headings = numeric(document.match(/15 \/ 18 \/ 22 \/ 28 \/ 36 px/)[0])
    for (const size of [12, 13, 14, ...headings]) eq(`font.size.${size}`, { value: size, unit: 'px' })
  }
}

test('M2/M6/N6: token values and semantic roles match FOUNDATIONS across all 16 contexts', () => verifyFoundations(ctx))
test('M2: changing an unmeasured ramp, duration, easing or glass fill breaks the values assertion', async () => {
  for (const [path, mutate] of [
    ['primitive/color.tokens.json', d => { d.primitive.color.neutral.light['3'].$value.hex = '#FF0000' }],
    ['primitive/motion.tokens.json', d => { d.primitive.duration.slow.$value.value = 900 }],
    ['primitive/motion.tokens.json', d => { d.primitive.easing.standard.$value = [0, 0, 0, 1] }],
    ['semantic/color.light.tokens.json', d => { d.material.glass['fill-opacity'].$value = .6 }],
    ['semantic/color.light.tokens.json', d => { d.material.solid.border.$value = '{primitive.color.neutral.light.1}' }],
    ['semantic/color.dark-hc.tokens.json', d => { d.material.solid.border.$value = '{primitive.color.neutral.dark.8}' }],
    ['semantic/color.light.tokens.json', d => { d.data['1'].$value = '{primitive.color.data.light.2}' }],
  ]) {
    const file = `packages/ui/tokens/${path}`, data = await ctx.json(file); mutate(data)
    await assert.rejects(verifyFoundations(await ctx.withFiles({ [file]: JSON.stringify(data) })))
  }
})
test('N6: FOUNDATIONS semantic role assertions reject wrong neutral steps and status identities', async () => {
  for (const theme of ['light', 'dark']) for (const [group, role, wrong] of [
    ['background', 'primary', `neutral.${theme}.1`],
    ['background', 'secondary', `neutral.${theme}.2`],
    ['background', 'tertiary', `neutral.${theme}.4`],
    ['border', 'primary', `neutral.${theme}.6`],
    ['border', 'control', `neutral.${theme}.8`],
    ['text', 'tertiary', `neutral.${theme}.11`],
    ['text', 'secondary', `neutral.${theme}.12`],
    ['text', 'primary', `neutral.${theme}.11`],
    ...['background', 'text', 'border'].flatMap(group => ['accent', 'success', 'warning', 'danger', 'info'].map(role => [group, role, `status.${theme}.${role === 'info' ? 'danger' : 'info'}`])),
    ['ring', 'primary', `status.${theme}.info`],
  ]) {
    const file = `packages/ui/tokens/semantic/color.${theme}.tokens.json`, data = await ctx.json(file)
    data.color[group][role].$value = `{primitive.color.${wrong}}`
    await assert.rejects(verifyFoundations(await ctx.withFiles({ [file]: JSON.stringify(data) })), { name: 'AssertionError' }, `${theme}/${group}.${role}`)
  }
})
test('FOUNDATIONS §1.3/§3 interaction fills, focus ring and layers reject wrong values', async () => {
  for (const [path, mutate] of [
    ['semantic/color.light.tokens.json', d => { d.color.background.hover.$value = '{primitive.color.neutral.light.3}' }],
    ['semantic/color.dark.tokens.json', d => { d.color.background.pressed.$value = '{primitive.color.neutral.dark.4}' }],
    ['semantic/color.light.tokens.json', d => { d.color.background.ghost.$value = '{primitive.color.neutral.light.1}' }],
    ['semantic/color.dark.tokens.json', d => { d.color.background['accent-hover'].$value = '{primitive.color.accent-state.dark.pressed}' }],
    ['semantic/color.light-hc.tokens.json', d => { d.color.background['accent-pressed'].$value = '{primitive.color.accent-state.light.pressed}' }],
    ['base.tokens.json', d => { d.focus.ring.offset.$value.value = 1 }],
    ['base.tokens.json', d => { d.layer.dialog.$value = 45 }],
  ]) {
    const file = `packages/ui/tokens/${path}`, data = await ctx.json(file); mutate(data)
    await assert.rejects(verifyFoundations(await ctx.withFiles({ [file]: JSON.stringify(data) })), { name: 'AssertionError' }, path)
  }
})
test('H2: runtime tokens never declare Tailwind font/spacing names', async () => {
  const output = await generate(ctx.tokenOptions)
  assert.doesNotMatch(output['tokens.css'], /--(?:font-sans|font-mono|spacing)\s*:/)
  assert.match(output['tokens.css'], /--font-family-sans:/)
  assert.match(output['tokens.css'], /--font-family-mono:/)
  assert.match(output['theme.css'], /--font-sans: var\(--font-family-sans\)/)
})
test('N9: runtime declarations cannot shadow any Tailwind or legacy theme name', async () => {
  const runtime = (await generate(ctx.tokenOptions))['tokens.css']
  const tailwind = await readFile(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8')
  const legacy = await ctx.read('packages/web/src/index.css')
  verifyRuntimeNames(runtime, tailwind, legacy)
  for (const name of ['--breakpoint-md', '--color-red-500', '--text-2xs', '--color-fit-green']) {
    assert.throws(() => verifyRuntimeNames(`${runtime}\n:root { ${name}: initial; }`, tailwind, legacy), { name: 'AssertionError' }, name)
  }
})
test('M4: cleared Tailwind defaults disappear; semantic replacements compile', async () => {
  const system = await designSystem(ctx)
  for (const cls of ['shadow-lg', 'inset-shadow-sm', 'drop-shadow-lg', 'backdrop-blur-md', 'blur-sm', 'tracking-wide', 'leading-tight', 'font-bold', 'text-shadow-2xs', 'text-shadow-sm', 'text-shadow-md', 'text-shadow-lg']) assert.equal(system.candidatesToCss([cls])[0], null, cls)
  for (const cls of ['transition', 'transition-colors', 'shadow-popover', 'blur-glass', 'font-sans', 'font-mono', 'font-label', 'leading-ui']) assert.ok(system.candidatesToCss([cls])[0], cls)
  const theme = (await generate(ctx.tokenOptions))['theme.css']
  assert.match(theme, /--default-transition-duration: var\(--motion-duration-moderate\)/)
  assert.match(theme, /--default-transition-timing-function: var\(--motion-easing-standard\)/)
  assert.match(theme, /--default-font-family: var\(--font-family-sans\)/)
  assert.match(theme, /--default-mono-font-family: var\(--font-family-mono\)/)
})
test('K1/DS1-c: actual web CSS imports the generated theme without a bridge or copied aliases', async () => {
  const file = 'packages/web/src/index.css'
  const source = await ctx.read(file)
  const sidebar = await ctx.read('packages/web/src/kernel/SidebarSlot.tsx')
  const expected = [
    ['border-divider', 'border-color', '--color-divider', '--color-border-primary'],
    ['text-secondary', 'color', '--color-secondary', '--color-text-secondary'],
    ['hover:text-foreground', 'color', '--color-foreground', '--color-text-primary'],
    ['hover:bg-inset', 'background-color', '--color-inset', '--color-background-tertiary'],
    ['rounded-control', 'border-radius', '--radius-control', '--border-radius-control'],
    ['text-12', 'font-size', '--text-12', '--font-size-12'],
  ]
  const theme = await ctx.read('packages/ui/generated/theme.css')
  function noBridge(css) {
    const generatedNames = new Set(['--color-surface', '--color-accent', '--color-divider', '--color-secondary', '--color-foreground', '--color-inset', '--radius-control', '--radius-panel', '--text-15', '--text-12'])
    const ast = postcss.parse(css)
    ast.walkAtRules('theme', rule => assert.notEqual(rule.params, 'inline', 'local inline bridge must not return'))
    ast.walkDecls(decl => assert.ok(!generatedNames.has(decl.prop), `copied theme alias: ${decl.prop}`))
    assert.match(css, /@import ['"]@guanxi\/ui\/theme\.css['"]/)
    assert.match(css, /@import ['"]@guanxi\/ui\/tokens\.css['"]/)
    assert.doesNotMatch(css, /ui\/generated\//)
  }
  async function verify(css, generated = theme) {
    noBridge(css)
    const system = await __unstable__loadDesignSystem(css, {
      base: join(ctx.root, 'packages/web/src'),
      async loadStylesheet(id, base) {
        const path = id === 'tailwindcss' ? createRequire(import.meta.url).resolve('tailwindcss/index.css') : id.startsWith('@guanxi/ui/') || id.startsWith('tailwindcss/') ? createRequire(import.meta.url).resolve(id) : resolve(base, id)
        return { path, base: dirname(path), content: id === '@guanxi/ui/theme.css' ? generated : await readFile(path, 'utf8') }
      },
    })
    for (const [cls, property, , token] of expected) {
      assert.ok(sidebar.includes(cls), `sidebar must use ${cls}`)
      const compiled = system.candidatesToCss([cls])[0]
      assert.ok(compiled, `${cls} must compile from the actual web stylesheet`)
      const values = []
      postcss.parse(compiled).walkDecls(property, decl => values.push(decl.value))
      assert.deepEqual(values, [`var(${token})`], cls)
    }
  }
  await verify(source)
  for (const [, , alias, token] of expected) {
    const declaration = `${alias}: var(${token});`
    assert.ok(theme.includes(declaration))
    await assert.rejects(verify(source, theme.replace(declaration, '')), { name: 'AssertionError' }, alias)
    assert.throws(() => noBridge(source + `\n@theme inline { ${declaration} }`), { name: 'AssertionError' }, alias)
    assert.throws(() => noBridge(source + `\n@theme { ${declaration} }`), { name: 'AssertionError' }, alias)
  }
  await assert.rejects(verify(source.replace("@import '@guanxi/ui/theme.css';", '')), { name: 'AssertionError' })
  for (const alias of ['--color-surface', '--color-accent', '--color-divider', '--color-secondary', '--color-foreground', '--color-inset', '--radius-control', '--radius-panel', '--text-15', '--text-12']) assert.doesNotMatch(source, new RegExp(`${alias}:`), alias)
})
test('DS1-c: actual Vite aliases preserve public UI stylesheet exports', async () => {
  const config = await resolveConfig({ configFile: join(ctx.root, 'packages/web/vite.config.ts') }, 'serve')
  const resolveImport = config.createResolver()
  const importer = join(ctx.root, 'packages/web/src/index.css')
  for (const id of ['@guanxi/ui/tokens.css', '@guanxi/ui/theme.css', '@guanxi/ui/fonts.css', '@guanxi/ui/catalog', '@guanxi/ui']) {
    assert.equal(await resolveImport(id, importer), createRequire(import.meta.url).resolve(id), id)
  }
  const broken = await resolveConfig({ configFile: join(ctx.root, 'packages/web/vite.config.ts'), resolve: { alias: [{ find: '@guanxi/ui', replacement: join(ctx.root, 'packages/ui/src/index.ts') }] } }, 'serve')
  assert.notEqual(await broken.createResolver()('@guanxi/ui/tokens.css', importer), createRequire(import.meta.url).resolve('@guanxi/ui/tokens.css'), 'the former broad alias must fail this regression assertion')
})
test('DS1-c review: the app preserves frozen legacy utilities without weakening the generated-only gate', async () => {
  const source = await ctx.read('packages/web/src/index.css')
  const base = execFileSync('git', ['show', '2ab9c41:packages/web/src/index.css'], { cwd: ctx.root, encoding: 'utf8' })
  async function load(css) {
    return __unstable__loadDesignSystem(css, {
      base: join(ctx.root, 'packages/web/src'),
      async loadStylesheet(id, directory) {
        const path = id === 'tailwindcss' ? createRequire(import.meta.url).resolve('tailwindcss/index.css') : id.startsWith('@guanxi/ui/') || id.startsWith('tailwindcss/') ? createRequire(import.meta.url).resolve(id) : resolve(directory, id)
        return { path, base: dirname(path), content: await readFile(path, 'utf8') }
      },
    })
  }
  const before = await load(base), after = await load(source)
  const retained = ['text-xs', 'text-sm', 'text-lg', 'font-medium', 'font-semibold', 'rounded-md', 'rounded-lg', 'backdrop-blur-md', 'shadow-sm', 'tracking-tight', 'leading-relaxed']
  assert.deepEqual(after.candidatesToCss(retained), before.candidatesToCss(retained), 'legacy typography/radius/material utilities must retain their CSS')
  const classes = new Set()
  for (const file of ctx.files.filter(f => /^packages\/web\/src\/.+\.[jt]sx?$/.test(f))) for (const { value } of classStrings(file, await ctx.read(file))) classes.add(value)
  for (const cls of classes) if (before.candidatesToCss([cls])[0]) assert.ok(after.candidatesToCss([cls])[0], `retained utility disappeared: ${cls}`)
  for (const [cls, token] of [['text-13', '--font-size-13'], ['text-14', '--font-size-14'], ['text-18', '--font-size-18'], ['font-label', '--font-weight-label'], ['bg-success', '--color-text-success'], ['bg-muted', '--color-text-tertiary'], ['max-w-md', '--layout-container-md'], ['bg-surface', '--color-background-secondary'], ['text-12', '--font-size-12'], ['rounded-control', '--border-radius-control']]) assert.ok(after.candidatesToCss([cls])[0].includes(`var(${token})`), cls)
  assert.equal(after.resolveThemeValue('--spacing'), 'var(--grid-unit)')
  assert.equal(after.resolveThemeValue('--default-font-family'), 'var(--font-family-sans)')
  const invalid = await checks.G5(await ctx.withFiles({ 'packages/web/src/features/seeded/legacy.tsx': '<div className="text-xs rounded-md bg-red-500"/>' }))
  assert.equal(invalid.ok, false)
  for (const value of ['text-xs', 'rounded-md', 'bg-red-500']) assert.ok(invalid.errors.some(error => error.includes(value)), value)
})
test('M2/N2: FOUNDATIONS rejects missing, extra and incorrect container widths', async () => {
  const file = 'packages/ui/tokens/base.tokens.json'
  for (const mutate of [
    data => { delete data.layout.container.md },
    data => { data.layout.container.custom = { $type: 'dimension', $value: { value: 37, unit: 'rem' } } },
    ...containers.map(([name]) => data => { data.layout.container[name].$value.value += 1 }),
    data => { data.layout.container.md.$value.unit = 'px' },
  ]) {
    const data = await ctx.json(file); mutate(data)
    await assert.rejects(verifyFoundations(await ctx.withFiles({ [file]: JSON.stringify(data) })), { name: 'AssertionError' })
  }
})
test('N7: container utilities resolve through Guanxi tokens to every documented width', async () => {
  const system = await designSystem(ctx)
  const runtime = postcss.parse(await ctx.read('packages/ui/generated/tokens.css'))
  const declarations = new Map()
  runtime.walkDecls(decl => declarations.set(decl.prop, decl.value))
  for (const [name, value] of containers) for (const [utility, property] of [['max-w', 'max-width'], ['w', 'width']]) {
    const cls = `${utility}-${name}`, css = system.candidatesToCss([cls])[0]
    assert.ok(css, cls)
    const values = []
    postcss.parse(css).walkDecls(property, decl => values.push(decl.value))
    assert.deepEqual(values, [`var(--layout-container-${name})`], cls)
    assert.equal(declarations.get(`--layout-container-${name}`), `${value}rem`, cls)
  }
})
test('L1: the default resolver root works from a directory containing spaces', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi tokens with spaces '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(join(ctx.root, 'packages/ui/tokens'), directory, { recursive: true })
  const copied = await import(pathToFileURL(join(directory, 'resolve.mjs')).href)
  assert.equal(copied.tokenRoot, await realpath(directory))
  assert.ok((await copied.resolveTokens()).tokens.font)
})

test('M4 web base surfaces, borders, focus and scrollbars use the semantic palette', async () => {
  const css = postcss.parse(await ctx.read('packages/web/src/index.css'))
  const expected = {
    body: { background: 'var(--color-background-primary)', color: 'var(--color-text-primary)' },
    '*': { 'border-color': 'var(--color-border-primary)' },
    ':focus-visible': { outline: 'var(--focus-ring-width) solid var(--color-ring-primary)' },
    '::-webkit-scrollbar-thumb': { background: 'var(--color-border-control)' },
    '::-webkit-scrollbar-thumb:hover': { background: 'var(--color-text-secondary)' },
  }
  for (const [selector, props] of Object.entries(expected)) {
    const values = {}
    css.walkRules(selector, rule => rule.walkDecls(d => { values[d.prop] = d.value }))
    for (const [prop, value] of Object.entries(props)) assert.equal(values[prop], value, `${selector} ${prop}`)
  }
  const ui = await ctx.read('packages/web/src/components/ui.tsx')
  assert.ok(ui.includes('focus:border-accent'), 'input focus must use semantic accent')
  assert.ok(ui.includes("accent: 'bg-accent/10 text-accent border-accent/30'"), 'badge must use one accent palette')
  const tool = await ctx.read('packages/web/src/features/agent/ToolCallCard.tsx')
  assert.match(tool, /bg-inset[^"\n]+hover:bg-surface/, 'tool hover must differ from its inset rest state')
})

test('M4 additional accent and status utility mappings share generated role values', async () => {
  for (const theme of ['light', 'dark', 'light-hc', 'dark-hc']) {
    const map = Object.fromEntries(resolvedFlat((await resolveTokens({ theme })).tokens).map(t => [t.name, t.$value]))
    for (const role of ['accent', 'danger', 'warning']) {
      assert.deepEqual(map[`color.background.${role}`], map[`color.text.${role}`], `${theme} ${role} background/text`)
      assert.deepEqual(map[`color.border.${role}`], map[`color.text.${role}`], `${theme} ${role} border/text`)
    }
  }
})

test('L8 Vitest resolves public UI styles through package exports', async () => {
  const config = await resolveConfig({ root: join(ctx.root, 'packages/web'), configFile: join(ctx.root, 'packages/web/vitest.config.ts') }, 'serve')
  const resolver = config.createResolver()
  for (const [name, path] of [['@guanxi/ui', 'src/index.ts'], ['@guanxi/ui/catalog', 'catalog/index.ts'], ['@guanxi/ui/theme.css', 'generated/theme.css'], ['@guanxi/ui/tokens.css', 'generated/tokens.css']]) assert.equal(await resolver(name, join(ctx.root, 'packages/web/src/index.css')), join(ctx.root, 'packages/ui', path), name)
})
