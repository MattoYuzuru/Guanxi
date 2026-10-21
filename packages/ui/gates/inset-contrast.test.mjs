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

test('self-review: soft accent labels and checkpoint cost text pass AA on all neutral surfaces', async () => {
  const ctx = await createContext()
  const ui = await ctx.read('packages/web/src/components/ui.tsx')
  const badge = ui.match(/accent:\s*'([^']+)'/)[1]
  assert.match(badge, /text-secondary/, 'soft accent badge must use secondary text')
  for (const file of ['packages/web/src/features/projects/ProjectsPage.tsx', 'packages/web/src/features/chat/ChatPage.tsx']) assert.ok((await ctx.read(file)).includes('hover:bg-accent/10 hover:text-secondary'), `${file}: soft hover needs a passing text role`)
  assert.ok((await ctx.read('packages/web/src/features/models/CatalogVariantInstall.tsx')).includes('bg-accent/10 text-secondary'))
  const panel = await ctx.read('packages/web/src/features/context/ContextPanel.tsx')
  assert.match(panel, /className="mt-1 text-2xs text-secondary">\s*\{translate\('chat.checkpoint.cacheCost'\)/, 'checkpoint estimate must retain AA text on the fit fill')
  const css = await ctx.read('packages/web/src/index.css')
  for (const theme of ['light', 'dark']) {
    const flat = Object.fromEntries(resolvedFlat((await resolveTokens({ theme })).tokens).map(t => [t.name, t.$value]))
    const legacy = css.slice(css.indexOf(theme === 'light' ? ':root {' : '.dark {'))
    const fit = legacy.match(/--color-fit-yellow:\s*([^;]+);/)[1]
    for (const surface of ['primary', 'secondary', 'tertiary']) for (const [fill, alpha] of [[flat['color.background.accent'].hex, .1], [fit, .08]]) {
      const base = new Color(flat[`color.background.${surface}`].hex).to('srgb')
      const paint = new Color(fill).to('srgb')
      const background = new Color('srgb', paint.coords.map((v, i) => v * alpha + base.coords[i] * (1 - alpha)))
      const ratio = new Color(flat['color.text.secondary'].hex).contrast(background, 'WCAG21')
      assert.ok(ratio >= 4.5, `${theme}/${surface}/${fill}: ${ratio} must be >= 4.5`)
    }
  }
})
