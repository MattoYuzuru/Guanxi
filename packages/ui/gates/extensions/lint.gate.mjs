import { ESLint } from 'eslint'
import { insetMutedFindings } from '../../../../scripts/codemods/inset-contrast.mjs'
import { resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { auditSuppressions, suppressionErrors, suppressionPath } from '../lint/suppressions.mjs'

async function additionalSources(root, directory = 'plugins') {
  let entries
  try { entries = await readdir(resolve(root, directory), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return (await Promise.all(entries.filter(e => !['node_modules', 'dist', 'build', '.git'].includes(e.name)).map(e => e.isDirectory() ? additionalSources(root, `${directory}/${e.name}`) : [`${directory}/${e.name}`]))).flat()
}
const featureSource = file => /\.(?:[cm]?[jt]sx?)$/.test(file) && (
  file.startsWith('plugins/') || file.startsWith('packages/plugins/') ||
  /^packages\/(?!ui\/|server\/|cli\/|kernel\/|contract\/)[^/]+\/src\//.test(file))
const requiredRules = ['import-boundaries', 'reuse-primitives', 'no-inline-colours', 'no-literal-styles', 'semantic-classes']
const cache = new WeakMap()
async function lint(ctx) {
  if (cache.has(ctx)) return cache.get(ctx)
  const eslint = new ESLint({ cwd: ctx.root, overrideConfigFile: resolve(ctx.root, 'eslint.config.mjs') })
  // The shared DS1-a context inventories web/UI. Plugin paths are added here, without
  // changing another lane's discovery contract. Overlays always go through ctx.read.
  const files = [...new Set([...ctx.files, ...await additionalSources(ctx.root, 'packages'), ...await additionalSources(ctx.root)])].sort()
  const results = [], contrastErrors = [], configurationErrors = []
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]sx?|css|svg|html)$/.test(file)) continue
    const ignored = await eslint.isPathIgnored(resolve(ctx.root, file))
    if (featureSource(file)) {
      if (ignored) configurationErrors.push(`ESLint configuration ignored feature/plugin source: ${file}`)
      const config = await eslint.calculateConfigForFile(resolve(ctx.root, file))
      for (const name of requiredRules) if (config?.rules?.[`guanxi/${name}`]?.[0] !== 2) configurationErrors.push(`ESLint configuration must enable guanxi/${name} at severity 2: ${file}`)
    }
    if (ignored) continue
    const text = await ctx.read(file)
    if (file.endsWith('.tsx') && file.startsWith('packages/web/src/')) for (const hit of insetMutedFindings(file, text)) contrastErrors.push(`${file}:${hit.line} text-muted on bg-inset; use text-secondary for AA contrast`)
    const [result] = await eslint.lintText(text, { filePath: file })
    results.push([file, result.messages.filter(m => m.severity === 2)])
  }
  const suppressions = await ctx.json(suppressionPath)
  const errors = [...auditSuppressions(ctx.root, suppressions), ...suppressionErrors(suppressions, results), ...contrastErrors, ...configurationErrors]
  const report = { results, errors, suppressions }
  cache.set(ctx, report)
  return report
}
async function check(ctx, id) {
  const { errors, suppressions } = await lint(ctx)
  const selected = id === 'G8' ? errors.filter(e => /import-boundaries|suppression|shallow|ESLint configuration/i.test(e)) : errors.filter(e => !/guanxi\/import-boundaries/.test(e) || /suppression|ESLint configuration/i.test(e))
  const colourRules = ['guanxi/no-inline-colours', 'guanxi/no-literal-css', 'guanxi/no-literal-styles', 'guanxi/semantic-classes', 'guanxi/svg-styles']
  const remaining = Object.entries(suppressions).flatMap(([file, rules]) => Object.entries(rules).filter(([rule]) => colourRules.includes(rule)).map(([rule, entry]) => ({ file, rule, count: entry.count })))
  return { ok: !selected.length, errors: selected, ...(id === 'G9' ? { colourSuppressions: remaining, u1ColourExitReady: remaining.length === 0 } : {}) }
}
export default [
  { id: 'G8', name: 'Import boundaries', mode: 'fast', seed: 'packages/ui/gates/seeds/G8.json', check: ctx => check(ctx, 'G8') },
  { id: 'G9', name: 'Reuse primitives and lint ratchet', mode: 'fast', seed: 'packages/ui/gates/seeds/G9.json', check: ctx => check(ctx, 'G9') },
]
