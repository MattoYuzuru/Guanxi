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

export function classStrings(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = new Set()
  const bindings = new Map()
  const nameOf = node => node?.getText(ast).replace(/^['"]|['"]$/g, '')
  const collectBindings = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer)
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(ast)
  function collect(node, seen = new Set()) {
    if (!node || seen.has(node)) return
    const next = new Set([...seen, node])
    if (ts.isStringLiteralLike(node)) values.add(node)
    else if (ts.isIdentifier(node)) collect(bindings.get(node.text), next)
    else if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) collect(node.expression, next)
    else if (ts.isConditionalExpression(node)) { collect(node.whenTrue, next); collect(node.whenFalse, next) }
    else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) collect(node.left, next)
      collect(node.right, next)
    } else if (ts.isTemplateExpression(node)) {
      values.add(node.head)
      for (const span of node.templateSpans) { collect(span.expression, next); values.add(span.literal) }
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(item => collect(item, next))
    else if (ts.isPropertyAccessExpression(node)) {
      const object = ts.isIdentifier(node.expression) && bindings.get(node.expression.text)
      if (object && ts.isObjectLiteralExpression(object)) collect(object.properties.find(p => nameOf(p.name) === node.name.text)?.initializer, next)
    } else if (ts.isObjectLiteralExpression(node)) {
      // clsx/cn object keys are classes; their values are conditions.
      for (const property of node.properties) if (ts.isPropertyAssignment(property) && (ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name))) values.add(property.name)
    } else if (ts.isCallExpression(node)) {
      const helper = nameOf(node.expression)?.split('.').at(-1)
      if (helper === 'cva') {
        collect(node.arguments[0], next)
        const config = node.arguments[1]
        if (config && ts.isObjectLiteralExpression(config)) for (const property of config.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          if (nameOf(property.name) === 'variants' && ts.isObjectLiteralExpression(property.initializer)) {
            for (const variant of property.initializer.properties) if (ts.isPropertyAssignment(variant) && ts.isObjectLiteralExpression(variant.initializer)) for (const option of variant.initializer.properties) if (ts.isPropertyAssignment(option)) collect(option.initializer, next)
          }
          if (nameOf(property.name) === 'compoundVariants' && ts.isArrayLiteralExpression(property.initializer)) for (const variant of property.initializer.elements) {
            if (ts.isObjectLiteralExpression(variant)) for (const field of variant.properties) if (ts.isPropertyAssignment(field) && /^(class|className)$/.test(nameOf(field.name))) collect(field.initializer, next)
          }
        }
      } else if (['cn', 'clsx', 'classnames', 'twMerge', 'cx'].includes(helper)) node.arguments.forEach(arg => collect(arg, next))
      else if (ts.isIdentifier(node.expression)) collect(bindings.get(node.expression.text), next)
    }
  }
  const visit = node => {
    if (ts.isJsxAttribute(node) && /^(className|class)$/.test(node.name.getText(ast))) collect(node.initializer)
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && /(?:className|classes|Class|Classes)$/.test(node.name?.getText(ast) ?? '')) collect(node.initializer)
    if (ts.isCallExpression(node) && /^(cva|cn|clsx|classnames|twMerge|cx)$/.test(nameOf(node.expression)?.split('.').at(-1))) collect(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...values].flatMap(node => node.text.split(/\s+/).filter(Boolean).map(value => ({ value, offset: node.getStart(ast) })))
}

const propertyPattern = /^(?:color|background(?:-.*)?|border(?:-.*)?|outline(?:-.*)?|fill|stroke|(?:box|text)-shadow|(?:margin|padding)(?:-.*)?|(?:row-|column-)?gap|font(?:-size)?|z-index|(?:min-|max-)?(?:width|height)|inset(?:-.*)?|top|right|bottom|left|border-radius|line-height|letter-spacing|transition(?:-.*)?|animation(?:-.*)?)$/
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
    if (ts.isPropertyAssignment(node) && /^(?:duration|delay|(?:transition|animation)(?:Duration|Delay|TimingFunction)|easing|ease)$/.test(node.name.getText(ast).replaceAll(/['"]/g, '')) && (ts.isNumericLiteral(node.initializer) || ts.isArrayLiteralExpression(node.initializer) || ts.isStringLiteralLike(node.initializer) && !/^(?:var\(--|motion\.)/.test(node.initializer.text))) findings.push({ gate: 'G7', file, value: node.getText(ast), offset: node.getStart(ast) })
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
    if (file.endsWith('.css')) {
      result.push(...cssFindings(file, text))
      postcss.parse(text).walkAtRules('apply', rule => {
        for (const value of rule.params.split(/\s+/).filter(v => v !== '!important')) if (value.includes('[') || system.candidatesToCss([value])[0] === null) result.push({ gate: 'G5', file, value, offset: rule.source.start.offset })
      })
    }
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
