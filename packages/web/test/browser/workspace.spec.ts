import { expect, test, type Page } from '@playwright/test'
import { builtInLayout } from '../../src/features/workspace/defaults.ts'
import type { LayoutDocument } from '@guanxi/contract'
import { installChatApiFixture, chatFixtureThreadId } from './fixtures/chat-api.ts'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'

async function setup(page: Page, initial?: LayoutDocument, fail = false, extra: { documents?: LayoutDocument[]; geometry?: Record<string, unknown>; winner?: LayoutDocument } = {}) {
  await installChatApiFixture(page, 'completed')
  await page.addInitScript(({ initial, fail, prefix, extra }) => {
    localStorage.setItem(`${prefix}.layout-device`, 'device-a')
    localStorage.setItem(`${prefix}.theme`, 'system')
    const base = window.fetch.bind(window)
    const documents: any[] = [...(initial ? [initial] : []), ...(extra.documents ?? [])]
    const active: any[] = []
    for (const doc of documents) if (!active.some(row => JSON.stringify(row.scope) === JSON.stringify(doc.scope))) active.push({ scope: doc.scope, layoutId: doc.id })
    const geometry = new Map<string, any>(Object.entries(extra.geometry ?? {}))
    ;(window as any).__LAYOUT_WRITES__ = []
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/api/layouts') {
        if (fail) return Response.json({ code: 'unavailable' }, { status: 503 })
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)); (window as any).__LAYOUT_WRITES__.push(body)
          if ((window as any).__HOLD_LAYOUT_SAVE__) await new Promise<void>(resolve => { (window as any).__RELEASE_LAYOUT_SAVE__ = () => { (window as any).__HOLD_LAYOUT_SAVE__ = false; resolve() } })
          if (extra.winner && (window as any).__LAYOUT_WRITES__.length === 1) return Response.json({ document: extra.winner, recovered: [{ ...body.document, id: 'recovered/fixture', name: 'Recovered layout' }] })
          const index = documents.findIndex(doc => doc.id === body.document.id && doc.scope.mode === body.document.scope.mode)
          if (index >= 0) documents.splice(index, 1)
          documents.push(body.document)
          const old = active.findIndex(row => row.scope.mode === body.document.scope.mode)
          if (old >= 0) active.splice(old, 1)
          active.push({ scope: body.document.scope, layoutId: body.document.id })
          return Response.json({ document: body.document, recovered: [] })
        }
        const mode = url.searchParams.get('mode')
        return Response.json({ documents: documents.filter(doc => doc.scope.mode === mode), active: active.filter(row => row.scope.mode === mode) })
      }
      if (url.pathname === '/api/layouts/geometry') {
        if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); geometry.set(body.layoutId, body.geometry); return Response.json({ geometry: body.geometry }) }
        return Response.json({ geometry: geometry.get(url.searchParams.get('layoutId') ?? '') ?? {} })
      }
      const response = await base(input, init)
      if (url.pathname === '/api/settings') return Response.json({ ...await response.json(), locale: 'en' })
      return response
    }
  }, { initial, fail, prefix: PRODUCT_FILE_PREFIX, extra })
}
async function open(page: Page, initial?: LayoutDocument) {
  await setup(page, initial)
  await page.goto('/workspace')
  await expect(page.locator('.workspace')).toBeVisible()
  await expect(page.locator('.dv-tab')).toHaveCount(Object.keys(initial?.blocks ?? builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' }).blocks).length)
}
async function pick(page: Page, label: string, value: string, keyboard = false) {
  if (keyboard) {
    await page.getByRole('button', { name: label, exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: value, exact: true }).focus()
    await page.keyboard.press('Enter')
    return
  }
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menuitem', { name: value, exact: true }).click()
}
async function move(page: Page, block: string, zone: string, keyboard = false) {
  if (keyboard) await page.keyboard.press('Alt+Shift+m')
  else await page.getByRole('button', { name: 'Move block to…', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true })).toBeVisible()
  await pick(page, 'Block', block, keyboard)
  await pick(page, 'Destination', zone, keyboard)
  await page.getByRole('dialog', { name: 'Move block', exact: true }).getByRole('button', { name: 'Move block to…', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true })).toHaveCount(0)
}
async function state(page: Page) { return page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.snapshot() as LayoutDocument) }

test('locked free-API zones; keyboard movement is announced; F6 and Shift+F6 cycle zones', async ({ page }) => {
  await open(page)
  await move(page, 'Terminal', 'Right', true)
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Terminal moved to Right.')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-block'))).toBe('guanxi.core/terminal')
  let snapshot = await state(page)
  expect(snapshot.engineState.groups.filter(group => group.zone === 'right').flatMap(group => group.blocks).filter(id => id === 'guanxi.core/terminal')).toHaveLength(1)
  await move(page, 'Terminal', 'Left')
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Terminal moved to Left.')
  await move(page, 'Terminal', 'Top')
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Terminal moved to Top.')
  await move(page, 'Terminal', 'Bottom')
  const diagnostics = await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.diagnostics())
  for (const zone of ['left', 'right', 'bottom']) expect(diagnostics.groups.filter((g: any) => g.zone === zone && g.locked)).toHaveLength(1)
  const expectedRight = (await state(page)).engineState.groups.find(group => group.zone === 'right')!.active
  await page.locator('.dv-tab').filter({ hasText: /^Chat$/ }).click()
  await page.keyboard.press('F6')
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-block'))).toBe(expectedRight)
  await page.keyboard.press('Shift+F6')
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-block'))).toBe('guanxi.core/chat')
})

test('Terminal and Browser retain input and the same DOM node across move, float and same-origin popout', async ({ page, context }) => {
  await open(page)
  for (const [name, label] of [['Terminal', 'Terminal input draft'], ['Browser', 'Browser address draft']]) {
    await page.locator('.dv-tab').filter({ hasText: new RegExp(`^${name}$`) }).click()
    const input = page.getByLabel(label!, { exact: true })
    await input.fill(`retained-${name}`)
    await input.evaluate(node => { (node as any).__retainedIdentity = 'original' })
    await move(page, name!, 'Right')
    await expect(input).toHaveValue(`retained-${name}`)
    await move(page, name!, 'Floating')
    await expect(input).toHaveValue(`retained-${name}`)
    const popupEvent = context.waitForEvent('page')
    await move(page, name!, 'Popout')
    const popup = await popupEvent
    await popup.waitForLoadState('domcontentloaded')
    expect(new URL(popup.url()).origin).toBe(new URL(page.url()).origin)
    expect(new URL(popup.url()).pathname).toBe('/workspace-popout.html')
    const detached = popup.getByLabel(label!, { exact: true })
    await expect(detached).toHaveValue(`retained-${name}`)
    expect(await detached.evaluate(node => (node as any).__retainedIdentity)).toBe('original')
    await detached.fill(`returned-${name}`)
    // Keyboard entry point in the popout opens its move dialog in the same document.
    await popup.keyboard.press('Alt+Shift+m')
    await expect(popup.getByRole('dialog', { name: 'Move block', exact: true })).toBeVisible()
    await pick(popup, 'Destination', 'Bottom')
    await popup.getByRole('dialog', { name: 'Move block', exact: true }).getByRole('button', { name: 'Move block to…', exact: true }).click()
    await expect(page.getByLabel(label!, { exact: true })).toHaveValue(`returned-${name}`)
    expect(await page.getByLabel(label!, { exact: true }).evaluate(node => (node as any).__retainedIdentity)).toBe('original')
  }
})

test('modes retain separate arrangements; both themes/densities leave geometry unchanged; reduced drag motion', async ({ page }) => {
  await open(page)
  await move(page, 'Terminal', 'Top')
  const developer = await state(page)
  await pick(page, 'Experience mode', 'Visual')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'visual')
  const visual = await state(page)
  expect(visual.scope.mode).toBe('visual')
  expect(visual.engineState.groups.find(g => g.zone === 'right')!.blocks).toEqual(['guanxi.core/plan', 'guanxi.core/subagents'])
  await pick(page, 'Experience mode', 'Developer')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'developer')
  expect((await state(page)).engineState).toEqual(developer.engineState)
  await move(page, 'Terminal', 'Bottom')
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Terminal moved to Bottom.')
  const before = (await state(page)).engineState
  const themeColors: string[] = []
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect(page.locator('.workspace')).toHaveAttribute('data-theme', theme)
    const color = await page.locator('.gx-workspace-pane:visible').first().evaluate(node => getComputedStyle(node).backgroundColor)
    expect(color).not.toBe('rgba(0, 0, 0, 0)')
    themeColors.push(color)
    for (const density of ['Compact', 'Comfortable']) {
      await pick(page, 'Density', density)
      await expect(page.locator('.workspace')).toHaveAttribute('data-density', density.toLowerCase())
      expect((await state(page)).engineState).toEqual(before)
      await page.screenshot({ path: test.info().outputPath(`workspace-${theme}-${density.toLowerCase()}.png`) })
      expect(await page.locator('.workspace').evaluate(node => getComputedStyle(node).getPropertyValue('--font-text-size').trim())).toBe(density === 'Compact' ? '13px' : '14px')
    }
  }
  expect(themeColors[0]).not.toBe(themeColors[1])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.locator('.dv-tab').first().evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s')
  expect(await page.locator('.workspace').evaluate(node => node.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0)
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Layout saved to the node.')
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__.length)).toBe(1)
})

test('390px phone has a priority-ordered stacked tab list, keyboard navigation and no docking', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/workspace')
  await expect(page.getByRole('tablist', { name: 'Workspace blocks' })).toBeVisible()
  await expect(page.locator('.dv-dockview')).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(11)
  expect(await page.getByRole('tab').allTextContents()).toEqual(['Chat', 'Context', 'Changes', 'Plan', 'Processes', 'Environment', 'Files', 'Terminal', 'Artifacts', 'Browser', 'Sub-agents'])
  await page.getByRole('tab', { name: 'Chat', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('tab', { name: 'Context', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Context', exact: true })).toBeVisible()
  await page.locator('[data-block="guanxi.core/context"]').getByRole('button', { name: 'Move block to… Context', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Move block to…', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('30 blocks restore within 2000ms; unknown/unloaded and safe-mode blocks are placeholders', async ({ page }) => {
  const doc = builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' })
  for (let i = 11; i < 30; i++) {
    const id = `plugin.view/pane-${i}`
    doc.blocks[id] = { contribution: id, pluginVersion: '1.0.0', priority: i, params: {} }
    doc.engineState.groups[0]!.blocks.push(id)
  }
  await open(page, doc)
  await expect.poll(() => page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.restoreMs())).toBeGreaterThan(0)
  const restoreMs = await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.restoreMs())
  console.log(`U1-a 30-block restore: ${restoreMs.toFixed(1)} ms (budget 2000 ms, engine ready through two animation frames)` )
  expect(restoreMs).toBeLessThan(2000)
  expect(Object.keys((await state(page)).blocks)).toHaveLength(30)
  await expect(page.getByText('This block is unavailable. Enable its plugin to restore it.', { exact: true })).toHaveCount(19)
  await page.evaluate(async () => { await (window as any).__GUANXI_KERNEL__.unload('guanxi.core') })
  await expect(page.getByText('This block is unavailable. Enable its plugin to restore it.', { exact: true })).toHaveCount(30)
  expect(Object.keys((await state(page)).blocks)).toHaveLength(30)
  await page.goto('/workspace?safe=1')
  await expect(page.getByText('Plugin blocks are disabled in safe mode.', { exact: true })).toHaveCount(19)
})

test('node unavailable state is truthful and retry remains reachable', async ({ page }) => {
  await setup(page, undefined, true)
  await page.goto('/workspace')
  await expect(page.getByRole('alert').filter({ hasText: 'Layouts could not be loaded' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(page.locator('.dv-dockview')).toHaveCount(0)
})


test('a different-block LWW winner is applied to the engine and can be saved again', async ({ page }) => {
  const winner = builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' })
  winner.rev = 900
  winner.updatedBy = { device: 'device-z' }
  winner.blocks = { 'winner/context': { contribution: 'guanxi.core/context', pluginVersion: '0.1.0', priority: 1, params: {} } }
  winner.engineState.groups = [{ id: 'winner-group', zone: 'right', blocks: ['winner/context'], active: 'winner/context' }]
  await setup(page, undefined, false, { winner })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await page.evaluate(() => { (window as any).__HOLD_LAYOUT_SAVE__ = true })
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.locator('.workspace-content')).toHaveAttribute('inert', '')
  await page.keyboard.press('Alt+Shift+m')
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as any).__RELEASE_LAYOUT_SAVE__())
  await expect(page.locator('.dv-tab')).toHaveCount(1)
  expect(Object.keys((await state(page)).blocks)).toEqual(['winner/context'])
  expect((await state(page)).engineState.groups.flatMap(group => group.blocks)).toEqual(['winner/context'])
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Layout saved to the node.')
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__.length)).toBe(2)
})

test('named/mode selections restore scoped float geometry and a future engine falls back', async ({ page }) => {
  const query = { account: 'local', device: 'device-a', mode: 'developer' as const, deviceClass: 'desktop' as const }
  const developer = builtInLayout(query)
  const floated = (doc: LayoutDocument, id: string, name: string) => {
    doc.id = id; doc.name = name
    doc.engineState.groups = doc.engineState.groups.map(group => ({ ...group, blocks: group.blocks.filter(block => block !== 'guanxi.core/terminal'), active: group.active === 'guanxi.core/terminal' ? undefined : group.active })).filter(group => group.blocks.length)
    doc.engineState.groups.push({ id: 'saved-float', zone: 'floating', blocks: ['guanxi.core/terminal'], active: 'guanxi.core/terminal' })
    return doc
  }
  const named = floated(builtInLayout(query), 'named-developer', 'Named geometry')
  const visual = floated(builtInLayout({ ...query, mode: 'visual' }), 'named-visual', 'Visual geometry')
  const future = builtInLayout(query); future.id = 'future'; future.name = 'Future engine'; future.engineState.major++
  const box = { left: 35, top: 45, width: 420, height: 260 }
  await setup(page, developer, false, { documents: [named, visual, future], geometry: { [named.id]: { 'saved-float': box }, [visual.id]: { 'saved-float': { ...box, width: 460 } } } })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await pick(page, 'Named layout', 'Named geometry')
  await expect(page.locator('.dv-resize-container:visible')).toHaveCount(1)
  await expect.poll(() => page.locator('.dv-resize-container:visible').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(420)
  await pick(page, 'Experience mode', 'Visual')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'visual')
  await expect.poll(() => page.locator('.dv-resize-container:visible').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(460)
  await pick(page, 'Experience mode', 'Developer')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'developer')
  await expect.poll(() => page.locator('.dv-resize-container:visible').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(420)
  await pick(page, 'Named layout', 'Future engine')
  await expect(page.locator('.dv-resize-container:visible')).toHaveCount(0)
  expect((await state(page)).engineState.major).toBe(8)
  expect((await state(page)).id).toBe('default-developer')
})

test('move cancellation and hiding return focus; existing tabs update with locale', async ({ page }) => {
  await open(page)
  const draft = page.getByLabel('Terminal input draft', { exact: true })
  await draft.focus()
  await page.keyboard.press('Alt+Shift+m')
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(draft).toBeFocused()
  await page.locator('[data-block="guanxi.core/terminal"]').getByRole('button', { name: 'Move block to… Terminal', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Hide block', exact: true }).click()
  await expect(page.locator('.dv-tab')).toHaveCount(10)
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-block'))).not.toBe(null)
  await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.setLocale('ru'))
  await expect(page.locator('.dv-tab').filter({ hasText: /^Контекст$/ })).toHaveCount(1)
  await expect(page.locator('.dv-tab').filter({ hasText: /^Context$/ })).toHaveCount(0)
})

test('a real reduced-motion drag preview has no spatial transition', async ({ page }) => {
  await open(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const source = await page.locator('.dv-tab').filter({ hasText: /^Terminal$/ }).boundingBox()
  const target = await page.locator('[data-block="guanxi.core/chat"]').boundingBox()
  expect(source).not.toBeNull(); expect(target).not.toBeNull()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await page.mouse.down()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height + 12, { steps: 5 })
  await page.mouse.move(target!.x + target!.width - 8, target!.y + target!.height / 2, { steps: 10 })
  const preview = page.locator('.dv-drop-target-anchor:visible').first()
  await expect(preview).toBeVisible()
  expect(await preview.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) === 0))).toBe(true)
  expect(await preview.evaluate(node => node.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0)
  await page.mouse.up()
  await expect.poll(async () => (await state(page)).engineState.groups.filter(group => group.zone === 'center').length).toBe(2)
  await pick(page, 'Experience mode', 'Visual')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'visual')
  await pick(page, 'Experience mode', 'Developer')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'developer')
  expect((await state(page)).engineState.groups.filter(group => group.zone === 'center')).toHaveLength(2)
})

test('a restored popout reopens with device-local geometry on its same-origin page', async ({ page, context }) => {
  const doc = builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' })
  doc.engineState.groups = doc.engineState.groups.map(group => ({ ...group, blocks: group.blocks.filter(id => id !== 'guanxi.core/browser') }))
  doc.engineState.groups.push({ id: 'saved-popout', zone: 'popout', blocks: ['guanxi.core/browser'], active: 'guanxi.core/browser' })
  await setup(page, doc, false, { geometry: { [doc.id]: { 'saved-popout': { left: 50, top: 60, width: 600, height: 400 } } } })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  const event = context.waitForEvent('page')
  await move(page, 'Browser', 'Popout')
  const popup = await event
  await popup.waitForLoadState('domcontentloaded')
  expect(await popup.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 600, height: 400 })
  await popup.close()
  await expect(page.getByLabel('Browser address draft', { exact: true })).toBeAttached()
})

test('loaded plugin panes become exact placeholders on unload and are ignored in safe mode', async ({ page }) => {
  const doc = builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' })
  doc.blocks['plugin-instance'] = { contribution: 'test.workspace/pane', pluginVersion: '0.1.0', priority: 12, params: {} }
  doc.engineState.groups[0]!.blocks.push('plugin-instance')
  await open(page, doc)
  await page.evaluate(async () => { const fixture = await import('/test/browser/fixtures/workspace-plugin.tsx'); await fixture.load() })
  await expect(page.getByText('Plugin pane fixture', { exact: true })).toHaveCount(1)
  await page.evaluate(async () => { await (window as any).__GUANXI_KERNEL__.unload('test.workspace') })
  await expect(page.getByText('Plugin pane fixture', { exact: true })).toHaveCount(0)
  await expect(page.getByText('This block is unavailable. Enable its plugin to restore it.', { exact: true })).toHaveCount(1)
  expect(Object.keys((await state(page)).blocks)).toHaveLength(12)
  await page.goto('/workspace?safe=1')
  await expect(page.locator('.workspace')).toBeVisible()
  await page.evaluate(async () => { const fixture = await import('/test/browser/fixtures/workspace-plugin.tsx'); await fixture.load() })
  await expect(page.getByText('Plugin pane fixture', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Plugin blocks are disabled in safe mode.', { exact: true })).toHaveCount(1)
})


test('the existing session chat remains the centre block with dock lanes immediately above its composer', async ({ page }) => {
  await setup(page)
  await page.goto(`/workspace/${chatFixtureThreadId('completed')}`)
  const chat = page.locator('[data-block="guanxi.core/chat"]')
  await expect(chat).toBeVisible()
  const lanes = chat.getByRole('complementary', { name: 'Session dock lanes', exact: true })
  await expect(lanes).toHaveCount(1)
  await expect(lanes).toHaveText('No goal, work ledger, prompt queue or steering is attached to this chat.')
  expect(await lanes.evaluate(node => Boolean(node.nextElementSibling?.querySelector('textarea')))).toBe(true)
})
