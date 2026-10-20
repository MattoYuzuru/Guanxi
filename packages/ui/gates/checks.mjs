import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import Color from 'colorjs.io'
import { resolveTokens, permutations, resolvedFlat } from '../tokens/resolve.mjs'
import { validateTokens } from '../tokens/validate.mjs'
import { generate, cssName } from '../tokens/build.mjs'
import { scanLiterals, counts } from './scan.mjs'
import { variableFiles } from './context.mjs'

const result = (errors, details = {}) => ({ ok: errors.length === 0, errors, ...details })
export async function tokensValid(ctx) {
  const modes = await permutations(ctx.tokenOptions)
  let count = 0
  for (const mode of modes) count = validateTokens((await resolveTokens(mode, ctx.tokenOptions)).tokens).length
  return result([], { contexts: modes.length, tokensPerContext: count })
}
export async function generatedFresh(ctx) {
  const errors = []
  for (const [name, content] of Object.entries(await generate(ctx.tokenOptions))) {
    try { if (await ctx.read(`packages/ui/generated/${name}`) !== content) errors.push(`${name}: generated output differs`) }
    catch (error) { if (error.code !== 'ENOENT') throw error; errors.push(`${name}: missing generated output`) }
  }
  return result(errors)
}

export async function contrast(ctx) {
  const specification = await ctx.json('packages/ui/tokens/contrast-pairs.json')
  const errors = [], measurements = []
  const required = ['text', 'secondary', 'muted', 'control-border', 'accent', 'on-accent', 'success', 'warning', 'danger', 'info', ...Array.from({ length: 8 }, (_, i) => `data-${i + 1}`)]
  if (JSON.stringify([...specification.themes].sort()) !== JSON.stringify(['dark', 'dark-hc', 'light', 'light-hc'])) errors.push('Contrast manifest must cover all four themes')
  if (required.some(name => specification.pairs.filter(pair => pair.name === name).length !== 1)) errors.push('Contrast manifest is missing or duplicates a required pair')
  for (const theme of specification.themes) {
    const tokens = resolvedFlat((await resolveTokens({ theme }, ctx.tokenOptions)).tokens)
    const map = new Map(tokens.map(t => [t.name, t.$value]))
    for (const pair of specification.pairs) {
      const fg = map.get(pair.foreground), bg = map.get(pair.background)
      if (!fg?.hex || !bg?.hex) { errors.push(`${theme}/${pair.name}: missing pair token`); continue }
      // The fallback is required to encode exactly the same sRGB colour as OKLCH (G1).
      const ratio = new Color(fg.hex).contrast(new Color(bg.hex), 'WCAG21')
      const minimum = theme.endsWith('-hc') ? 7 : pair.minimum
      const measured = Number(ratio.toFixed(2))
      measurements.push({ theme, pair: pair.name, ratio: measured, minimum })
      if (ratio < minimum) errors.push(`${theme}/${pair.name}: ${ratio.toFixed(4)} < ${minimum}`)
      const expected = pair.measured?.[theme]
      if (expected !== undefined && measured !== expected) errors.push(`${theme}/${pair.name}: measured ${measured}, FOUNDATIONS records ${expected}; STOP: palette disagreement`)
    }
    // Compositing in sRGB matches the emitted color-mix recipe. White/black bound
    // luminance; the six saturated RGB extremes additionally exercise coloured backdrops.
    const backdrops = ['#FFFFFF', '#000000', '#FF0000', '#00FF00', '#0000FF', '#00FFFF', '#FF00FF', '#FFFF00']
    const hc = theme.endsWith('-hc')
    for (const level of ['glass', 'tinted', 'solid']) for (const strong of [false, true]) {
      const effective = hc ? 'solid' : level
      const fill = new Color(map.get(`material.${effective}.fill`).hex).to('srgb').coords
      const opacity = map.get(`material.${strong ? 'strong.' : ''}${effective}.fill-opacity`)
      for (const backdrop of backdrops) {
        const behind = new Color(backdrop).to('srgb').coords
        const composite = new Color('srgb', fill.map((v, i) => v * opacity + behind[i] * (1 - opacity)))
        for (const [role, minimum] of [['text', hc ? 7 : 4.5], ['control', hc ? 7 : 3]]) {
          const ratio = new Color(map.get(`material.${role}`).hex).contrast(composite, 'WCAG21')
          const name = `${strong ? 'strong-' : ''}${level}/${role}/${backdrop}`
          measurements.push({ theme, pair: name, ratio: Number(ratio.toFixed(2)), minimum })
          if (ratio < minimum) errors.push(`${theme}/${name}: ${ratio.toFixed(4)} < ${minimum}`)
        }
      }
    }
  }
  return result(errors, { measurements })
}

export async function variablesResolve(ctx) {
  const errors = []
  const generated = new Set()
  for (const mode of await permutations(ctx.tokenOptions)) for (const t of resolvedFlat((await resolveTokens(mode, ctx.tokenOptions)).tokens)) generated.add(cssName(t))
  for (const match of (await ctx.read('packages/ui/generated/tokens.css')).matchAll(/(--[\w-]+)\s*:/g)) generated.add(match[1])
  const local = await ctx.json('packages/ui/gates/local-variables.json')
  for (const file of variableFiles(ctx)) {
    const text = await ctx.read(file)
    for (const match of text.matchAll(/\bvar\(\s*(--[\w-]+)/g)) {
      if (!generated.has(match[1]) && !(local[match[1]]?.some(path => path === file || path.endsWith('/**') && file.startsWith(path.slice(0, -2))))) errors.push(`${file}:${text.slice(0, match.index).split('\n').length}: unresolved ${match[1]}`)
    }
  }
  // An allow-listed name still needs an actual definition, including inline geometry properties.
  const text = (await Promise.all(variableFiles(ctx).map(file => ctx.read(file)))).join('\n')
  for (const name of Object.keys(local)) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`${escaped}['"]?\\s*:`).test(text)) errors.push(`${name}: allow-listed local variable has no definition`)
  }
  return result(errors, { unresolved: errors.length })
}

const allowPath = 'packages/ui/gates/legacy-allowlist.json'
let literalCache = new WeakMap()
async function ratchet(ctx) {
  if (literalCache.has(ctx)) return literalCache.get(ctx)
  const findings = await scanLiterals(ctx)
  const allowances = await ctx.json(allowPath)
  const errors = []
  const git = args => execFileSync('git', args, { cwd: ctx.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let previous
  // Follow the full committed history: a removed suppression cannot be reintroduced later.
  for (const revision of git(['log', '--format=%H', '--reverse', '--', allowPath]).split('\n').filter(Boolean)) {
    const version = JSON.parse(git(['show', `${revision}:${allowPath}`]))
    if (previous) for (const [key, count] of Object.entries(version)) if (count > (previous[key] ?? 0)) errors.push(`Legacy allowance grew in ${revision}: ${key}`)
    previous = version
  }
  if (previous) for (const [key, count] of Object.entries(allowances)) if (count > (previous[key] ?? 0)) errors.push(`Legacy allowance grew: ${key}`)
  const actual = counts(findings)
  for (const [key, count] of Object.entries(allowances)) {
    if (!/^G[567]\|packages\/web\/src\//.test(key) || !Number.isInteger(count) || count < 1) errors.push(`Invalid legacy allowance: ${key}`)
    if (count > (actual[key] ?? 0)) errors.push(`Unused legacy allowance must shrink: ${key} (${count} > ${actual[key] ?? 0})`)
  }
  const value = { findings, allowances, actual, errors }
  literalCache.set(ctx, value)
  return value
}
export async function literals(ctx, gate) {
  const { findings, allowances, actual, errors } = await ratchet(ctx)
  return result([...errors, ...Object.entries(actual).filter(([key, count]) => key.startsWith(gate + '|') && count > (allowances[key] ?? 0)).map(([key, count]) => `${key}: ${count - (allowances[key] ?? 0)} new violation(s)`)], { frozen: findings.filter(f => f.gate === gate).length })
}

export const checks = { G1: tokensValid, G2: generatedFresh, G3: contrast, G4: variablesResolve,
  G5: ctx => literals(ctx, 'G5'), G6: ctx => literals(ctx, 'G6'), G7: ctx => literals(ctx, 'G7') }
export async function execute(check, ctx) {
  try { return await check(ctx) } catch (error) { return result([error.message]) }
}
