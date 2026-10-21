import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const sourcePath = fileURLToPath(new URL('../../web/src/index.css', import.meta.url))
const css = postcss.parse(await readFile(sourcePath, 'utf8'), { from: 'packages/web/src/index.css' })

function oneRule(selector) {
  const rules = []
  css.walkRules(rule => { if (rule.selector === selector) rules.push(rule) })
  assert.equal(rules.length, 1, `expected exactly one ${selector} rule`)
  return Object.fromEntries(rules[0].nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
}

function oneAtRule(name, params) {
  const rules = []
  css.walkAtRules(name, atRule => { if (params.test(atRule.params)) rules.push(atRule) })
  assert.equal(rules.length, 1, `expected exactly one @${name} ${params}`)
  return rules[0]
}

// var() tokens are the only accepted source for these properties; any raw duration,
// easing or distance left outside a var() would be a stale legacy value.
function rawMotion(value) {
  return value.replace(/var\([^)]*\)/g, '')
}

test('@theme and body typography consume the generated font tokens', () => {
  const theme = oneAtRule('theme', /^$/)
  const declarations = Object.fromEntries(theme.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))

  assert.equal(declarations['--font-sans'], 'var(--font-family-sans)')
  assert.equal(declarations['--font-mono'], 'var(--font-family-mono)')
  assert.doesNotMatch(declarations['--font-sans'], /Inter|system-ui|sans-serif/)
  assert.doesNotMatch(declarations['--font-mono'], /SF Mono|JetBrains|ui-monospace|Menlo|Monaco|monospace/)

  const body = oneRule('body')
  assert.equal(body['font-size'], 'var(--font-text-size)')
  assert.equal(body['line-height'], 'var(--font-line-height-ui)')
})

test(':focus-visible uses the focus offset and inline radius tokens', () => {
  const focus = oneRule(':focus-visible')
  assert.equal(focus.outline, 'var(--focus-ring-width) solid var(--color-ring-primary)')
  assert.equal(focus['outline-offset'], 'var(--focus-ring-offset)')
  assert.equal(focus['border-radius'], 'var(--border-radius-inline)')
})

test('legacy motion utilities use motion tokens and the fade keyframe uses the distance token', () => {
  assert.equal(oneRule('.anim-spin').animation, 'guanxi-spin var(--motion-duration-loop) var(--motion-easing-linear) infinite')
  assert.equal(oneRule('.anim-pulse-soft').animation, 'guanxi-pulse-soft var(--motion-duration-loop) var(--motion-easing-standard) infinite')
  assert.equal(oneRule('.anim-fade-up').animation, 'guanxi-fade-up var(--motion-duration-moderate) var(--motion-easing-enter)')
  // No step timing token exists; the approved mapping deliberately keeps step-end.
  assert.equal(oneRule('.stream-caret::after').animation, 'guanxi-caret var(--motion-duration-loop) step-end infinite')
  assert.equal(oneRule('.sheen::after').animation, 'guanxi-sheen var(--motion-duration-loop) var(--motion-easing-standard) infinite')

  const fade = oneAtRule('keyframes', /^guanxi-fade-up$/)
  const from = []
  fade.walkRules(rule => { if (rule.selector === 'from') from.push(rule) })
  assert.equal(from.length, 1, 'expected one fade-up from keyframe')
  const transform = from[0].nodes.find(node => node.type === 'decl' && node.prop === 'transform')
  assert.equal(transform?.value, 'translateY(var(--motion-distance-sm))')

  for (const value of ['.anim-spin', '.anim-pulse-soft', '.anim-fade-up', '.stream-caret::after', '.sheen::after'].map(selector => oneRule(selector).animation)) {
    assert.doesNotMatch(rawMotion(value), /\d+(?:\.\d+)?m?s\b|\bease(?:-in|-out|-in-out)?\b|\blinear\b|cubic-bezier|steps\(/)
  }
})

test('reduced motion removes animation and transition instead of zeroing them', () => {
  const media = oneAtRule('media', /prefers-reduced-motion:\s*reduce/)
  const rules = media.nodes.filter(node => node.type === 'rule')
  assert.equal(rules.length, 1)
  assert.equal(rules[0].selector.replace(/\s+/g, ' ').trim(), '*, *::before, *::after')

  const declarations = rules[0].nodes.filter(node => node.type === 'decl')
  assert.deepEqual(declarations.map(node => node.prop).sort(), ['animation', 'transition'])
  for (const declaration of declarations) {
    assert.equal(declaration.value, 'none')
    assert.equal(declaration.important, true)
  }
  const text = media.toString()
  assert.doesNotMatch(text, /0\.01ms|infinite|step-end/)
  assert.doesNotMatch(text, /(?:animation|transition)-duration|(?:animation|transition)-(?:iteration-count|timing-function)/)
})
