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
  if (file.endsWith('.html')) return [...text.matchAll(/\b(?:class|\w*ClassName)\s*=\s*(["'])(.*?)\1/gs)].flatMap(match => match[2].split(/\s+/).filter(Boolean).map(value => ({ value, offset: match.index })))
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = new Set()
  const bindings = new Map()
  const nameOf = node => node?.getText(ast).replace(/^['"]|['"]$/g, '')
  const scope = node => {
    while (node && !ts.isSourceFile(node) && !ts.isBlock(node) && !ts.isFunctionLike(node)) node = node.parent
    return node
  }
  const collectBindings = node => {
    if ((ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) || (ts.isFunctionDeclaration(node) && node.name)) {
      const parent = scope(node.parent)
      if (!bindings.has(parent)) bindings.set(parent, new Map())
      bindings.get(parent).set(node.name.text, ts.isFunctionDeclaration(node) ? node : node.initializer)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(ast)
  function binding(node) {
    for (let parent = node.parent; parent; parent = parent.parent) if (bindings.get(parent)?.has(node.text)) return bindings.get(parent).get(node.text)
  }
  function unwrap(node, seen = new Set()) {
    if (!node || seen.has(node)) return []
    const next = new Set([...seen, node])
    if (ts.isIdentifier(node)) return unwrap(binding(node), next)
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return unwrap(node.expression, next)
    if (ts.isConditionalExpression(node)) return [...unwrap(node.whenTrue, next), ...unwrap(node.whenFalse, next)]
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined
      return unwrap(node.expression, next).flatMap(object => members(object, key, next)).flatMap(value => unwrap(value, next))
    }
    return [node]
  }
  function members(object, key, seen) {
    if (ts.isArrayLiteralExpression(object)) return key === undefined ? [...object.elements] : object.elements[Number(key)] ? [object.elements[Number(key)]] : []
    if (!ts.isObjectLiteralExpression(object) || seen.has(object)) return []
    const next = new Set([...seen, object])
    return object.properties.flatMap(property => {
      if (ts.isSpreadAssignment(property)) return unwrap(property.expression, next).flatMap(value => members(value, key, next))
      if (key !== undefined && nameOf(property.name) !== key) return []
      if (ts.isPropertyAssignment(property)) return [property.initializer]
      if (ts.isShorthandPropertyAssignment(property)) return [property.name]
      return []
    })
  }
  function collect(node, seen = new Set(), objectMode = 'values') {
    if (!node || seen.has(node)) return
    const next = new Set([...seen, node])
    if (ts.isStringLiteralLike(node)) values.add(node)
    else if (ts.isIdentifier(node)) collect(binding(node), next, objectMode)
    else if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) collect(node.expression, next, objectMode)
    else if (ts.isConditionalExpression(node)) { collect(node.whenTrue, next, objectMode); collect(node.whenFalse, next, objectMode) }
    else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) collect(node.left, next, objectMode)
      collect(node.right, next, objectMode)
    } else if (ts.isTemplateExpression(node)) {
      values.add(node.head)
      for (const span of node.templateSpans) { collect(span.expression, next); values.add(span.literal) }
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(item => collect(item, next, objectMode))
    else if (ts.isSpreadElement(node)) collect(node.expression, next, objectMode)
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      for (const value of unwrap(node)) collect(value, next, objectMode)
    } else if (ts.isObjectLiteralExpression(node)) {
      // Bound class maps hold class values; clsx/cn condition objects hold class keys.
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) collect(property.expression, next, objectMode)
        else if (ts.isPropertyAssignment(property)) {
          if (objectMode === 'conditions') {
            if (ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name)) values.add(property.name)
          } else collect(property.initializer, next)
        }
      }
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      const returns = body => {
        if (ts.isReturnStatement(body)) collect(body.expression, next, objectMode)
        else ts.forEachChild(body, child => { if (!ts.isFunctionLike(child)) returns(child) })
      }
      if (node.body) { if (ts.isBlock(node.body)) returns(node.body); else collect(node.body, next, objectMode) }
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
      } else if (['cn', 'clsx', 'classnames', 'twMerge', 'cx'].includes(helper)) node.arguments.forEach(arg => collect(arg, next, 'conditions'))
      else if (ts.isIdentifier(node.expression)) collect(binding(node.expression), next, objectMode)
    }
  }
  const visit = node => {
    if (ts.isJsxAttribute(node) && /^(?:class|className|.*ClassName)$/.test(node.name.getText(ast))) collect(node.initializer)
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && /(?:className|classes|Class|Classes|ClassName)$/.test(node.name?.getText(ast) ?? '')) collect(node.initializer)
    if (ts.isCallExpression(node) && /^(cva|cn|clsx|classnames|twMerge|cx)$/.test(nameOf(node.expression)?.split('.').at(-1))) collect(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...values].flatMap(node => node.text.split(/\s+/).filter(Boolean).map(value => ({ value, offset: node.getStart(ast) })))
}

const propertyPattern = /^(?:color|(?:accent|caret|text-decoration|scrollbar)-color|background(?:-.*)?|border(?:-.*)?|outline(?:-.*)?|fill|stroke(?:-width)?|(?:box|text)-shadow|(?:margin|padding)(?:-.*)?|(?:row-|column-)?gap|font(?:-size|-family|-weight)?|z-index|(?:min-|max-)?(?:width|height)|inset(?:-.*)?|top|right|bottom|left|border-radius|line-height|letter-spacing|filter|backdrop-filter|transform|translate|scale|rotate|transition(?:-.*)?|animation(?:-.*)?)$/
const motionProperty = /^(?:transition|animation)(?:-.*)?$/
const keywords = new Set(['none', 'auto', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'transparent', 'currentcolor', 'solid', 'dashed', 'dotted', 'double', 'hidden', 'visible', 'normal', 'infinite', 'both', 'forwards', 'backwards', 'running', 'paused', 'alternate', 'reverse', 'alternate-reverse', 'canvas', 'canvastext', 'buttontext', 'highlight', 'highlighttext', 'linktext', 'graytext'])

function rawWords(value) {
  const raw = []
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === 'function' && node.value === 'var') {
        const comma = node.nodes.findIndex(n => n.type === 'div' && n.value === ',')
        if (comma >= 0) visit(node.nodes.slice(comma + 1))
      } else {
        if (node.type === 'word' && !keywords.has(node.value.toLowerCase()) && node.value !== '0') raw.push(node.value)
        if (node.type === 'function') {
          if (/^(?:oklch|oklab|rgba?|hsla?|color|cubic-bezier|steps|linear)$/.test(node.value.toLowerCase())) raw.push(node.value.toLowerCase())
          visit(node.nodes)
        }
      }
    }
  }
  visit(valueParser(value.replace(/!important\s*$/, '')).nodes)
  return raw
}
export function cssFindings(file, text) {
  const findings = []
  const ast = postcss.parse(text, { from: file })
  ast.walkDecls(decl => {
    // Tokens, @font-face metadata and geometry variables have distinct authoring contracts.
    if (decl.parent?.name === 'font-face') return
    const words = rawWords(decl.value)
    if ((propertyPattern.test(decl.prop.toLowerCase()) || decl.prop.startsWith('--')) && words.length) findings.push({ gate: 'G6', file, value: `${decl.prop}:${decl.value}`, offset: decl.source.start.offset })
    if (motionProperty.test(decl.prop.toLowerCase()) && (/(?:[\d.]+m?s\b|\b(?:cubic-bezier|steps|ease(?:-in|-out|-in-out)?|linear|step-start|step-end)\b)/.test(words.join(' ')))) findings.push({ gate: 'G7', file, value: `${decl.prop}:${decl.value}`, offset: decl.source.start.offset })
  })
  return findings
}

export function motionFindings(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(/(?:\b(?:(?:duration|delay)-(?:\[[^\]]+\]|\d+)|ease-(?:\[[^\]]+\]|in-out|in|out))(?![\w-])|\b\d+(?:\.\d+)?m?s\b|cubic-bezier\([^)]*\))/g)) findings.push({ gate: 'G7', file, value: match[0], offset: node.getStart(ast) })
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
  const cssFile = file => /\.(css|scss)$/.test(file)
  const custom = new Set()
  for (const [, text] of sources.filter(([f]) => cssFile(f))) postcss.parse(text).walkRules(rule => {
    for (const match of rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) custom.add(match[1])
  })
  const spacing = new Set(Object.keys((await ctx.json('packages/ui/tokens/base.tokens.json')).spacing).map(n => Number(n) / 4))
  spacing.add(0)
  function invalidClass(value) {
    const utility = value.split(':').at(-1).replace(/^!|!$/g, '')
    const step = /^-?(?:(?:scroll-)?(?:p[xysetblr]?|m[xysetblr]?)|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|indent)-(\d+(?:\.\d+)?|px)$/.exec(utility)
    return value.includes('[') || value.includes('-(') || (step && (step[1] === 'px' || !spacing.has(Number(step[1])))) || (!custom.has(value) && system.candidatesToCss([value])[0] === null)
  }
  for (const [file, text] of sources) {
    if (cssFile(file)) {
      result.push(...cssFindings(file, text))
      postcss.parse(text).walkAtRules('apply', rule => {
        for (const value of rule.params.split(/\s+/).filter(v => v !== '!important')) if (invalidClass(value)) result.push({ gate: 'G5', file, value, offset: rule.source.start.offset })
        result.push(...motionFindings(file, JSON.stringify(rule.params)))
      })
    }
    else {
      for (const { value, offset } of classStrings(file, text)) {
        if (invalidClass(value)) result.push({ gate: 'G5', file, value, offset })
      }
      result.push(...motionFindings(file, text))
      if (file.endsWith('.html')) for (const match of text.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gs)) result.push(...cssFindings(file, `.inline { ${match[2]} }`))
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
