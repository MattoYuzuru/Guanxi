import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext } from './context.mjs'
import { resolveTokens, resolvedFlat } from '../tokens/resolve.mjs'
import { generate } from '../tokens/build.mjs'
import { designSystem } from './scan.mjs'

const ctx = await createContext()
const document = await ctx.read('docs/design/FOUNDATIONS.md')
const section = prefix => document.slice(document.indexOf(prefix)).split(/\n(?=#{1,3} )/)[0]
function tables(text) {
  return [...text.matchAll(/(?:^\|.*\|\s*\n)+/gm)].map(match => match[0].trim().split('\n').map(row => row.split('|').slice(1, -1).map(cell => cell.replaceAll('`', '').trim())).filter(row => !row.every(cell => /^[-: ]+$/.test(cell))))
}
const numeric = text => [...text.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]))
const hex = text => text.match(/#[a-f\d]{6}/i)?.[0]
const ramps = tables(section('### 1.1'))[0].slice(1)
const statuses = tables(section('### 1.2'))[0].slice(1)
const data = tables(section('### 1.5'))[0].slice(1)
const density = tables(section('## 7.'))[0].slice(1)
const durations = tables(section('## 5.'))[0].filter(row => row[0].startsWith('duration.'))
const easings = tables(section('## 5.'))[0].filter(row => row[0].startsWith('easing.'))
const materials = tables(section('## 4.')).filter(table => table[0][0] === 'Level')
const materialDetails = tables(section('## 4.'))[0]
const expectedSpaces = numeric(document.match(/Spacing scale ([\d, ]+)/)[1])
const expectedRadii = numeric(document.match(/\*\*Radius\*\*[^\n]*(?:\n  [^\n]+)*/)[0])

async function verifyFoundations(context) {
  for (const theme of ['light', 'dark', 'light-hc', 'dark-hc']) for (const mode of ['compact', 'comfortable']) for (const motion of ['full', 'reduced']) {
    const entries = resolvedFlat((await resolveTokens({ theme, density: mode, motion }, context.tokenOptions)).tokens)
    const map = Object.fromEntries(entries.map(t => [t.name, t.$value]))
    const dark = theme.startsWith('dark'), column = dark ? 2 : 1, base = dark ? 'dark' : 'light'
    const eq = (name, expected) => assert.deepEqual(map[name], expected, `${theme}/${mode}/${motion}/${name}`)
    for (const row of ramps) assert.equal(map[`primitive.color.neutral.${base}.${row[0]}`].hex, hex(row[column]))
    for (const row of statuses.filter(row => row[0] !== 'text on accent fill')) {
      const role = row[0].split(' ')[0]
      assert.equal(map[`primitive.color.status.${base}.${role}`].hex, hex(row[column]))
    }
    for (const row of data) {
      assert.equal(map[`primitive.color.data.${base}.${row[0]}`].hex, hex(row[dark ? 3 : 2]))
      if (!theme.endsWith('-hc')) eq(`data.${row[0]}`, map[`primitive.color.data.${base}.${row[0]}`])
    }
    assert.deepEqual(entries.filter(t => t.path[0] === 'spacing').map(t => Number(t.path[1])).sort((a, b) => a - b), expectedSpaces)
    for (const n of expectedSpaces) eq(`spacing.${n}`, { value: n, unit: 'px' })
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
    eq('font.family.sans', ['IBM Plex Sans', 'system-ui', 'sans-serif'])
    eq('font.family.mono', ['IBM Plex Mono', 'ui-monospace', 'monospace'])
    eq('font.weight.regular', 400); eq('font.weight.label', 500); eq('font.weight.heading', 600)
    const headings = numeric(document.match(/15 \/ 18 \/ 22 \/ 28 \/ 36 px/)[0])
    for (const size of [12, 13, 14, ...headings]) eq(`font.size.${size}`, { value: size, unit: 'px' })
  }
}

test('M2/M6: token values match FOUNDATIONS tables across all 16 contexts', () => verifyFoundations(ctx))
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
test('H2: runtime tokens never declare Tailwind font/spacing names', async () => {
  const output = await generate(ctx.tokenOptions)
  assert.doesNotMatch(output['tokens.css'], /--(?:font-sans|font-mono|spacing)\s*:/)
  assert.match(output['tokens.css'], /--font-family-sans:/)
  assert.match(output['tokens.css'], /--font-family-mono:/)
  assert.match(output['theme.css'], /--font-sans: var\(--font-family-sans\)/)
})
test('M4: cleared Tailwind defaults disappear; semantic replacements compile', async () => {
  const system = await designSystem(ctx)
  for (const cls of ['shadow-lg', 'inset-shadow-sm', 'drop-shadow-lg', 'backdrop-blur-md', 'blur-sm', 'tracking-wide', 'leading-tight', 'font-bold']) assert.equal(system.candidatesToCss([cls])[0], null, cls)
  for (const cls of ['transition', 'transition-colors', 'shadow-popover', 'blur-glass', 'font-sans', 'font-mono', 'font-label', 'leading-ui']) assert.ok(system.candidatesToCss([cls])[0], cls)
  const theme = (await generate(ctx.tokenOptions))['theme.css']
  assert.match(theme, /--default-transition-duration: var\(--motion-duration-moderate\)/)
  assert.match(theme, /--default-transition-timing-function: var\(--motion-easing-standard\)/)
  assert.match(theme, /--default-font-family: var\(--font-family-sans\)/)
  assert.match(theme, /--default-mono-font-family: var\(--font-family-mono\)/)
})
test('L1: the default resolver root works from a directory containing spaces', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi tokens with spaces '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(join(ctx.root, 'packages/ui/tokens'), directory, { recursive: true })
  const copied = await import(pathToFileURL(join(directory, 'resolve.mjs')).href)
  assert.equal(copied.tokenRoot, await realpath(directory))
  assert.ok((await copied.resolveTokens()).tokens.font)
})
