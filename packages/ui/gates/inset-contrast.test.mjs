import { test } from 'node:test'
import assert from 'node:assert/strict'
import Color from 'colorjs.io'
import { insetMutedFindings } from '../../../scripts/codemods/inset-contrast.mjs'
import { createContext } from './context.mjs'
import { resolveTokens, resolvedFlat } from '../tokens/resolve.mjs'

test('H1 web source has no static text-muted on bg-inset', async () => {
  const ctx = await createContext(), hits = []
  for (const file of ctx.files.filter(f => f.startsWith('packages/web/src/') && f.endsWith('.tsx'))) {
    for (const hit of insetMutedFindings(file, await ctx.read(file))) hits.push(`${file}:${hit.line}`)
  }
  assert.deepEqual(hits, [], 'muted inset sites must use a passing foreground')
})
test('H1 secondary text on inset passes AA in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    const flat = Object.fromEntries(resolvedFlat((await resolveTokens({ theme })).tokens).map(t => [t.name, t.$value]))
    const ratio = new Color(flat['color.text.secondary'].hex).contrast(new Color(flat['color.background.tertiary'].hex), 'WCAG21')
    assert.ok(ratio >= 4.5, `${theme}: ${ratio} must be >= 4.5`)
  }
})
