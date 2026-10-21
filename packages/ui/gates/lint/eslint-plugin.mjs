import { resolve } from 'node:path'
import { cssFindings } from '../scan.mjs'
import { inlineColourProperty, cssName, cssDiagnostics, hasLiteralColour } from './colours.mjs'

const rule = (message, create) => ({ meta: { type: 'problem', schema: [], messages: { violation: message } }, create })
const unwrap = node => node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'JSXExpressionContainer'].includes(node.type) ? unwrap(node.expression) : node
const keyOf = node => node?.type === 'Identifier' ? node.name : node?.value
function resolveBinding(node, context, seen = new Set()) {
  node = unwrap(node)
  if (!node || !['Identifier', 'JSXIdentifier'].includes(node.type) || seen.has(node)) return node
  seen.add(node)
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name)
    if (variable) {
      const name = variable.defs[0]?.name
      if (node.type === 'JSXIdentifier' && name?.parent?.type === 'AssignmentPattern' && name.parent.left === name) return resolveBinding(name.parent.right, context, seen)
      if (variable.defs[0]?.node?.id && variable.defs[0].node.id.type !== 'Identifier') return node
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
  else if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = [], right = []
    literalValues(node.left, context, value => left.push(value), next)
    literalValues(node.right, context, value => right.push(value), next)
    for (const a of left) for (const b of right) emit(a + b)
  }
  else if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) emit(String(node.value))
  else if (node.type === 'UnaryExpression' && node.argument.type === 'Literal') emit(`${node.operator}${node.argument.value}`)
  else if (node.type === 'TemplateLiteral' && !node.expressions.length) emit(node.quasis[0].value.cooked)
}
function propsStyles(node, context, emit, seen = new Set()) {
  node = resolveBinding(node, context)
  if (!node || seen.has(node)) return
  const next = new Set([...seen, node])
  if (node.type === 'ConditionalExpression') { propsStyles(node.consequent, context, emit, next); propsStyles(node.alternate, context, emit, next) }
  if (node.type === 'ObjectExpression') for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') propsStyles(prop.argument, context, emit, next)
    else if (keyOf(prop.key) === 'style') styleProperties(prop.value, context, emit)
  }
}
function elementFactory(node, context) {
  const resolved = resolveBinding(node, context)
  if (resolved?.type === 'MemberExpression') return ['createElement', 'jsx', 'jsxs', 'jsxDEV'].includes(keyOf(resolved.property))
  if (resolved?.type !== 'Identifier') return false
  if (['createElement', 'jsx', 'jsxs', 'jsxDEV'].includes(resolved.name)) return true
  for (let scope = context.sourceCode.getScope(resolved); scope; scope = scope.upper) {
    const definition = scope.set.get(resolved.name)?.defs[0]
    if (definition?.type === 'ImportBinding') return ['createElement', 'jsx', 'jsxs', 'jsxDEV'].includes(keyOf(definition.node.imported)) && /^react(?:\/jsx(?:-dev)?-runtime)?$/.test(definition.parent.source.value)
  }
  return false
}
function forbiddenImport(value, filename) {
  if (typeof value !== 'string') return false
  // These are public package exports, not component internals.
  if (/^@guanxi\/ui\/(?:catalog|approval|tokens|(?:tokens|theme|fonts)\.css)$/.test(value) || /^@guanxi\/ui\/brand\/[^.][\w./-]*$/.test(value) && !value.includes('..')) return false
  if (/^(?:@guanxi\/ui\/|@base-ui\/react(?:\/|$)|lucide-react(?:\/|$)|motion(?:\/|$))/.test(value)) return true
  const webRoot = filename.match(/^(.*\/packages\/web\/src)\//)?.[1]
  const target = value.startsWith('.') ? resolve(filename, '..', value) : value.startsWith('@/') && webRoot ? resolve(webRoot, value.slice(2)) : value
  if (/(?:^|\/)node_modules\/(?:@base-ui\/react|lucide-react|motion)(?:\/|$)/.test(target)) return true
  return /(?:^|\/)packages\/ui\/(?:src|catalog|generated|tokens)(?:\/|$)/.test(target) || /^@\/.*(?:ui\/src|ui\/components)/.test(target)
}
function moduleLoader(node, context) {
  node = resolveBinding(node, context)
  if (node?.type === 'Identifier') return node.name === 'require'
  if (node?.type === 'MemberExpression') return keyOf(node.property) === 'resolve' && moduleLoader(node.object, context) || keyOf(node.property) === 'glob' && node.object.type === 'MetaProperty'
  if (node?.type === 'CallExpression') {
    const callee = resolveBinding(node.callee, context)
    if (callee?.type !== 'Identifier') return false
    for (let scope = context.sourceCode.getScope(callee); scope; scope = scope.upper) {
      const def = scope.set.get(callee.name)?.defs[0]
      if (def?.type === 'ImportBinding') return keyOf(def.node.imported) === 'createRequire' && /^(?:node:)?module$/.test(def.parent.source.value)
    }
  }
  return false
}
export const rules = {
  'import-boundaries': rule('G8 import boundary: {{value}}; use @guanxi/ui public exports.', context => {
    const check = node => {
      literalValues(node, context, value => { if (forbiddenImport(value, context.physicalFilename)) context.report({ node, messageId: 'violation', data: { value } }) })
    }
    return {
      ImportDeclaration: n => check(n.source), ExportNamedDeclaration: n => n.source && check(n.source), ExportAllDeclaration: n => check(n.source),
      ImportExpression: n => check(n.source),
      TSImportType: n => check(n.argument?.literal ?? n.argument),
      TSExternalModuleReference: n => check(n.expression),
      CallExpression(n) { if (moduleLoader(n.callee, context) && n.arguments[0]) {
        const source = n.arguments[0]
        if (source.type === 'ArrayExpression') source.elements.filter(Boolean).forEach(check)
        else check(source)
      } },
    }
  }),
  'reuse-primitives': rule('G9 raw {{value}}; reuse a @guanxi/ui primitive.', context => {
    const raw = /^(?:button|input|select|textarea|dialog|style)$/
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return
        const report = value => { if (raw.test(value)) context.report({ node, messageId: 'violation', data: { value } }) }
        if (/^[a-z]/.test(node.name.name)) report(node.name.name)
        else literalValues(node.name, context, report)
      },
      CallExpression(node) { if (elementFactory(node.callee, context)) literalValues(node.arguments[0], context, value => { if (raw.test(value)) context.report({ node, messageId: 'violation', data: { value } }) }) },
    }
  }),
  'no-inline-colours': rule('G9 inline colour style {{value}}; use semantic utilities.', context => {
    const emit = (prop, name) => {
      if (name === null || inlineColourProperty.test(name) || /^(?:--.*(?:color|colour|background|foreground)|--(?:bg|fg)(?:-|$)|--.*-(?:bg|fg)(?:-|$))/.test(name)) context.report({ node: prop, messageId: 'violation', data: { value: name ?? '(unresolved style object/key)' } })
    }
    return {
    JSXAttribute(node) {
      if (node.name.name !== 'style') return
      styleProperties(node.value, context, emit)
    },
    JSXSpreadAttribute(node) { propsStyles(node.argument, context, emit) },
    CallExpression(node) { if (elementFactory(node.callee, context)) propsStyles(node.arguments[1], context, emit) },
  }}),
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
      for (const match of text.matchAll(/(?:^|\s)((?:[^\s]+:)?!?(?:[\w-]+-\[[^\s]+\]|[\w-]+-\(--[\w-]+\)|(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe)-\d+|(?:bg|text|border|ring|fill|stroke)-(?:black|white))(?:\/[^\s]+)?!?)(?=\s|$)/g)) context.report({ node, messageId: 'violation', data: { value: match[1] } })
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
