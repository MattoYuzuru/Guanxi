import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Visual pass (D-202): model facts are label/value lists (FactList), never values glued together
// with punctuation in JSX. These are the shapes the old separators took after the middle dots went.
const dir = resolve(process.cwd(), 'src/features/models')
const JOINS: Array<[string, RegExp]> = [
  ['JSX comma literal', /\{', '\}/u],
  ['trailing JSX comma', /,\{' '\}/u],
  ['comma-led template', /`, \$\{/u],
  ['comma inside a template between values', /\}, \$\{/u],
]

describe('models feature facts', () => {
  it('joins no facts with punctuation', () => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.flatMap((name) => {
      const text = readFileSync(join(dir, name), 'utf8')
      return JOINS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => `${name}: ${kind}`)
    })
    expect(offenders).toEqual([])
  })
})

it('stacked fact lists share one value column: the label column has a token minimum (visual pass 5)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/features/models/models.css'), 'utf8')
  const rule = /^\.model-facts\s*\{([^}]*)\}/mu.exec(css)?.[1] ?? ''
  expect(rule).toMatch(/grid-template-columns:\s*minmax\(var\(--layout-fact-label\), max-content\) minmax\(0, 1fr\)/u)
})
