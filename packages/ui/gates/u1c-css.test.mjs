import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const sourcePath = fileURLToPath(new URL('../../web/src/index.css', import.meta.url))
const manifestPath = fileURLToPath(new URL('../tokens/motion-animations.json', import.meta.url))
const generatedThemePath = fileURLToPath(new URL('../generated/theme.css', import.meta.url))
const tokensFlatPath = fileURLToPath(new URL('../generated/tokens.flat.json', import.meta.url))
const allowlistPath = fileURLToPath(new URL('./legacy-allowlist.json', import.meta.url))
const css = postcss.parse(await readFile(sourcePath, 'utf8'), { from: 'packages/web/src/index.css' })

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))
const cssVar = name => `--${name.replaceAll('.', '-')}`

function oneRule(selector) {
  const rules = []
  css.walkRules(rule => { if (rule.selector === selector) rules.push(rule) })
  assert.equal(rules.length, 1, `expected exactly one ${selector} rule`)
  return Object.fromEntries(rules[0].nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
}
function oneRuleNode(selector) {
  const rules = []
  css.walkRules(rule => { if (rule.selector === selector) rules.push(rule) })
  assert.equal(rules.length, 1, `expected exactly one ${selector} rule`)
  return rules[0]
}
function oneAtRule(name, params) {
  const rules = []
  css.walkAtRules(name, atRule => { if (params.test(atRule.params)) rules.push(atRule) })
  assert.equal(rules.length, 1, `expected exactly one @${name} ${params}`)
  return rules[0]
}
function applyParams(rule) {
  return rule.nodes.filter(node => node.type === 'atrule' && node.name === 'apply').map(node => node.params)
}
function declarations(rule, property) {
  return rule.nodes.filter(node => node.type === 'decl' && node.prop === property).map(node => node.value)
}

// var() tokens are the only accepted source for these properties; any raw duration,
// easing or distance left outside a var() would be a stale legacy value.
function rawMotion(value) {
  return value.replace(/var\([^)]*\)/g, '')
}

// Both reduced-motion branches must remove animation entirely: a 0 ms infinite animation
// still counts as running, and transition longhands can still animate.
function assertMotionRemoved(rule) {
  const declarations = rule.nodes.filter(node => node.type === 'decl')
  assert.deepEqual(declarations.map(node => node.prop).sort(), ['animation', 'transition'])
  for (const declaration of declarations) {
    assert.equal(declaration.value, 'none')
    assert.equal(declaration.important, true)
  }
  const text = rule.toString()
  assert.doesNotMatch(text, /\b\d+(?:\.\d+)?m?s\b/)
  assert.doesNotMatch(text, /infinite|step-end/)
  assert.doesNotMatch(text, /(?:animation|transition)-(?:duration|iteration-count|timing-function|delay)/)
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

test('the authored animation manifest is closed and composes only accepted motion tokens', async () => {
  const manifest = await readJSON(manifestPath)
  assert.deepEqual(Object.keys(manifest), ['animations'])
  assert.equal(manifest.animations.length, 4)
  const flat = (await readJSON(tokensFlatPath))['light/compact/full']
  const tokens = new Map(flat.map(token => [token.name, token.$type]))
  const utilities = new Set(), keyframes = new Set()
  for (const [index, animation] of manifest.animations.entries()) {
    assert.deepEqual(Object.keys(animation).sort(), ['duration', 'easing', 'iterations', 'keyframes', 'utility'], `animation ${index + 1} fields`)
    assert.match(animation.utility, /^[a-z][a-z0-9-]*$/)
    assert.match(animation.keyframes, /^[a-z][a-z0-9-]*$/)
    assert.match(animation.duration, /^motion\.duration\.[a-z][a-z0-9-]*$/)
    assert.match(animation.easing, /^motion\.easing\.[a-z][a-z0-9-]*$/)
    assert.equal(tokens.get(animation.duration), 'duration', animation.duration)
    assert.equal(tokens.get(animation.easing), 'cubicBezier', animation.easing)
    assert.ok(animation.iterations === 'infinite' || Number.isInteger(animation.iterations) && animation.iterations > 0, animation.utility)
    assert.equal(utilities.has(animation.utility), false, `duplicate utility ${animation.utility}`)
    assert.equal(keyframes.has(animation.keyframes), false, `duplicate keyframes ${animation.keyframes}`)
    utilities.add(animation.utility)
    keyframes.add(animation.keyframes)
  }
  assert.deepEqual([...utilities].sort(), ['fade-up', 'pulse-soft', 'sheen', 'spinner'])
})

test('legacy motion classes apply the generated canonical animate utilities', async () => {
  const expected = [
    ['.anim-spin', 'spinner'],
    ['.anim-pulse-soft', 'pulse-soft'],
    ['.anim-fade-up', 'fade-up'],
    ['.sheen::after', 'sheen'],
  ]
  for (const [selector, utility] of expected) {
    const rule = oneRuleNode(selector)
    assert.deepEqual(declarations(rule, 'animation'), [], `${selector} must not keep a literal animation shorthand`)
    assert.deepEqual(applyParams(rule), [`animate-${utility}`], `${selector} must apply exactly the generated ${utility} utility`)
  }

  const manifest = await readJSON(manifestPath)
  const theme = postcss.parse(await readFile(generatedThemePath, 'utf8'))
  const generated = []
  theme.walkDecls(/^--animate-/, declaration => { if (declaration.prop !== '--animate-*') generated.push([declaration.prop, declaration.value]) })
  const expectedDeclarations = manifest.animations
    .map(animation => [`--animate-${animation.utility}`, `${animation.keyframes} var(${cssVar(animation.duration)}) var(${cssVar(animation.easing)})${animation.iterations === 'infinite' ? ' infinite' : ''}`])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  assert.deepEqual(generated, expectedDeclarations)
  for (const [, value] of generated) {
    assert.match(value, /^guanxi-[a-z-]+ var\(--motion-duration-[a-z]+\) var\(--motion-easing-[a-z]+\)(?: infinite)?$/)
    assert.doesNotMatch(rawMotion(value), /(?:\d+(?:\.\d+)?m?s\b|cubic-bezier|ease(?:-in|-out|-in-out)?|\blinear\b)/)
  }
  assert.equal(generated.some(([property]) => property === '--animate-caret'), false)
})

test('the streaming caret is static and the caret keyframe is gone', async () => {
  const caret = oneRuleNode('.stream-caret::after')
  assert.deepEqual(declarations(caret, 'animation'), [])
  assert.deepEqual(applyParams(caret), [])
  const caretDeclarations = oneRule('.stream-caret::after')
  assert.equal(caretDeclarations.background, 'var(--color-background-accent)')
  assert.equal(caretDeclarations.width, '0.42em')
  assert.equal(caretDeclarations.height, '1.05em')

  const keyframes = []
  css.walkAtRules('keyframes', rule => keyframes.push(rule.params))
  assert.equal(keyframes.includes('guanxi-caret'), false)
  const manifest = await readJSON(manifestPath)
  assert.deepEqual([...keyframes].sort(), manifest.animations.map(animation => animation.keyframes).sort())

  const chatSource = await readFile(new URL('../../web/src/features/chat/ChatPage.tsx', import.meta.url), 'utf8')
  const modalSource = await readFile(new URL('../../web/src/components/ui.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(chatSource, /anim-fade-up/, 'streaming transcript must not use the spatial fade')
  assert.match(modalSource, /className="anim-fade-up\b/, 'the legacy modal keeps the compatibility class')

  const animationDeclarations = []
  css.walkDecls('animation', declaration => animationDeclarations.push(declaration))
  assert.equal(animationDeclarations.length, 2, 'only the two reduced-motion animation: none declarations remain')
  for (const declaration of animationDeclarations) {
    assert.equal(declaration.value, 'none')
    assert.equal(declaration.important, true)
    assert.match(declaration.parent.selector, /:root(?:\[data-motion="reduced"\]|:not\(\[data-motion="full"\]\))/)
  }
  const applies = []
  css.walkAtRules('apply', rule => { if (/^animate-/.test(rule.params)) applies.push(rule.params) })
  assert.deepEqual(applies.sort(), ['animate-fade-up', 'animate-pulse-soft', 'animate-sheen', 'animate-spinner'])
})

test('the ledger retires every animation shorthand and keeps only the exact reduced allowance', async () => {
  const allowance = await readJSON(allowlistPath)
  const retired = [
    "G6|packages/web/src/index.css|--font-mono:'SF Mono', 'JetBrains Mono', ui-monospace, 'Menlo', 'Monaco', monospace",
    "G6|packages/web/src/index.css|--font-sans:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    'G6|packages/web/src/index.css|animation-duration:0.01ms',
    'G6|packages/web/src/index.css|animation-iteration-count:1',
    'G6|packages/web/src/index.css|animation:guanxi-caret 1.05s step-end infinite',
    'G6|packages/web/src/index.css|animation:guanxi-fade-up 0.16s ease-out',
    'G6|packages/web/src/index.css|animation:guanxi-pulse-soft 1.6s ease-in-out infinite',
    'G6|packages/web/src/index.css|animation:guanxi-sheen 1.4s ease-in-out infinite',
    'G6|packages/web/src/index.css|animation:guanxi-spin 0.7s linear infinite',
    'G6|packages/web/src/index.css|border-radius:3px',
    'G6|packages/web/src/index.css|font-size:13px',
    'G6|packages/web/src/index.css|line-height:1.5',
    'G6|packages/web/src/index.css|transform:translateY(4px)',
    'G6|packages/web/src/index.css|transition-duration:0.01ms',
    'G7|packages/web/src/index.css|animation-duration:0.01ms',
    'G7|packages/web/src/index.css|animation:guanxi-caret 1.05s step-end infinite',
    'G7|packages/web/src/index.css|animation:guanxi-fade-up 0.16s ease-out',
    'G7|packages/web/src/index.css|animation:guanxi-pulse-soft 1.6s ease-in-out infinite',
    'G7|packages/web/src/index.css|animation:guanxi-sheen 1.4s ease-in-out infinite',
    'G7|packages/web/src/index.css|animation:guanxi-spin 0.7s linear infinite',
    'G7|packages/web/src/index.css|transition-duration:0.01ms',
  ]
  for (const key of retired) assert.equal(Object.hasOwn(allowance, key), false, key)
  for (const key of Object.keys(allowance)) assert.doesNotMatch(key, /animation:/, `held animation allowance: ${key}`)
  assert.equal(allowance['G6|packages/web/src/index.css|outline-offset:2px'], 4)
  assert.ok(Object.values(allowance).every(count => Number.isInteger(count) && count > 0))
})

test('reduced motion removes animation and transition for explicit and OS settings', () => {
  const explicitRules = []
  css.walkRules(rule => {
    if (rule.selectors.some(selector => selector.includes('[data-motion="reduced"]'))) explicitRules.push(rule)
  })
  assert.equal(explicitRules.length, 1, 'expected exactly one explicit reduced-motion rule')
  const explicit = explicitRules[0]
  assert.equal(explicit.parent.type, 'root', 'explicit reduced motion must not be media-gated')
  assert.deepEqual(explicit.selectors.map(selector => selector.replace(/\s+/g, ' ').trim()).sort(), [
    ':root[data-motion="reduced"]',
    ':root[data-motion="reduced"] *',
    ':root[data-motion="reduced"] *::after',
    ':root[data-motion="reduced"] *::before',
    ':root[data-motion="reduced"]::after',
    ':root[data-motion="reduced"]::before',
  ])
  assertMotionRemoved(explicit)

  const media = oneAtRule('media', /prefers-reduced-motion:\s*reduce/)
  const rules = media.nodes.filter(node => node.type === 'rule')
  assert.equal(rules.length, 1)
  const os = rules[0]
  const fullOverride = ':root:not([data-motion="full"])'
  const selectors = os.selectors.map(selector => selector.replace(/\s+/g, ' ').trim()).sort()
  assert.deepEqual(selectors, [
    fullOverride,
    `${fullOverride} *`,
    `${fullOverride} *::after`,
    `${fullOverride} *::before`,
    `${fullOverride}::after`,
    `${fullOverride}::before`,
  ])
  // Every OS selector must carry the full-override predicate; a bare universal selector
  // would also disable motion for the explicit full setting.
  for (const selector of selectors) {
    assert.ok(selector.startsWith(fullOverride), `${selector} must carry the full-override predicate`)
    assert.doesNotMatch(selector, /^(?:\*|:root\[data-motion="full"\])/)
  }
  assert.doesNotMatch(os.selector, /:root\[data-motion="full"\]/)
  assertMotionRemoved(os)
})
