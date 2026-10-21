import Color from 'colorjs.io'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'
import { cssFindings } from '../scan.mjs'

export const colourProperty = /^(?:color|.*-color|background(?:-.*)?|border(?:-.*)?|outline(?:-.*)?|(?:box|text)-shadow|fill|stroke|stop-color|flood-color|lighting-color|column-rule|text-decoration|(?:-webkit-)?mask(?:-image)?|filter|backdrop-filter)$/
// Geometry longhands (border-width, background-position/size/repeat) stay usable
// with runtime values. Shorthands can carry colours, so G9 forbids those inline.
export const inlineColourProperty = /^(?:color|.*-color|background(?:-image)?|border(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?|outline|(?:box|text)-shadow|fill|stroke|stop-color|flood-color|lighting-color|column-rule|text-decoration|(?:-webkit-)?mask(?:-image)?|filter|backdrop-filter)$/
const permitted = /^(?:transparent|currentcolor|none|inherit|initial|unset|revert(?:-layer)?|canvas(?:text)?|button(?:text|face|border)|highlight(?:text)?|linktext|visitedtext|activetext|graytext|accentcolor(?:text)?)$/i
export const cssName = name => name.startsWith('--') ? name : name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
export function hasLiteralColour(value) {
  let found = /(?:%23|#)[0-9a-f]{3,8}\b/i.test(value)
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'function') {
        if (node.value.toLowerCase() === 'var') {
          const comma = node.nodes.findIndex(n => n.type === 'div' && n.value === ',')
          if (comma >= 0) walk(node.nodes.slice(comma + 1))
        } else if (/^(?:oklch|oklab|lch|lab|rgba?|hsla?|hwb|color|light-dark)$/i.test(node.value)) found = true
        else walk(node.nodes)
      } else if (node.type === 'word' && !permitted.test(node.value)) {
        try { new Color(node.value); found = true } catch { /* Not a CSS colour. */ }
      }
    }
  }
  walk(valueParser(value).nodes)
  return found
}
export function cssDiagnostics(file, text) {
  const existing = cssFindings(file, text).filter(f => f.gate === 'G6')
    // Property lists and tokenized transitions are not raw geometry/colour values.
    .filter(f => !/^transition-property:/.test(f.value) && !/^transition:/.test(f.value) || /\b[\d.]+m?s\b|\bease(?:-in|-out|-in-out)?\b|cubic-bezier\(/.test(f.value.replace(/var\([^)]*\)/g, '')))
  const seen = new Set(existing.map(f => f.offset))
  postcss.parse(text, { from: file }).walkDecls(decl => {
    if (colourProperty.test(decl.prop.toLowerCase()) && hasLiteralColour(decl.value) && !seen.has(decl.source.start.offset)) {
      existing.push({ value: `${decl.prop}:${decl.value}`, offset: decl.source.start.offset })
    }
  })
  return existing.sort((a, b) => a.offset - b.offset)
}
