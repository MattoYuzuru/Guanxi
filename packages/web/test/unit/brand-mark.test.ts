import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The inline mark must stay byte-for-byte the brand asset's geometry (BRAND: never redraw the logo). */
describe('BrandMark', () => {
  const pathData = (source: string) => [...source.matchAll(/ d="([^"]+)"/gu)].map(match => match[1])
  it('carries exactly the path data of packages/ui/brand/logo-mono.svg', () => {
    const asset = readFileSync(resolve(import.meta.dirname, '../../../ui/brand/logo-mono.svg'), 'utf8')
    const component = readFileSync(resolve(import.meta.dirname, '../../src/features/new-session/BrandMark.tsx'), 'utf8')
    expect(pathData(asset)).toHaveLength(2)
    expect(pathData(component)).toEqual(pathData(asset))
    expect(component).toContain('translate(48 100) scale(2.06)')
    expect(component).toContain('fill="currentColor"')
  })
})
