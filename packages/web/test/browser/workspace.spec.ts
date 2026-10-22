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
    const stored = JSON.parse(sessionStorage.getItem('layout-api-fixture') ?? 'null')
    const documents: any[] = stored?.documents ?? [...(initial ? [initial] : []), ...(extra.documents ?? [])]
    const scopeKey = (scope: any) => JSON.stringify([scope.account, scope.project ?? null, scope.mode, scope.deviceClass, scope.device ?? null])
    const active: any[] = stored?.active ?? []
    for (const doc of documents) if (!active.some(row => JSON.stringify(row.scope) === JSON.stringify(doc.scope))) active.push({ scope: doc.scope, layoutId: doc.id })
    const geometry = new Map<string, any>(Object.entries(extra.geometry ?? {}))
    ;(window as any).__LAYOUT_WRITES__ = []
    ;(window as any).__LAYOUT_READS__ = []
    ;(window as any).__GEOMETRY_WRITES__ = []
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/api/layouts/context') return fail
        ? Response.json({ code: 'unavailable' }, { status: 503 })
        : Response.json({ account: initial?.scope.account ?? 'local', replication: false })
      if (url.pathname === '/api/layouts') {
        if (fail) return Response.json({ code: 'unavailable' }, { status: 503 })
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)); (window as any).__LAYOUT_WRITES__.push(body)
          if ((window as any).__HOLD_LAYOUT_SAVE__) await new Promise<void>(resolve => { (window as any).__RELEASE_LAYOUT_SAVE__ = () => { (window as any).__HOLD_LAYOUT_SAVE__ = false; resolve() } })
          if (extra.winner && (window as any).__LAYOUT_WRITES__.length === 1) return Response.json({ document: extra.winner, recovered: [{ ...body.document, id: 'recovered/fixture', name: 'Recovered layout' }] })
          const index = documents.findIndex(doc => doc.id === body.document.id && scopeKey(doc.scope) === scopeKey(body.document.scope))
          if (index >= 0) documents.splice(index, 1)
          documents.push(body.document)
          const old = active.findIndex(row => scopeKey(row.scope) === scopeKey(body.document.scope))
          if (old >= 0) active.splice(old, 1)
          active.push({ scope: body.document.scope, layoutId: body.document.id })
          sessionStorage.setItem('layout-api-fixture', JSON.stringify({ documents, active }))
          return Response.json({ document: body.document, recovered: [] })
        }
        const mode = url.searchParams.get('mode')
        const matches = (scope: any) => scope.account === url.searchParams.get('account') && scope.mode === mode && scope.deviceClass === url.searchParams.get('deviceClass') && (!scope.project || scope.project === url.searchParams.get('project')) && (!scope.device || scope.device === url.searchParams.get('device'))
        ;(window as any).__LAYOUT_READS__.push(Object.fromEntries(url.searchParams))
        return Response.json({ documents: documents.filter(doc => matches(doc.scope)), active: active.filter(row => matches(row.scope)) })
      }
      if (url.pathname === '/api/layouts/geometry') {
        if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); (window as any).__GEOMETRY_WRITES__.push(body); geometry.set(body.layoutId, body.geometry); return Response.json({ geometry: body.geometry }) }
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
  await expect(page.locator('.dv-tab')).toHaveCount(Object.keys(initial?.blocks ?? builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' }).blocks).length - (initial?.hidden.length ?? 0))
}

type StateFault = { path: string; method?: string; mode?: string; kind?: 'http' | 'hold' | 'network'; remaining?: number }
async function stateFault(page: Page, fault: StateFault) {
  await page.addInitScript(fault => {
    const base = window.fetch.bind(window)
    const control = { ...fault, remaining: fault.remaining ?? 1, calls: [] as { path: string; method: string; id?: string }[], release: () => {} }
    Object.assign(window, { __STATE_FAULT__: control })
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.origin), method = init?.method ?? 'GET'
      if (url.pathname.startsWith('/api/layouts')) control.calls.push({ path: url.pathname, method,
        ...(method === 'PUT' ? { id: JSON.parse(String(init?.body)).document?.id } : {}) })
      if (url.pathname === control.path && method === (control.method ?? 'GET')
        && (!control.mode || url.searchParams.get('mode') === control.mode) && control.remaining-- > 0) {
        if (control.kind === 'hold') await new Promise<void>(resolve => { control.release = resolve })
        else if (control.kind === 'network') throw new TypeError('private-workspace-sentinel')
        else return Response.json({ code: 'internal_error', message: 'private-workspace-sentinel', details: { private: 'private-workspace-sentinel' } }, { status: 503 })
      }
      return base(input, init)
    }
  }, fault)
}
async function pick(page: Page, label: string, value: string, keyboard = false) {
  if (keyboard) {
    await page.getByRole('button', { name: label, exact: true }).focus()
    await page.keyboard.press('Enter')
    const items = page.getByRole('menuitem')
    const index = (await items.allTextContents()).indexOf(value)
    expect(index).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('Home')
    for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown')
    await expect(items.nth(index)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('button', { name: label, exact: true })).toBeFocused()
    return
  }
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menuitem', { name: value, exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}
async function move(page: Page, block: string, zone: string, keyboard = false) {
  if (keyboard) await page.keyboard.press('Alt+Shift+m')
  else await page.getByRole('button', { name: 'Move block to…', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true })).toBeVisible()
  await pick(page, 'Block', block, keyboard)
  await pick(page, 'Destination', zone, keyboard)
  const confirm = page.getByRole('dialog', { name: 'Move block', exact: true }).getByRole('button', { name: 'Move block to…', exact: true })
  if (keyboard) {
    await page.keyboard.press('Tab')
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Enter')
  } else await confirm.click()
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
    // Native engine tabs are outside the retained React pane portal.
    const popupTab = popup.getByRole('tab').first()
    await popupTab.focus()
    await expect(popupTab).toBeFocused()
    const firstZoneActive = (await state(page)).engineState.groups.find(group => group.zone === 'left')!.active
    await popup.keyboard.press('F6')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-block'))).toBe(firstZoneActive)
    await popupTab.focus()
    await popup.keyboard.press('Alt+Shift+m')
    await expect(popup.getByRole('dialog', { name: 'Move block', exact: true })).toBeVisible()
    await pick(popup, 'Destination', 'Bottom')
    await popup.getByRole('dialog', { name: 'Move block', exact: true }).getByRole('button', { name: 'Move block to…', exact: true }).click()
    await expect(page.getByLabel(label!, { exact: true })).toHaveValue(`returned-${name}`)
    expect(await page.getByLabel(label!, { exact: true }).evaluate(node => (node as any).__retainedIdentity)).toBe('original')
    await expect(page.locator('.gx-dialog-backdrop')).toHaveCount(0)
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
  const arrangement = (doc: LayoutDocument) => JSON.parse(JSON.stringify(doc.engineState, (key, value) => ['size', 'width', 'height'].includes(key) ? undefined : value))
  const before = arrangement(await state(page))
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
      expect(arrangement(await state(page))).toEqual(before)
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

for (const [path, mode, source] of [
  ['/api/layouts/context', '', 'layout-context: GET /api/layouts/context'],
  ['/api/layouts', 'developer', 'load-developer-layouts: GET /api/layouts'],
  ['/api/layouts', 'visual', 'load-visual-layouts: GET /api/layouts'],
  ['/api/layouts/geometry', '', 'load-layout-geometry: GET /api/layouts/geometry'],
]) test(`workspace state failure ${source} preserves observed facts, safe details and actual Retry`, async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.clock.setFixedTime(new Date('2026-10-22T12:00:00.000Z'))
  await setup(page)
  await stateFault(page, { path: path!, mode: mode! })
  await page.goto('/workspace')
  const error = page.locator('[data-slot="error-state"]')
  await expect(error).toHaveCount(1)
  await expect(error.locator('.gx-error-state-source')).toHaveText(source!)
  await expect(error.locator('time')).toHaveAttribute('datetime', '2026-10-22T12:00:00.000Z')
  await expect(error).toContainText('Observed')
  await expect(page.getByRole('alert').filter({ has: page.locator('.gx-error-state-title') })).toHaveCount(1)
  await page.clock.setFixedTime(new Date('2026-10-22T13:00:00.000Z'))
  await error.locator('summary').click()
  const details = await error.locator('pre').textContent()
  expect(details).toContain('status=503')
  expect(details).not.toContain('private-workspace-sentinel')
  await error.getByRole('button', { name: 'Copy details', exact: true }).click()
  await expect(error.getByRole('status')).toHaveText('Details copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(details)
  await expect(error.locator('time')).toHaveAttribute('datetime', '2026-10-22T12:00:00.000Z')
  if (path === '/api/layouts/context') {
    await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.setLocale('ru'))
    await expect(error).toContainText('Наблюдение')
    await expect(error.locator('time')).toHaveAttribute('datetime', '2026-10-22T12:00:00.000Z')
    await page.evaluate(() => (window as any).__GUANXI_WORKSPACE__.setLocale('en'))
    await expect(error).toContainText('Observed')
    await page.screenshot({ path: testInfo.outputPath('actual-layout-context-error.png') })
  }
  await error.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await expect(error).toHaveCount(0)
})

for (const width of [390, 1600]) test(`workspace state loading reserves known geometry without actionable or empty content (${width})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 })
  await setup(page)
  await stateFault(page, { path: '/api/layouts/context', kind: 'hold' })
  await page.goto('/workspace')
  const geometry = page.locator('[data-slot="workspace-loading-geometry"]')
  await expect(geometry).toHaveCount(1)
  await expect(geometry).toHaveAttribute('aria-hidden', 'true')
  await expect(geometry.locator('button,input,textarea,a,[tabindex]')).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Loading workspace layouts…' })).toHaveCount(1)
  await expect(geometry.locator('[data-slot="empty-state"]')).toHaveCount(0)
  const before = await geometry.boundingBox()
  const placeholders = await geometry.locator('.gx-workspace-loading-control').count()
  const toolbarBefore = (await geometry.locator('.gx-workspace-toolbar').boundingBox())!
  const knownMinimum = await geometry.evaluate(node => { const style = getComputedStyle(node); return parseFloat(style.getPropertyValue('--control-height')) + parseFloat(style.getPropertyValue('--panel-padding')) * 2 })
  expect(toolbarBefore.height).toBeGreaterThanOrEqual(knownMinimum)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(before!.height).toBeGreaterThan(100)
  await page.screenshot({ path: testInfo.outputPath(`loading-${width}.png`) })
  await page.evaluate(() => (window as any).__STATE_FAULT__.release())
  const toolbar = page.getByRole('group', { name: 'Session workspace', exact: true })
  await expect(toolbar).toHaveCount(1)
  const after = await page.locator('.workspace').boundingBox()
  expect(placeholders).toBe(await toolbar.locator('button,input').count())
  expect(after!.width).toBeCloseTo(before!.width, 0)
  // Saved density, control labels/wrapping and phone content height arrive with the layout.
  if (width === 1600) expect(after!.height).toBeCloseTo(before!.height, 0)
  await expect(geometry).toHaveCount(0)
})

test('workspace state recovered-winner geometry failure retains the acknowledged layout result', async ({ page }) => {
  const winner = builtInLayout({ account: 'local', device: 'device-a', deviceClass: 'desktop', mode: 'developer' })
  winner.rev = 900
  winner.updatedBy = { device: 'device-z' }
  await setup(page, undefined, false, { winner })
  await stateFault(page, { path: '/api/layouts/geometry', remaining: 0 })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await page.evaluate(() => { (window as any).__STATE_FAULT__.remaining = 1 })
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  const error = page.locator('[data-slot="error-state"]')
  await expect(error).toHaveCount(1)
  await expect(error.locator('.gx-error-state-source')).toHaveText('recover-layout-geometry: GET /api/layouts/geometry')
  await error.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(error).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__STATE_FAULT__.calls.filter((call: any) => call.path === '/api/layouts' && call.method === 'PUT').length)).toBe(1)
  expect((await state(page)).rev).toBe(900)
})

test('workspace state activation retry applies an acknowledged recovery exactly once', async ({ page }) => {
  const initial = builtInLayout({ account: 'local', device: 'device-a', deviceClass: 'desktop', mode: 'developer' })
  const candidate = { ...initial, id: 'candidate-layout', name: 'Candidate layout' }
  await setup(page, initial, false, { documents: [candidate], winner: candidate })
  await stateFault(page, { path: '/api/layouts/geometry', remaining: 0 })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await page.evaluate(() => { (window as any).__STATE_FAULT__.remaining = 1 })
  await pick(page, 'Named layout', 'Candidate layout')
  const error = page.locator('[data-slot="error-state"]')
  await expect(error).toHaveCount(1)
  await expect(error.locator('.gx-error-state-source')).toHaveText('activate-layout-geometry: GET /api/layouts/geometry')
  await error.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(error).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__STATE_FAULT__.calls.filter((call: any) => call.path === '/api/layouts' && call.method === 'PUT').length)).toBe(1)
  await page.getByRole('button', { name: 'Named layout', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Recovered layout', exact: true })).toHaveCount(1)
  await page.keyboard.press('Escape')
})

test('workspace state known-successful Save-as geometry failure retries only geometry', async ({ page }) => {
  await setup(page)
  await stateFault(page, { path: '/api/layouts/geometry', method: 'PUT' })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await page.getByRole('button', { name: 'Save as new layout', exact: true }).click()
  const error = page.locator('[data-slot="error-state"]')
  await expect(error).toHaveCount(1)
  await expect(error.locator('.gx-error-state-source')).toHaveText('save-layout-geometry: PUT /api/layouts/geometry')
  await error.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(error).toHaveCount(0)
  const calls = await page.evaluate(() => (window as any).__STATE_FAULT__.calls)
  expect(calls.filter((call: any) => call.path === '/api/layouts' && call.method === 'PUT')).toHaveLength(1)
  expect(calls.filter((call: any) => call.path === '/api/layouts/geometry' && call.method === 'PUT')).toHaveLength(2)
  await expect(page.locator('.dv-tab')).toHaveCount(11)
})

test('workspace state unconfirmed Save-as retry preserves the original document ID', async ({ page }) => {
  await setup(page)
  await stateFault(page, { path: '/api/layouts', method: 'PUT', kind: 'network' })
  await page.goto('/workspace')
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await page.getByRole('button', { name: 'Save as new layout', exact: true }).click()
  const error = page.locator('[data-slot="error-state"]')
  await expect(error).toHaveCount(1)
  await expect(error.locator('.gx-error-state-source')).toHaveText('save-layout: PUT /api/layouts')
  await error.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(error).toHaveCount(0)
  const ids: string[] = await page.evaluate(() => (window as any).__STATE_FAULT__.calls.filter((call: any) => call.path === '/api/layouts' && call.method === 'PUT').map((call: any) => call.id))
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBeTruthy()
  expect(ids[1]).toBe(ids[0])
})

for (const empty of [false, true]) test(`workspace state meaningful empty action ${empty ? 'adds Chat' : 'shows a named hidden block'}`, async ({ page }) => {
  const initial = builtInLayout({ account: 'local', device: 'device-a', deviceClass: 'desktop', mode: 'developer' })
  initial.engineState.groups = []
  initial.hidden = empty ? [] : Object.keys(initial.blocks)
  if (empty) initial.blocks = {}
  await setup(page, initial)
  await page.goto('/workspace')
  const state = page.locator('[data-slot="empty-state"]')
  await expect(state).toHaveCount(1)
  await expect(state.getByRole('button')).toHaveCount(1)
  await state.getByRole('button', { name: empty ? 'Add Chat' : 'Show Chat', exact: true }).click()
  await expect(page.locator('.dv-tab')).toHaveCount(1)
  await expect(page.locator('[data-block="guanxi.core/chat"]')).toBeVisible()
  await expect(state).toHaveCount(0)
})

test('workspace discovers the node account before resolving and saving a layout', async ({ page }) => {
  const layout = builtInLayout({ account: 'owner', device: 'device-a', mode: 'developer', deviceClass: 'desktop' })
  layout.name = 'Owner layout'
  await open(page, layout)
  expect((await state(page)).scope.account).toBe('owner')
  expect(await page.evaluate(() => (window as any).__LAYOUT_READS__.map((row: any) => row.account))).toEqual(['owner', 'owner'])
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__LAYOUT_WRITES__.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__[0].document.scope.account)).toBe('owner')
})

test('explicit save scopes preserve pane state, isolate modes and persist the scoped document and local geometry', async ({ page }) => {
  await setup(page)
  await page.goto('/workspace?project=project-a')
  await expect(page.locator('.workspace')).toBeVisible()
  await move(page, 'Terminal', 'Right')
  await pick(page, 'Save scope', 'This project', true)
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__.length)).toBe(0)
  const originalId = (await state(page)).id
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__GEOMETRY_WRITES__.length)).toBe(1)
  const projectScope = { account: 'local', project: 'project-a', mode: 'developer', deviceClass: 'desktop' }
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__[0].document.scope)).toEqual(projectScope)
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__[0].basedOn)).toBeUndefined()
  expect(await page.evaluate(() => (window as any).__GEOMETRY_WRITES__[0].scope)).toEqual(projectScope)
  expect((await state(page)).engineState.groups.find(group => group.zone === 'right')?.blocks).toContain('guanxi.core/terminal')
  await pick(page, 'Save scope', 'This device')
  await page.getByRole('button', { name: 'Save as new layout', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__GEOMETRY_WRITES__.length)).toBe(2)
  const deviceScope = { account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' }
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__[1].document.scope)).toEqual(deviceScope)
  expect((await state(page)).id).not.toBe(originalId)
  await pick(page, 'Experience mode', 'Visual')
  expect((await state(page)).scope.mode).toBe('visual')
  await pick(page, 'Experience mode', 'Developer')
  expect((await state(page)).scope).toEqual(deviceScope)
  await page.reload()
  await expect(page.locator('.workspace')).toBeVisible()
  expect((await state(page)).scope).toEqual(deviceScope)
  expect((await state(page)).engineState.groups.find(group => group.zone === 'right')?.blocks).toContain('guanxi.core/terminal')
  await pick(page, 'Save scope', 'Account default')
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__GEOMETRY_WRITES__.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__[0].document.scope)).toEqual({ account: 'local', mode: 'developer', deviceClass: 'desktop' })
  await pick(page, 'Save scope', 'This project on this device')
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__GEOMETRY_WRITES__.length)).toBe(2)
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__[1].document.scope)).toEqual({ ...projectScope, device: 'device-a' })
  expect(await page.evaluate(() => (window as any).__GEOMETRY_WRITES__[1].scope)).toEqual({ ...projectScope, device: 'device-a' })
})

test('project save scopes are unavailable outside a project', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Save scope', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(2)
  await expect(page.getByRole('menuitem', { name: 'This project', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__.length)).toBe(0)
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
    doc.engineState.groups = doc.engineState.groups.map(group => ({ ...group, blocks: group.blocks.filter(block => !['guanxi.core/terminal', 'guanxi.core/browser'].includes(block)), active: group.active === 'guanxi.core/terminal' ? undefined : group.active })).filter(group => group.blocks.length)
    doc.engineState.groups.push({ id: 'saved-float', zone: 'floating', blocks: ['guanxi.core/terminal', 'guanxi.core/browser'], active: 'guanxi.core/terminal' })
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
  expect((await state(page)).engineState.groups.find(group => group.zone === 'floating')!.active).toBe('guanxi.core/terminal')
  await pick(page, 'Experience mode', 'Visual')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'visual')
  expect((await state(page)).engineState.groups.find(group => group.zone === 'floating')!.active).toBe('guanxi.core/terminal')
  await expect.poll(() => page.locator('.dv-resize-container:visible').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(460)
  await pick(page, 'Experience mode', 'Developer')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'developer')
  await expect.poll(() => page.locator('.dv-resize-container:visible').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(420)
  expect((await state(page)).engineState.groups.find(group => group.zone === 'floating')!.active).toBe('guanxi.core/terminal')
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
  const paneMove = page.locator('[data-block="guanxi.core/terminal"]').getByRole('button', { name: 'Move block to… Terminal', exact: true })
  await paneMove.click()
  await page.getByRole('menuitem', { name: 'Move block to…', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true }).getByRole('button', { name: 'Block', exact: true })).toHaveText('Terminal')
  await page.keyboard.press('Escape')
  await page.evaluate(async () => { const { requestBlockMove } = await import('/src/features/workspace/commands.ts'); requestBlockMove('guanxi.core/terminal') })
  await expect(page.getByRole('dialog', { name: 'Move block', exact: true }).getByRole('button', { name: 'Block', exact: true })).toHaveText('Terminal')
  await page.keyboard.press('Escape')
  await paneMove.click()
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
  const preview = page.locator('.dv-drop-target-selection:visible').first()
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

test('reset preserves a saved layout clock and persists the default arrangement through reload', async ({ page }) => {
  const initial = builtInLayout({ account: 'local', device: 'device-a', mode: 'developer', deviceClass: 'desktop' })
  initial.rev = 7
  initial.hidden = ['guanxi.core/terminal']
  initial.engineState.groups = initial.engineState.groups.filter(group => group.zone !== 'bottom')
  await open(page, initial)
  await expect(page.locator('.dv-tab')).toHaveCount(10)
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click()
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Layout saved to the node.')
  const written = await page.evaluate(() => (window as any).__LAYOUT_WRITES__[0].document as LayoutDocument)
  expect(written.rev).toBe(8)
  expect(written.id).toBe(initial.id)
  expect(written.hidden).toEqual([])
  await page.reload()
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  const restored = await state(page)
  expect(restored.rev).toBe(8)
  expect(restored.engineState.groups.find(group => group.zone === 'bottom')!.blocks).toEqual(['guanxi.core/terminal'])
})

test('a float dragged near the right and bottom retains normalized bounds after save and mode return', async ({ page }) => {
  await open(page)
  await move(page, 'Terminal', 'Floating')
  const floating = page.locator('.dv-resize-container:visible')
  const header = floating.locator('.dv-tabs-and-actions-container')
  const start = await header.boundingBox()
  const root = await page.locator('.workspace-layout').boundingBox()
  expect(start).not.toBeNull(); expect(root).not.toBeNull()
  await page.mouse.move(start!.x + 40, start!.y + 10)
  await page.mouse.down()
  await page.mouse.move(root!.x + root!.width - 220, root!.y + root!.height - 100, { steps: 15 })
  await page.mouse.up()
  const bounds = await floating.boundingBox()
  expect(bounds).not.toBeNull()
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByTestId('workspace-announcement')).toHaveText('Layout saved to the node.')
  const saved = await page.evaluate(() => (window as any).__GEOMETRY_WRITES__[0].geometry as Record<string, { left: number; top: number; width: number; height: number }>)
  expect(Object.keys(saved)).toHaveLength(1)
  const box = Object.values(saved)[0]!
  expect(Math.abs(box.left - (bounds!.x - root!.x))).toBeLessThan(2)
  expect(Math.abs(box.top - (bounds!.y - root!.y))).toBeLessThan(2)
  await pick(page, 'Experience mode', 'Visual')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'visual')
  await pick(page, 'Experience mode', 'Developer')
  await expect(page.locator('.workspace')).toHaveAttribute('data-mode', 'developer')
  const restored = await floating.boundingBox()
  expect(restored).not.toBeNull()
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(restored![key] - bounds![key])).toBeLessThan(2)
})

test('floating windows reject unsupported nested splits without losing a block', async ({ page }) => {
  await open(page)
  await move(page, 'Terminal', 'Floating')
  const before = await state(page)
  const source = await page.locator('.dv-tab').filter({ hasText: /^Browser$/ }).boundingBox()
  const target = await page.locator('[data-block="guanxi.core/terminal"]').boundingBox()
  expect(source).not.toBeNull(); expect(target).not.toBeNull()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await page.mouse.down()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height + 12, { steps: 5 })
  await page.mouse.move(target!.x + target!.width - 8, target!.y + target!.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.dv-tab')).toHaveCount(11)
  const after = await state(page)
  expect(after.engineState.groups.filter(group => group.zone === 'floating')).toHaveLength(1)
  expect(after.engineState.groups.find(group => group.zone === 'floating')!.blocks).toEqual(['guanxi.core/terminal'])
  expect(after.engineState.groups.find(group => group.zone === 'left')!.blocks).toEqual(before.engineState.groups.find(group => group.zone === 'left')!.blocks)
})

test('popout-native shortcuts follow its current tab after a merge and the original pane returns', async ({ page, context }) => {
  await open(page)
  const opened = context.waitForEvent('page')
  await move(page, 'Terminal', 'Popout')
  const popup = await opened
  await expect(popup.getByRole('tab', { name: 'Terminal', exact: true })).toBeVisible()
  // Drive the engine's HTML5 transfer across its two same-origin documents.
  const source = page.getByRole('tab', { name: 'Browser', exact: true })
  const target = popup.locator('.dv-content-container').first()
  const bounds = await target.boundingBox()
  expect(bounds).not.toBeNull()
  const from = await page.evaluateHandle(() => new DataTransfer())
  const to = await popup.evaluateHandle(() => new DataTransfer())
  const originalTab = await source.elementHandle()
  expect(originalTab).not.toBeNull()
  await originalTab!.dispatchEvent('dragstart', { dataTransfer: from })
  for (const type of ['dragenter', 'dragover', 'drop']) await target.dispatchEvent(type, { dataTransfer: to, clientX: bounds!.x + bounds!.width / 2, clientY: bounds!.y + bounds!.height / 2 })
  await originalTab!.dispatchEvent('dragend', { dataTransfer: from })
  await expect(popup.getByRole('tab')).toHaveCount(2)
  await popup.getByRole('tab', { name: 'Browser', exact: true }).click()
  await popup.keyboard.press('Alt+Shift+m')
  const dialog = popup.getByRole('dialog', { name: 'Move block', exact: true })
  await expect(dialog.getByRole('button', { name: 'Block', exact: true })).toHaveText('Browser')
  await pick(popup, 'Block', 'Terminal')
  await pick(popup, 'Destination', 'Bottom')
  await dialog.getByRole('button', { name: 'Move block to…', exact: true }).click()
  await expect(page.getByLabel('Terminal input draft', { exact: true })).toBeVisible()
  await expect(popup.getByRole('tab')).toHaveCount(1)
  const tab = popup.getByRole('tab', { name: 'Browser', exact: true })
  await tab.focus()
  const first = (await state(page)).engineState.groups.find(group => group.zone === 'left')!.active
  await popup.keyboard.press('F6')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-block'))).toBe(first)
  await tab.focus()
  await popup.keyboard.press('Alt+Shift+m')
  await expect(dialog.getByRole('button', { name: 'Block', exact: true })).toHaveText('Browser')
  await popup.keyboard.press('Escape')
})

test('choice menus preserve focus when tabbing away or clicking an outside field', async ({ page }) => {
  await open(page)
  const mode = page.getByRole('button', { name: 'Experience mode', exact: true })
  const density = page.getByRole('button', { name: 'Density', exact: true })
  await mode.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Home')
  await expect(page.getByRole('menuitem', { name: 'Developer', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(density).toBeFocused()
  await mode.click()
  await expect(page.getByRole('menu')).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Named layout', exact: true })
  await input.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(input).toBeFocused()
})

for (const phone of [false, true]) test(`shell commands reveal and focus blocks without admitting invalid writes (${phone ? 'phone' : 'desktop'})`, async ({ page }) => {
  if (phone) await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.goto('/workspace')
  await expect(page.locator('.workspace')).toBeVisible()
  if (phone) await expect(page.getByRole('tablist', { name: 'Workspace blocks' })).toBeVisible()
  else await expect(page.locator('.dv-tab')).toHaveCount(11)
  const reveal = async (id: unknown) => page.evaluate(id => {
    window.dispatchEvent(new CustomEvent('workspace.reveal-block', { detail: { instanceId: id } }))
  }, id)
  await reveal('guanxi.core/plan')
  const pane = page.locator('[data-block="guanxi.core/plan"]')
  await expect(pane).toBeVisible()
  await expect(pane).toBeFocused()
  await pane.getByRole('button', { name: 'Move block to… Plan', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Hide block', exact: true }).click()
  await expect.poll(async () => (await state(page)).hidden).toContain('guanxi.core/plan')
  await reveal('guanxi.core/plan')
  await expect(pane).toBeVisible()
  await expect(pane).toBeFocused()
  expect((await state(page)).hidden).not.toContain('guanxi.core/plan')
  const placement = (await state(page)).engineState.groups.flatMap(group => group.blocks).filter(id => id === 'guanxi.core/plan')
  expect(placement).toHaveLength(1)
  const before = await state(page)
  await reveal({ malformed: true })
  await reveal('not-a-contributed-block')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('workspace.set-mode', { detail: { mode: 'invalid' } })))
  expect(await state(page)).toEqual(before)
  expect(await page.evaluate(() => (window as any).__LAYOUT_WRITES__)).toEqual([])
})
