/**
 * Applies one palette candidate (D-201) to the token sources and to the FOUNDATIONS colour
 * tables, so a palette swap stays a token-only change:
 *
 *   node packages/ui/tokens/palettes/apply.mjs porcelain-cobalt
 *   npm run tokens:build
 *   node packages/ui/tokens/palettes/apply.mjs --measure   # records measured contrast
 *
 * It rewrites primitive neutral/status/accent-state colours, the ink used by shadows, scrim
 * and the glass seam, the §1.1–§1.3 tables of docs/design/FOUNDATIONS.md and the measured
 * ratios in contrast-pairs.json. Data-visualisation slots are not part of the palette.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import Color from 'colorjs.io'
import { build, candidates } from './generate.mjs'

const root = new URL('../../../../', import.meta.url)
const file = path => new URL(path, root)
const readJson = path => JSON.parse(readFileSync(file(path), 'utf8'))
const writeJson = (path, value) => writeFileSync(file(path), JSON.stringify(value, null, 2) + '\n')

/** DTCG colour object whose OKLCH components encode exactly the sRGB fallback (G1). */
function colour(hex, alpha) {
  const [l, c, h] = new Color(hex).to('oklch').coords
  // Clamp floating-point noise (white comes back as L 1.0000000000000002) into the valid range.
  const components = [Math.min(1, Math.max(0, l)), Math.max(0, c), Number.isNaN(h) || h === null ? 0 : h].map(v => Number(v.toFixed(10)))
  const back = new Color('oklch', components).to('srgb').toString({ format: 'hex', collapse: false }).toUpperCase()
  if (back !== hex) throw new Error(`${hex} does not round-trip through OKLCH (${back})`)
  const value = { colorSpace: 'oklch', components, hex }
  if (alpha !== undefined) value.alpha = alpha
  return value
}
const mix = (from, to, amount) => {
  const ch = h => h.slice(1).match(/../g).map(v => parseInt(v, 16))
  const [a, b] = [ch(from), ch(to)]
  return '#' + a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount).toString(16).padStart(2, '0')).join('').toUpperCase()
}

async function measure() {
  const { createContext } = await import('../../gates/context.mjs')
  const { contrast } = await import('../../gates/checks.mjs')
  const pairsPath = 'packages/ui/tokens/contrast-pairs.json'
  const spec = readJson(pairsPath)
  // Drop recorded values first so the gate reports fresh measurements instead of disagreements.
  for (const pair of spec.pairs) if (pair.measured) pair.measured = {}
  writeJson(pairsPath, spec)
  const report = await contrast(await createContext())
  const byPair = Object.groupBy(report.measurements, item => item.pair)
  for (const pair of spec.pairs) {
    if (!pair.measured) continue
    for (const theme of ['light', 'dark']) pair.measured[theme] = byPair[pair.name].find(item => item.theme === theme).ratio
  }
  writeJson(pairsPath, spec)
  const doc = readFileSync(file('docs/design/FOUNDATIONS.md'), 'utf8')
  const m = name => Object.fromEntries(byPair[name].map(item => [item.theme, item.ratio.toFixed(2)]))
  const [text, muted, control, accent, onAccent] = ['text', 'muted', 'control-border', 'accent', 'on-accent'].map(m)
  let next = doc.replace(/Measured contrast \(WCAG 2\.2[^)]*\): [^\n]*\n[^\n]*\./,
    `Measured contrast (WCAG 2.2, ${new Date().toISOString().slice(0, 10)}): light text ${text.light}:1, muted ${muted.light}:1, control border\n` +
    `${control.light}:1 on the light canvas; dark text ${text.dark}:1, muted ${muted.dark}:1, control border ${control.dark}:1 on the dark canvas.\n` +
    `The \"pane-*\" pairs check the same floors on the session pane (step 1).`)
  const statusRow = (role, label) => {
    const ratio = role === 'on-accent' ? onAccent : m(role)
    return new RegExp(`(\\| ${label} \\| \`#[0-9A-F]{6}\` \\| \`#[0-9A-F]{6}\` \\| )[\\d.]+ / [\\d.]+( \\|)`)
      [Symbol.replace](next, `$1${ratio.light} / ${ratio.dark}$2`)
  }
  for (const [role, label] of [['accent', 'accent \\([a-z]+\\)'], ['on-accent', 'text on accent fill'], ['success', 'success'], ['warning', 'warning'], ['danger', 'danger'], ['info', 'info']]) next = statusRow(role, label)
  const hover = m('on-accent-hover'), pressed = m('on-accent-pressed')
  next = next.replace(/\(measured: light [\d.]+ \/ [\d.]+, dark [\d.]+ \/\n?\s*[\d.]+\)/, `(measured: light ${hover.light} / ${pressed.light}, dark ${hover.dark} /\n${pressed.dark})`)
  writeFileSync(file('docs/design/FOUNDATIONS.md'), next)
  console.log('recorded measured contrast')
}

function apply(id) {
  const candidate = candidates.find(item => item.id === id)
  if (!candidate) throw new Error(`unknown candidate ${id}; one of ${candidates.map(c => c.id).join(', ')}`)
  const built = build(candidate)
  const tokensPath = 'packages/ui/tokens/primitive/color.tokens.json'
  const tokens = readJson(tokensPath)
  const primitive = tokens.primitive.color
  for (const theme of ['light', 'dark']) {
    for (const [step, hex] of Object.entries(built[theme].ramp)) primitive.neutral[theme][step].$value = colour(hex)
    for (const [role, hex] of Object.entries(built[theme].status)) primitive.status[theme][role].$value = colour(hex)
    primitive['accent-state'][theme].hover.$value = colour(built[theme].states.hover)
    primitive['accent-state'][theme].pressed.$value = colour(built[theme].states.pressed)
    // HC themes have no hue: their accent is step 11, mixed by the same 12% / 24% rule.
    const ink = built.light.ramp[12], toward = theme === 'dark' ? '#FFFFFF' : ink, hcAccent = built[theme].ramp[11]
    primitive['accent-state'][`${theme}-hc`].hover.$value = colour(mix(hcAccent, toward, 0.12))
    primitive['accent-state'][`${theme}-hc`].pressed.$value = colour(mix(hcAccent, toward, 0.24))
  }
  const ink = built.light.ramp[12]
  primitive.material.light.seam.$value = colour(ink, primitive.material.light.seam.$value.alpha)
  writeJson(tokensPath, tokens)

  const basePath = 'packages/ui/tokens/base.tokens.json'
  const base = readJson(basePath)
  for (const layer of base.shadow.popover.$value) layer.color = colour(ink, layer.color.alpha)
  base.scrim.color.$value = colour(ink)
  writeJson(basePath, base)

  const docPath = 'docs/design/FOUNDATIONS.md'
  let doc = readFileSync(file(docPath), 'utf8')
  const names = { 1: 'pane', 2: 'canvas', 12: 'ink' }
  const rampRows = Array.from({ length: 12 }, (_, i) => i + 1).map(step => {
    const label = (theme, s) => `\`${built[theme].ramp[s]}\`${names[s] ? ` ${names[s] === 'ink' ? (theme === 'light' ? 'ink' : 'paper') : names[s]}` : ''}`
    return `| ${step} | ${label('light', step)} | ${label('dark', step)} |`
  }).join('\n')
  doc = doc.replace(/\| Step \| Light[^\n]*\n\| --- \| --- \| --- \|\n(?:\| \d+ \|[^\n]*\n)+/,
    `| Step | Light (${candidate.name.split(' + ')[0]}) | Dark |\n| --- | --- | --- |\n${rampRows}\n`)
  const accentName = candidate.name.split(' + ')[1].toLowerCase()
  const statusRows = [
    [`accent (${accentName})`, built.light.status.accent, built.dark.status.accent],
    ['text on accent fill', built.light.onAccent, built.dark.onAccent],
    ...['success', 'warning', 'danger', 'info'].map(role => [role, built.light.status[role], built.dark.status[role]]),
  ].map(([role, light, dark]) => `| ${role} | \`${light}\` | \`${dark}\` | 0 / 0 |`).join('\n')
  doc = doc.replace(/\| Role \| Light \| Dark \| Contrast on canvas \(light \/ dark\) \|\n\| --- \| --- \| --- \| --- \|\n(?:\|[^\n]*\n){6}/,
    `| Role | Light | Dark | Contrast on canvas (light / dark) |\n| --- | --- | --- | --- |\n${statusRows}\n`)
  doc = doc.replace(/(\| `background-accent-hover` \| )`#[0-9A-F]{6}` \| `#[0-9A-F]{6}`/, `$1\`${built.light.states.hover}\` | \`${built.dark.states.hover}\``)
  doc = doc.replace(/(\| `background-accent-pressed` \| )`#[0-9A-F]{6}` \| `#[0-9A-F]{6}`/, `$1\`${built.light.states.pressed}\` | \`${built.dark.states.pressed}\``)
  writeFileSync(file(docPath), doc)
  console.log(`applied ${candidate.name}; now run npm run tokens:build, then apply.mjs --measure`)
}

const argument = process.argv[2]
if (argument === '--measure') await measure()
else apply(argument ?? 'porcelain-cobalt')
