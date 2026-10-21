import { expect, test, type Page } from '@playwright/test'
import { builtInLayout } from '../../../src/features/workspace/defaults.ts'
import type { LayoutDocument } from '@guanxi/contract'
import { installChatApiFixture } from './fixtures/chat-api.ts'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'

async function setup(page: Page, initial?: LayoutDocument, fail = false) {
  await installChatApiFixture(page, 'completed')
  await page.addInitScript(({ initial, fail, prefix }) => {
    localStorage.setItem(`${prefix}.layout-device`, 'device-a')
    const base = window.fetch.bind(window)
    const documents: any[] = initial ? [initial] : []
    const active: any[] = initial ? [{ scope: initial.scope, layoutId: initial.id }] : []
    const geometry = new Map<string, any>()
    ;(window as any).__LAYOUT_WRITES__ = []
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/api/layouts') {
        if (fail) return Response.json({ code: 'unavailable' }, { status: 503 })
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)); (window as any).__LAYOUT_WRITES__.push(body)
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
  }, { initial, fail, prefix: PRODUCT_FILE_PREFIX })
}
async function open(page: Page, initial?: LayoutDocument) {
  await setup(page, initial)
  await page.goto('/workspace')
  await expect(page.locator('.workspace')).toBeVisible()
  await expect(page.locator('.dv-tab')).toHaveCount(Object.keys(initial?.blocks ?? builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' }).blocks).length)
}
async function pick(page: Page, label: string, value: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menuitem', { name: value, exact: true }).click()
}
async function move(page: Page, block: string, zone: string, keyboard = false) {
  if (keyboard) await page.keyboard.press('Alt+Shift+m')
  else await page.getByRole('button', { name: 'Move block to…', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await pick(page, 'Block', block)
  await pick(page, 'Destination', zone)
  await page.getByRole('dialog').getByRole('button', { name: 'Move block to…', exact: true }).focus()
  await page.keyboard.press('Enter')
}
async function state(page: Page) { return page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.snapshot() as LayoutDocument) }

test('locked free-API zones; keyboard movement is announced; F6 and Shift+F6 cycle zones', async ({ page }) => {
  await open(page)
  await move(page, 'Terminal', 'Right', true)
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Terminal moved to Right.')
  let snapshot = await state(page)
  expect(snapshot.engineState.groups.filter(group => group.zone === 'right').flatMap(group => group.blocks).filter(id => id === 'guanxi.core/terminal')).toHaveLength(1)
  await move(page, 'Terminal', 'Top')
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Terminal moved to Top.')
  await move(page, 'Terminal', 'Bottom')
  const diagnostics = await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.diagnostics())
  for (const zone of ['left', 'right', 'bottom']) expect(diagnostics.groups.filter((g: any) => g.zone === zone && g.locked)).toHaveLength(1)
  await page.locator('.dv-tab').filter({ hasText: /^Chat$/ }).click()
  await page.keyboard.press('F6')
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-block'))).toBe('guanxi.core/files')
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
    await expect(popup.getByRole('dialog')).toBeVisible()
    await pick(popup, 'Destination', 'Bottom')
    await popup.getByRole('dialog').getByRole('button', { name: 'Move block to…', exact: true }).click()
    await expect(page.getByLabel(label!, { exact: true })).toHaveValue(`returned-${name}`)
    expect(await page.getByLabel(label!, { exact: true }).evaluate(node => (node as any).__retainedIdentity)).toBe('original')
  }
})

test('modes retain separate arrangements; both themes/densities leave geometry unchanged; reduced drag motion', async ({ page }) => {
  await open(page)
  await move(page, 'Terminal', 'Top')
  const developer = await state(page)
  await pick(page, 'Experience mode', 'Visual')
  const visual = await state(page)
  expect(visual.scope.mode).toBe('visual')
  expect(visual.engineState.groups.find(g => g.zone === 'right')!.blocks).toEqual(['guanxi.core/plan', 'guanxi.core/subagents'])
  await pick(page, 'Experience mode', 'Developer')
  expect((await state(page)).engineState).toEqual(developer.engineState)
  const before = (await state(page)).engineState
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.querySelector('.workspace')?.setAttribute('data-theme', theme) }, theme)
    for (const density of ['Compact', 'Comfortable']) {
      await pick(page, 'Density', density)
      await expect(page.locator('.workspace')).toHaveAttribute('data-density', density.toLowerCase())
      expect((await state(page)).engineState).toEqual(before)
      expect(await page.locator('.workspace').evaluate(node => getComputedStyle(node).getPropertyValue('--font-text-size').trim())).toBe(density === 'Compact' ? '13px' : '14px')
    }
  }
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
  expect(await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.restoreMs())).toBeLessThan(2000)
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
