import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { rewrite, themeAliases, legacyRoles } from './semantic-colours.mjs'

const theme = await readFile(new URL('../../packages/ui/generated/theme.css', import.meta.url), 'utf8')
test('semantic codemod rewrites generated roles, variants, opacity, important and template branches', () => {
  const source = 'const x = <div className={`bg-[var(--bg)] hover:text-[var(--fg-muted)]/80 !border-[var(--border)] ${yes ? "ring-[var(--focus)]!" : "bg-[var(--color-background-secondary)]"}`} />'
  const result = rewrite('fixture.tsx', source, theme)
  assert.equal(result.output, 'const x = <div className={`bg-canvas hover:text-secondary/80 !border-divider ${yes ? "ring-focus!" : "bg-surface"}`} />')
  assert.equal(result.replacements.length, 5)
  assert.deepEqual(result.unresolved, [])
})
test('semantic codemod reports missing equivalents and never rewrites fallbacks or compound values', () => {
  const source = 'const x = "bg-[var(--accent-subtle)] text-[var(--color-fit-red)] bg-[var(--bg,var(--fg))] bg-[var(--bg)_var(--fg)] bg-[var(--bg)]suffix xbg-[var(--bg)]"'
  const result = rewrite('fixture.ts', source, theme)
  assert.equal(result.output, source)
  assert.deepEqual(result.unresolved.map(f => f.class), ['bg-[var(--accent-subtle)]', 'text-[var(--color-fit-red)]'])
})
test('semantic codemod is deterministic and idempotent and preserves comments and escaped strings', () => {
  const source = '// bg-[var(--bg)]\nconst c = "bg-[var(--bg)] text-[var(--fg)] \\"quoted\\""'
  const one = rewrite('fixture.ts', source, theme)
  assert.deepEqual(one, rewrite('fixture.ts', source, theme))
  assert.match(one.output, /^\/\/ bg-\[var\(--bg\)\]/)
  assert.equal(rewrite('fixture.ts', one.output, theme).replacements.length, 0)
  assert.equal(rewrite('fixture.ts', one.output, theme).output, one.output)
})
test('semantic codemod derives aliases from generated output, with no hardcoded utility fallback', () => {
  assert.equal(themeAliases(theme).get('--color-text-primary'), 'foreground')
  for (const [prefix, entries] of Object.entries(legacyRoles)) for (const [legacy, semantic] of Object.entries(entries)) {
    const source = `const x = '${prefix}-[var(${legacy})]'`
    const alias = themeAliases(theme).get(semantic)
    assert.ok(alias, `${prefix} ${semantic}`)
    assert.equal(rewrite('fixture.ts', source, theme).output, `const x = '${prefix}-${alias}'`)
    assert.equal(rewrite('fixture.ts', source, '').output, source)
  }
})
