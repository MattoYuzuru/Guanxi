import ts from 'typescript'
import { insetMutedFindings } from './inset-contrast.mjs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Role mappings use FOUNDATIONS and the existing K1 sidebar migration. A missing
// generated alias is deliberately not synthesized (notably fit and subtle accent).
export const legacyRoles = {
  bg: { '--bg': '--color-background-primary', '--bg-raised': '--color-background-secondary', '--bg-inset': '--color-background-tertiary', '--bg-subtle': '--color-background-tertiary', '--accent': '--color-background-accent' },
  text: { '--fg': '--color-text-primary', '--fg-muted': '--color-text-secondary', '--fg-subtle': '--color-text-tertiary', '--accent-fg': '--color-text-on-accent', '--danger': '--color-text-danger', '--warning': '--color-text-warning' },
  border: { '--border': '--color-border-primary', '--border-strong': '--color-border-control' },
  ring: { '--focus': '--color-ring-primary', '--accent': '--color-ring-primary' },
}
export function themeAliases(theme) {
  return new Map([...theme.matchAll(/--color-([\w-]+):\s*var\((--[\w-]+)\)\s*;/g)].map(([, alias, variable]) => [variable, alias]))
}
export function rewrite(file, text, theme) {
  const aliases = themeAliases(theme), replacements = [], unresolved = []
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(ast), raw = text.slice(start, node.end)
      // Work on source spans to retain quotes, escapes, whitespace and template holes.
      const content = raw.slice(1, ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? -2 : -1)
      for (const match of content.matchAll(/(?<![^\s:!])(bg|text|border|ring)-\[var\((--[\w-]+)\)\](?=$|[\s/!])/g)) {
        const [value, prefix, variable] = match
        const alias = aliases.get(legacyRoles[prefix]?.[variable] ?? variable)
        const offset = start + 1 + match.index
        if (alias) replacements.push({ start: offset, end: offset + value.length, from: value, to: `${prefix}-${alias}` })
        else unresolved.push({ file, line: ast.getLineAndCharacterOfPosition(offset).line + 1, class: value, reason: 'No role-equivalent alias in generated/theme.css' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  let output = text
  for (const edit of [...replacements].sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.to + output.slice(edit.end)
  // Muted is only guaranteed on canvas. Promote inset text (including placeholders)
  // after the surface rewrite, retaining the generated alias as the source of truth.
  if (aliases.has('--color-text-secondary')) for (const edit of insetMutedFindings(file, output).reverse()) {
    const to = `text-${aliases.get('--color-text-secondary')}`
    output = output.slice(0, edit.start) + to + output.slice(edit.end)
    replacements.push({ ...edit, from: 'text-muted', to })
  }
  return { output, replacements, unresolved }
}
async function sources(root, dir = 'packages/web/src') {
  return (await Promise.all((await readdir(resolve(root, dir), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1).map(entry => entry.isDirectory() ? sources(root, `${dir}/${entry.name}`) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []))).flat()
}
export async function run(root, { write = false } = {}) {
  const theme = await readFile(resolve(root, 'packages/ui/generated/theme.css'), 'utf8')
  const files = [], unresolved = []
  let before = 0, after = 0, replacements = 0
  for (const file of await sources(root)) {
    const input = await readFile(resolve(root, file), 'utf8')
    const result = rewrite(file, input, theme)
    before += [...input.matchAll(/bg-\[var\(--/g)].length
    after += [...result.output.matchAll(/bg-\[var\(--/g)].length
    unresolved.push(...result.unresolved)
    if (result.output !== input) {
      files.push(file); replacements += result.replacements.length
      if (write) await writeFile(resolve(root, file), result.output)
    }
  }
  return { mode: write ? 'write' : 'check', bgBefore: before, bgAfter: after, replacements, files, unresolved }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await run(process.cwd(), { write: process.argv.includes('--write') })
  const output = JSON.stringify(report, null, 2) + '\n'
  const reportIndex = process.argv.indexOf('--report')
  if (reportIndex >= 0) await writeFile(resolve(process.argv[reportIndex + 1]), output)
  process.stdout.write(output)
}
