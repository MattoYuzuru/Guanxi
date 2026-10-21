import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// The inventory is an executable repository guard; keeping it in plain ESM also
// lets maintainers run it without adding a browser build dependency.
// @ts-expect-error plain ESM script intentionally has no declaration package
import {
  collectDynamicCopyViolations,
  collectLocalizedCopyViolations,
  scanLocalizedWebCopy,
} from '../../scripts/localized-copy-inventory.mjs'

describe('localized Web copy inventory', () => {
  it('rejects direct and nested injected user-facing JSX copy', () => {
    const violations = collectLocalizedCopyViolations(`
      export function Fixture() {
        const copy = 'Visible identifier copy'
        const accessible = 'Identifier accessible name'
        const choice = 'Identifier visible choice'
        return <section title="Visible title">
          Visible text
          <button aria-label={accessible}>{copy}</button>
          <button aria-label="Accessible name" />
          <input placeholder="Search here" />
          <Select options={[{ value: 'technical-id', label: 'Hardcoded visible choice' }]} />
          <Select options={[{ value: 'second-id', label: choice }]} />
          <Widget config={{ title: 'Hardcoded visible title' }} />
        </section>
      }
    `)
    expect(violations.map((item: { kind: string }) => item.kind).sort()).toEqual([
      'attribute:aria-label',
      'attribute:aria-label',
      'attribute:placeholder',
      'attribute:title',
      'jsx-expression',
      'jsx-text',
      'property:label',
      'property:label',
      'property:title',
    ])
  })

  it('rejects hardcoded strings returned by non-TSX display formatters', () => {
    const violations = collectDynamicCopyViolations(`
      export function formatDuration() {
        const copy = 'Hardcoded duration label'
        return true ? copy : 'сек'
      }
      export const formatArrow = () => 'Hardcoded arrow label'
    `)
    expect(violations.map((item: { value: string }) => item.value).sort()).toEqual([
      'Hardcoded arrow label',
      'Hardcoded duration label',
      'сек',
    ])
  })

  it('rejects user-facing copy imported from a TS constant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guanxi-localized-copy-'))
    try {
      await writeFile(join(directory, 'copy.ts'), "export const helperCopy = 'Imported visible copy'\n")
      await writeFile(join(directory, 'Fixture.tsx'), `
        import { helperCopy } from './copy.ts'
        export function Fixture() { return <button>{helperCopy}</button> }
      `)
      expect(scanLocalizedWebCopy(directory)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'jsx-expression', value: 'Imported visible copy' }),
      ]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('follows aliased named and wildcard re-exports without allowing untranslated copy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guanxi-localized-copy-'))
    try {
      await writeFile(join(directory, 'copy.ts'), "export const helperCopy = 'Forwarded visible copy'\n")
      await writeFile(join(directory, 'named.ts'), "export { helperCopy as renamedCopy } from './copy.ts'\n")
      await writeFile(join(directory, 'bridge.ts'), "export * from './named.ts'\n")
      await writeFile(join(directory, 'Fixture.tsx'), `
        import { renamedCopy } from './bridge.ts'
        export function Fixture() { return <button>{renamedCopy}</button> }
      `)
      expect(scanLocalizedWebCopy(directory)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'jsx-expression', value: 'Forwarded visible copy' }),
      ]))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps current user-facing TSX copy behind locale keys', () => {
    const sourceDirectory = resolve(import.meta.dirname, '../../src')
    expect(scanLocalizedWebCopy(sourceDirectory)).toEqual([])
  })
})
