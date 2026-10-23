import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localeCatalogs } from '../../src/lib/locale.ts'

// D-202: no decorative middle dots between phrases anywhere in the product UI. Source files
// (components, locale catalogues, the design system's messages) and the merged runtime catalogues are checked, so a
// separator cannot come back through a feature's messages file or a hard-coded JSX string.
const roots = [resolve(process.cwd(), 'src'), resolve(process.cwd(), '../ui/src')]
// The pseudo locale pads strings with dots to find truncation; it is a development tool.
const allowed = new Set(['i18n/pseudo.ts'])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(tsx?|css|html)$/u.test(name) ? [path] : []
  })
}

describe('decorative separators (D-202)', () => {
  it('no product source file contains a middle dot', () => {
    const offenders = roots.flatMap((root) =>
      sources(root)
        .filter((path) => !allowed.has(relative(root, path)))
        .filter((path) => readFileSync(path, 'utf8').includes('·'))
        .map((path) => relative(resolve(process.cwd(), '..'), path)),
    )
    expect(offenders).toEqual([])
  })

  it('no locale message in either language contains a middle dot', () => {
    const catalogues = [localeCatalogs.en, localeCatalogs.ru]
    const offenders = catalogues.flatMap((catalogue) =>
      Object.entries(catalogue).filter(([, text]) => String(text).includes('·')).map(([key]) => key),
    )
    expect(catalogues.every((catalogue) => Object.keys(catalogue).length > 100)).toBe(true)
    expect(offenders).toEqual([])
  })
})
