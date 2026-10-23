import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// P3: focus moved by script to a non-control (a heading after navigation, an announcement region)
// shows no ring unless the browser judges it keyboard-visible; a heading never shows one. Controls
// keep the global :focus-visible ring.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s*')
  return new RegExp(`${escaped}\\s*\\{[^}]*outline:\\s*none`, 'u')
}

describe('programmatic focus targets (P3)', () => {
  it('a script-focused tabindex=-1 target drops the ring unless it is keyboard-visible', () => {
    expect(css).toMatch(rule("[tabindex='-1']:focus:not(:focus-visible)"))
  })
  it('a heading focused by script never shows the control ring', () => {
    expect(css).toMatch(rule(":is(h1, h2, h3, h4, h5, h6)[tabindex='-1']:focus"))
  })
  it('controls keep the global focus-visible ring', () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*var\(--focus-ring-width\) solid var\(--color-ring-primary\)/u)
  })
})
