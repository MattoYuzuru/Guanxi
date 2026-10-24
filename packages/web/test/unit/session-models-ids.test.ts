import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

// P3: views that can mount more than once take element ids from useId, never from string literals.
// Covers the native session, side chat and Models features (the round-3 R3-B scope).
const roots = ['src/features/native-agent', 'src/features/side-chat', 'src/features/models'].map(dir => resolve(process.cwd(), dir))
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : name.endsWith('.tsx') ? [path] : []
})

it('native session, side chat and Models use no literal element ids or id references', () => {
  const offenders = roots.flatMap(root => files(root).flatMap(path =>
    [...readFileSync(path, 'utf8').matchAll(/\b(id|htmlFor|aria-(?:describedby|labelledby|controls|owns|activedescendant))="[^"]+"/gu)]
      .map(match => `${relative(process.cwd(), path)}: ${match[0]}`)))
  expect(offenders).toEqual([])
})
