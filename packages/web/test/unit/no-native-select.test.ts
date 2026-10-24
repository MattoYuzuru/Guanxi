import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// D-206: every control is custom. A native <select> or <datalist> draws the operating system's
// popup, ignores the tokens and themes, and cannot carry the pixel assertions of the design
// system, so product code reaches choices only through the design-system Select or Menu.
const root = resolve(process.cwd(), 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/u.test(name) ? [path] : []
  })
}

describe('native choice controls (D-206)', () => {
  it('no web source renders a native <select> or <datalist>', () => {
    const files = sources(root)
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return [...text.matchAll(/<(select|datalist|optgroup)\b/gu)].map(
        (match) => `${relative(root, path)}:${text.slice(0, match.index).split('\n').length} <${match[1]}>`,
      )
    })
    expect(offenders).toEqual([])
  })
})
