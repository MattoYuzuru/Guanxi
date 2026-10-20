/**
 * G15 i18n, static part: no literal user-facing text in @guanxi/ui components, stories or the
 * catalog. Text comes from message keys (English source, curated Russian); machine values go
 * through `machine()`. The browser part (clipping in Russian and the +40% pseudo-locale) runs
 * in ./browser/g15-i18n-clipping.spec.ts.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { overlay } from './lib/scratch.ts'
import { result, type CatalogGate, type GateFinding } from './types.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'g15')

const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'alt',
  'title',
  'placeholder',
  'label',
  'loadingLabel',
  'description',
])
const USER_FACING_KEYS = new Set([...USER_FACING_ATTRIBUTES, 'children', 'text', 'action'])
const LETTER = /\p{L}/u

function walk(dir: string, out: string[], skip: (path: string) => boolean): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (skip(full)) continue
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) walk(full, out, skip)
    else if (name.endsWith('.tsx')) out.push(full)
  }
}

export function literalTextFindings(repoRoot: string, uiRoot: string): GateFinding[] {
  const files: string[] = []
  const skip = (path: string) => /[/\\](node_modules|dist|harness)([/\\]|$)/.test(path)
  walk(join(uiRoot, 'src'), files, skip)
  walk(join(uiRoot, 'catalog'), files, skip)
  walk(join(repoRoot, 'packages', 'web', 'src', 'features', 'catalog'), files, skip)
  const findings: GateFinding[] = []
  for (const path of files.sort()) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const rel = relative(repoRoot, path).split(sep).join('/')
    const isStory = path.endsWith('.stories.tsx')
    const report = (node: ts.Node, what: string) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      findings.push({ severity: 'error', file: `${rel}:${line + 1}`, message: `literal user-facing text ${what}` })
    }
    const literalText = (node: ts.Node | undefined): string | null => {
      if (!node) return null
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
      if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => span.literal.text).join('')
      if (ts.isJsxExpression(node)) return literalText(node.expression)
      return null
    }
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const text = node.getText().trim()
        if (text !== '' && LETTER.test(text)) report(node, `"${text.slice(0, 40)}"`)
      } else if (ts.isJsxAttribute(node)) {
        const name = node.name.getText()
        const text = literalText(node.initializer)
        if (USER_FACING_ATTRIBUTES.has(name) && text !== null && LETTER.test(text)) report(node, `in ${name}="${text.slice(0, 40)}"`)
      } else if (isStory && ts.isPropertyAssignment(node)) {
        const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
        const text = literalText(node.initializer)
        if (key !== null && USER_FACING_KEYS.has(key) && text !== null && LETTER.test(text)) {
          const metaTitle = key === 'title' && /^(Primitives|Patterns)\//.test(text)
          if (!metaTitle) report(node, `in story arg ${key}: "${text.slice(0, 40)}"`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return findings
}

export const g15: CatalogGate = {
  id: 'G15',
  title: 'i18n: no literal user-facing text',
  mode: 'fast',
  async run(context) {
    return result(this, literalTextFindings(context.repoRoot, context.uiRoot))
  },
  seeded: [
    {
      name: 'literal-jsx-text',
      description: 'A component renders <span>Save</span> instead of a message key',
      expect: /literal user-facing text "Save"/,
      apply({ repoRoot, context }) {
        overlay(join(fixtures, 'literal-jsx-text'), repoRoot)
        return context
      },
    },
  ],
}
