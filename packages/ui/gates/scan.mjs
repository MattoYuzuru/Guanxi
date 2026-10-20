import ts from 'typescript'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { sourceFiles } from './context.mjs'

const require = createRequire(import.meta.url)
const tailwindTheme = await readFile(require.resolve('tailwindcss/theme.css'), 'utf8')
export async function designSystem(ctx) {
  return __unstable__loadDesignSystem(tailwindTheme + '\n' + await ctx.read('packages/ui/generated/theme.css') + '\n@tailwind utilities;')
}

function strings(node, output = []) {
  if (ts.isStringLiteralLike(node)) output.push(node)
  else if (ts.isTemplateExpression(node)) {
    output.push(node.head)
    for (const span of node.templateSpans) { strings(span.expression, output); output.push(span.literal) }
  } else ts.forEachChild(node, child => { strings(child, output) })
  return output
}
export function classStrings(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = new Set()
  const visit = node => {
    if (ts.isJsxAttribute(node) && /^(className|class)$/.test(node.name.getText(ast)) && node.initializer) strings(node.initializer).forEach(s => values.add(s))
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && /(?:className|classes|Class|Classes)$/.test(node.name?.getText(ast) ?? '') && node.initializer) strings(node.initializer).forEach(s => values.add(s))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...values].flatMap(node => node.text.split(/\s+/).filter(Boolean).map(value => ({ value, offset: node.getStart(ast) })))
}

const propertyPattern = /^(?:color|background(?:-.*)?|border(?:-.*)?|outline(?:-.*)?|fill|stroke|(?:box|text)-shadow|(?:margin|padding)(?:-.*)?|(?:row-|column-)?gap|font-size|z-index|(?:min-|max-)?(?:width|height)|inset(?:-.*)?|top|right|bottom|left|border-radius|line-height|letter-spacing|transition(?:-.*)?|animation(?:-.*)?)$/
const motionProperty = /^(?:transition|animation)(?:-.*)?$/
const keywords = new Set(['none', 'auto', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'transparent', 'currentcolor', 'solid', 'dashed', 'dotted', 'double', 'hidden', 'visible', 'normal', 'infinite', 'both', 'forwards', 'backwards', 'running', 'paused', 'alternate', 'reverse', 'alternate-reverse', 'canvas', 'canvastext', 'buttontext', 'highlight', 'highlighttext', 'linktext', 'graytext'])

function rawWords(value) {
  const raw = []
  valueParser(value.replace(/!important\s*$/, '')).walk(node => {
    if (node.type === 'function' && node.value === 'var') return false
    if (node.type === 'word' && !keywords.has(node.value.toLowerCase()) && node.value !== '0') raw.push(node.value)
    if (node.type === 'function' && /^(?:oklch|oklab|rgba?|hsla?|color|cubic-bezier|steps)$/.test(node.value)) raw.push(node.value)
  })
  return raw
}
export function cssFindings(file, text) {
  const findings = []
  const ast = postcss.parse(text, { from: file })
  ast.walkDecls(decl => {
    // Tokens, @font-face metadata and geometry variables have distinct authoring contracts.
    if (decl.parent?.name === 'font-face') return
    const words = rawWords(decl.value)
    if ((propertyPattern.test(decl.prop) || decl.prop.startsWith('--')) && words.length) findings.push({ gate: 'G6', file, value: `${decl.prop}:${decl.value}`, offset: decl.source.start.offset })
    if (motionProperty.test(decl.prop) && (/(?:[\d.]+m?s\b|cubic-bezier\(|\b(?:ease(?:-in|-out|-in-out)?|linear|step-start|step-end)\b)/.test(decl.value.replace(/var\([^)]*\)/g, '')))) findings.push({ gate: 'G7', file, value: `${decl.prop}:${decl.value}`, offset: decl.source.start.offset })
  })
  return findings
}

export function motionFindings(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(/(?:\b(?:duration|delay|ease)-(?:\[[^\]]+\]|\d+|linear|in|out|in-out)|\b\d+(?:\.\d+)?m?s\b|cubic-bezier\([^)]*\))/g)) findings.push({ gate: 'G7', file, value: match[0], offset: node.getStart(ast) })
    }
    if (ts.isPropertyAssignment(node) && /^(?:duration|delay|transitionDuration|transitionDelay|animationDuration|animationDelay|easing|ease)$/.test(node.name.getText(ast).replaceAll(/['"]/g, '')) && (ts.isNumericLiteral(node.initializer) || ts.isStringLiteralLike(node.initializer) && !/^(?:var\(--|motion\.)/.test(node.initializer.text))) findings.push({ gate: 'G7', file, value: node.getText(ast), offset: node.getStart(ast) })
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return findings
}

export async function scanLiterals(ctx) {
  const result = []
  const system = await designSystem(ctx)
  const sources = await Promise.all(sourceFiles(ctx).map(async file => [file, await ctx.read(file)]))
  // Custom classes must be declared in source CSS; names in JSX alone are not proof.
  const custom = new Set(sources.filter(([f]) => f.endsWith('.css')).flatMap(([, text]) => [...text.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => m[1])))
  for (const [file, text] of sources) {
    if (file.endsWith('.css')) result.push(...cssFindings(file, text))
    else {
      for (const { value, offset } of classStrings(file, text)) {
        if (value.includes('[') || (!custom.has(value) && system.candidatesToCss([value])[0] === null)) result.push({ gate: 'G5', file, value, offset })
      }
      result.push(...motionFindings(file, text))
    }
  }
  return result
}

export const findingKey = finding => `${finding.gate}|${finding.file}|${finding.value}`
export function counts(findings) {
  const result = {}
  for (const f of findings) result[findingKey(f)] = (result[findingKey(f)] ?? 0) + 1
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
