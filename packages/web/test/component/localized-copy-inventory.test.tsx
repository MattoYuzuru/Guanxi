import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// The inventory is an executable repository guard; keeping it in plain ESM also
// lets maintainers run it without adding a browser build dependency.
// @ts-expect-error plain ESM script intentionally has no declaration package
import {
  collectLocalizedCopyViolations,
  scanLocalizedWebCopy,
} from '../../scripts/localized-copy-inventory.mjs'

describe('localized Web copy inventory', () => {
  it('rejects injected JSX text, aria-label, title, and placeholder copy', () => {
    const violations = collectLocalizedCopyViolations(`
      export function Fixture() {
        return <section title="Visible title">
          Visible text
          <button aria-label="Accessible name" />
          <input placeholder="Search here" />
        </section>
      }
    `)
    expect(violations.map((item: { kind: string }) => item.kind).sort()).toEqual([
      'attribute:aria-label',
      'attribute:placeholder',
      'attribute:title',
      'jsx-text',
    ])
  })

  it('keeps current user-facing TSX copy behind locale keys', () => {
    const sourceDirectory = resolve(import.meta.dirname, '../../src')
    expect(scanLocalizedWebCopy(sourceDirectory)).toEqual([])
  })
})
