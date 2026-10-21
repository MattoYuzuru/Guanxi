import { resolve } from 'node:path'
import { cssFindings } from '../scan.mjs'
import { colourProperty, cssName, cssDiagnostics, hasLiteralColour } from './colours.mjs'

const rule = (message, create) => ({ meta: { type: 'problem', schema: [], messages: { violation: message } }, create })
const unwrap = node => node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'JSXExpressionContainer'].includes(node.type) ? unwrap(node.expression) : node
const keyOf = node => node?.type === 'Identifier' ? node.name : node?.value
function resolveBinding(node, context, seen = new Set()) {
  node = unwrap(node)
  if (!node || node.type !== 'Identifier' || seen.has(node)) return node
  seen.add(node)
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name)
    if (variable) {
      const init = variable.defs[0]?.node?.init
      return init ? resolveBinding(init, context, seen) : node
    }
  }
  return node
}
function styleProperties(node, context, emit, seen = new Set()) {
  node = resolveBinding(node, context)
  if (!node || seen.has(node)) return
  const next = new Set([...seen, node])
  if (node.type === 'ConditionalExpression') { styleProperties(node.consequent, context, emit, next); styleProperties(node.alternate, context, emit, next) }
  else if (node.type === 'ObjectExpression') {
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') styleProperties(prop.argument, context, emit, next)
      else if (!prop.computed || prop.key.type === 'Literal') emit(prop, cssName(String(keyOf(prop.key))), prop.value)
      else emit(prop, null, prop.value)
    }
  } else if (node.type !== 'Literal' || node.value) emit(node, null, node)
}
function literalValues(node, context, emit, seen = new Set()) {
  node = resolveBinding(node, context)
  if (!node || seen.has(node)) return
  const next = new Set([...seen, node])
  if (node.type === 'ConditionalExpression') { literalValues(node.consequent, context, emit, next); literalValues(node.alternate, context, emit, next) }
  else if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) emit(String(node.value))
  else if (node.type === 'UnaryExpression' && node.argument.type === 'Literal') emit(`${node.operator}${node.argument.value}`)
}
function forbiddenImport(value, filename) {
  if (typeof value !== 'string') return false
  if (/^(?:@guanxi\/ui\/|@base-ui\/react(?:\/|$)|lucide-react(?:\/|$)|motion(?:\/|$))/.test(value)) return true
  const target = value.startsWith('.') ? resolve(filename, '..', value) : value
  return /(?:^|\/)packages\/ui\/(?:src|catalog|generated|tokens)(?:\/|$)/.test(target) || /^@\/.*(?:ui\/src|ui\/components)/.test(target)
}
export const rules = {
  'import-boundaries': rule('G8 import boundary: {{value}}; use @guanxi/ui public exports.', context => {
    const check = node => { if (forbiddenImport(node.value, context.physicalFilename)) context.report({ node, messageId: 'violation', data: { value: node.value } }) }
    return {
      ImportDeclaration: n => check(n.source), ExportNamedDeclaration: n => n.source && check(n.source), ExportAllDeclaration: n => check(n.source),
      ImportExpression: n => check(n.source),
      TSImportType: n => check(n.argument?.literal ?? n.argument),
      CallExpression(n) { if ((n.callee.name === 'require' || n.callee.property?.name === 'resolve' && n.callee.object?.name === 'require') && n.arguments[0]) check(n.arguments[0]) },
    }
  }),
  'reuse-primitives': rule('G9 raw {{value}}; reuse a @guanxi/ui primitive.', context => {
    const raw = /^(?:button|input|select|textarea|dialog)$/
    return {
      JSXOpeningElement(node) { if (node.name.type === 'JSXIdentifier' && raw.test(node.name.name)) context.report({ node, messageId: 'violation', data: { value: node.name.name } }) },
      CallExpression(node) { if ((node.callee.name === 'createElement' || node.callee.property?.name === 'createElement') && raw.test(node.arguments[0]?.value)) context.report({ node, messageId: 'violation', data: { value: node.arguments[0].value } }) },
    }
  }),
  'no-inline-colours': rule('G9 inline colour style {{value}}; use semantic utilities.', context => ({
    JSXAttribute(node) {
      if (node.name.name !== 'style') return
      styleProperties(node.value, context, (prop, name) => {
        if (name === null || colourProperty.test(name) || /^--.*(?:color|colour|background|foreground|(?:^|-)bg|(?:^|-)fg)/.test(name)) context.report({ node: prop, messageId: 'violation', data: { value: name ?? '(unresolved style object/key)' } })
      })
    },
  })),
  'no-literal-styles': rule('G6 literal inline style {{value}}.', context => ({
    JSXAttribute(node) {
      if (node.name.name === 'style') styleProperties(node.value, context, (prop, name, value) => {
        if (name) literalValues(value, context, text => { if (cssFindings('inline.css', `.x{${name}:${text}}`).some(f => f.gate === 'G6')) context.report({ node: prop, messageId: 'violation', data: { value: `${name}:${text}` } }) })
      })
      else if (/^(?:fill|stroke|stopColor|floodColor|lightingColor|strokeWidth)$/.test(node.name.name)) literalValues(node.value, context, text => {
        if (cssDiagnostics('inline.css', `.x{${cssName(node.name.name)}:${text}}`).length) context.report({ node, messageId: 'violation', data: { value: `${node.name.name}:${text}` } })
      })
    },
  })),
  // Lexical fallback deliberately follows literal definitions, including imported maps and
  // arrays joined at their use site. Runtime-built fragments remain outside static lint.
  'semantic-classes': rule('G5 non-semantic class {{value}}.', context => {
    const inspect = (node, text) => {
      for (const match of text.matchAll(/(?:^|\s)((?:[^\s]+:)?!?(?:[\w-]+-\[[^\s]+\]|[\w-]+-\(--[\w-]+\)|(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d+)(?:\/[^\s]+)?!?)(?=\s|$)/g)) context.report({ node, messageId: 'violation', data: { value: match[1] } })
    }
    return { Literal(n) { if (typeof n.value === 'string') inspect(n, n.value) }, TemplateElement(n) { inspect(n, n.value.cooked ?? n.value.raw) } }
  }),
  'no-literal-css': rule('G6 literal CSS {{value}}.', context => ({
    Program(node) {
      try {
        for (const finding of cssDiagnostics(context.filename, context.sourceCode.text)) context.report({ loc: context.sourceCode.getLocFromIndex(finding.offset), messageId: 'violation', data: { value: finding.value } })
      } catch (error) { context.report({ node, messageId: 'violation', data: { value: error.reason ?? error.message } }) }
    },
  })),
  'svg-styles': rule('G6 SVG/HTML style {{value}}.', context => ({
    Program(node) {
      const text = context.sourceCode.text
      for (const match of text.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gs)) {
        try {
          for (const finding of cssDiagnostics(context.filename, `.x{${match[2]}}`)) context.report({ loc: context.sourceCode.getLocFromIndex(match.index), messageId: 'violation', data: { value: finding.value } })
        } catch (error) { context.report({ node, messageId: 'violation', data: { value: error.reason ?? error.message } }) }
      }
      for (const match of text.matchAll(/\b(fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*(["'])(.*?)\2/gs)) {
        if (hasLiteralColour(match[3])) context.report({ loc: context.sourceCode.getLocFromIndex(match.index), messageId: 'violation', data: { value: `${match[1]}:${match[3]}` } })
      }
    },
  })),
}
export default { meta: { name: 'guanxi', version: '1.0.0' }, rules }
