/**
 * Round 4 (owner feedback 2026-10-23): one session view. A chat session opened from the sidebar
 * is the full-width timeline, never the docking workspace with its row of layout buttons; the
 * header's title, model and context never overlap; side panels open from one icon menu.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { chatFixtureThreadId, installChatApiFixture } from './fixtures/chat-api.ts'
import { openNavigation } from './fixtures/shell-navigation.ts'

const THREAD = chatFixtureThreadId('completed')
const LONG_TITLE = 'Inspecting model path permissions on the Fedora workstation before the nightly import job runs again'

async function setup(page: Page, title = LONG_TITLE, stored: { open: string[]; active: string } | null = null) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installChatApiFixture(page, 'completed')
  await page.addInitScript(({ threadId, title, stored }) => {
    if (stored) localStorage.setItem('guanxi.session-panels', JSON.stringify(stored))
    else localStorage.removeItem('guanxi.session-panels')
    const base = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
      if (url.pathname === '/api/sessions/list/page') {
        return Response.json({ sessions: [{ sessionId: 'session-chat-1', kind: 'chat', threadId, title, createdAt: '2026-10-24T09:00:00.000Z',
          lastSeq: 4, lastEventAt: '2026-10-24T09:01:00.000Z', execution: null, navigation: { kind: 'chat', threadId, projectId: null } }],
        nextCursor: null, omitted: { withheld: false, catchingUp: false } })
      }
      const response = await base(input, init)
      if (url.pathname === `/api/threads/${threadId}` && (init?.method ?? 'GET') === 'GET' && response.ok) {
        const body = await response.json()
        return Response.json({ ...body, thread: { ...body.thread, title } })
      }
      if (url.pathname === '/api/settings' && response.ok) return Response.json({ ...await response.json(), locale: 'en' })
      return response
    }
  }, { threadId: THREAD, title, stored })
}

async function openFromSidebar(page: Page) {
  await page.goto('/')
  await openNavigation(page)
  await page.getByRole('link', { name: /Inspecting model path permissions/u }).first().click()
  await expect(page.getByTestId('session-view')).toBeVisible()
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  // A shared edge is not an overlap; half a pixel absorbs subpixel layout.
  return a.x + a.width > b.x + 0.5 && b.x + b.width > a.x + 0.5 && a.y + a.height > b.y + 0.5 && b.y + b.height > a.y + 0.5
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  expect(value, 'element is laid out').not.toBeNull()
  return value!
}

test('a chat session from the sidebar opens the full-width timeline, not the docking workspace', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openFromSidebar(page)
  await expect(page).toHaveURL(new RegExp(`/chat/${THREAD}$`, 'u'))
  await expect(page.locator('.workspace')).toHaveCount(0)
  await expect(page.locator('.dv-tab')).toHaveCount(0)
  await expect(page.locator('.gx-workspace-toolbar')).toHaveCount(0)
  // None of the rejected layout text buttons, and no Developer/Visual switch, in the session pane.
  // (The status strip's device item is also named "This device"; it is an icon, outside the pane.)
  const route = page.locator('[data-slot="shell-route-host"]')
  for (const name of ['Comfortable', 'This device', 'Named layout', 'Add block', 'Hidden blocks', 'Save layout', 'Save as new layout', 'Move block to…', 'Reset layout'])
    await expect(route.getByRole('button', { name, exact: true })).toHaveCount(0)
  for (const name of ['Developer', 'Visual']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(route.getByRole('textbox', { name: 'Named layout' })).toHaveCount(0)
  // The timeline takes the session pane's width: no legacy chat list or context column beside it.
  await expect(page.getByRole('navigation', { name: 'Conversation history' })).toHaveCount(0)
  await expect(page.getByTestId('session-panels')).toHaveCount(0)
  const pane = await box(page.locator('[data-slot="shell-route-host"]'))
  const session = await box(page.getByTestId('session-view'))
  expect(session.width).toBeGreaterThan(pane.width - 4)
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
})

for (const width of [360, 1280]) test(`the session header never overlaps title and context at ${width} px; the model shows once, in the composer`, async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width, height: 800 })
  await page.goto(`/chat/${THREAD}`)
  const header = page.getByTestId('session-header')
  await expect(header).toBeVisible()
  const title = page.getByTestId('session-title')
  const context = page.getByTestId('session-context')
  const actions = header.locator('.native-session-actions')
  await expect(title).toHaveText(LONG_TITLE)
  const boxes = { header: await box(header), title: await box(title), context: await box(context), actions: await box(actions) }
  const parts = ['title', 'context', 'actions'] as const
  for (const [index, a] of parts.entries()) {
    const own = boxes[a]
    expect(own.x, `${a} starts inside the header`).toBeGreaterThanOrEqual(boxes.header.x - 0.5)
    expect(own.x + own.width, `${a} ends inside the header`).toBeLessThanOrEqual(boxes.header.x + boxes.header.width + 0.5)
    for (const b of parts.slice(index + 1)) expect(overlaps(own, boxes[b]), `${a} overlaps ${b}`).toBe(false)
  }
  // The long title is truncated with an ellipsis rather than wrapped or pushed under its neighbours.
  expect(await title.evaluate(node => getComputedStyle(node).textOverflow)).toBe('ellipsis')
  if (width === 360) expect(await title.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
  expect(boxes.title.height).toBeLessThan(boxes.header.height)
  // No duplicate: the model is not in the header; the composer footer names it once (D-207).
  await expect(header.getByText('fixture:latest')).toHaveCount(0)
  await expect(page.getByTestId('composer-model')).toHaveCount(1)
  await expect(page.getByTestId('composer-model')).toContainText('Model: fixture:latest')
  await expect(context).toHaveAccessibleName(/^Context panel: .*tokens/u)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('header actions are borderless icon buttons with design tooltips, not native titles', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/chat/${THREAD}`)
  const actions = page.getByTestId('session-header').locator('.native-session-actions')
  for (const name of ['Panels and layout', 'Chat info', 'Open trace', 'New']) {
    const control = actions.getByRole(name === 'Open trace' || name === 'New' ? 'link' : 'button', { name, exact: true })
    await expect(control).toHaveCount(1)
    await expect(control).toHaveClass(/\bgx-icon-button\b/u)
    await expect(control).not.toHaveAttribute('title', /.+/u)
    // Borderless: no visible border at rest (a transparent hairline may reserve the focus geometry).
    expect(await control.evaluate(node => { const style = getComputedStyle(node); return style.borderTopWidth === '0px' || style.borderTopColor === 'rgba(0, 0, 0, 0)' || style.borderTopStyle === 'none' })).toBe(true)
    expect(await control.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    expect((await control.textContent())?.trim()).toBe('')
  }
  await actions.getByRole('link', { name: 'Open trace', exact: true }).hover()
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Open trace' })).toBeVisible()
  await page.getByTestId('session-context').hover()
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: /tokens/u })).toBeVisible()
})

test('side panels open from one menu, by keyboard, beside the timeline, and close back to the composer', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/chat/${THREAD}`)
  const trigger = page.getByRole('button', { name: 'Panels and layout', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('session-panels-menu')
  await expect(menu).toBeVisible()
  const rows = menu.getByRole('menuitemcheckbox')
  expect(await rows.allTextContents()).toEqual(['Context', 'Plan', 'Artifacts', 'Browser', 'Sub-agents', 'Terminal', 'Processes', 'Environment', 'Changes', 'Files'])
  for (const state of await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-checked')))) expect(state).toBe('false')
  // Each row is an icon and a label; the check mark keeps its slot and is hidden from assistive tech.
  expect(await rows.first().locator('[data-slot="icon"]').count()).toBeGreaterThanOrEqual(1)
  await expect(menu.getByRole('menuitem', { name: 'Arrange panels freely', exact: true })).toHaveCount(1)
  const context = menu.getByRole('menuitemcheckbox', { name: 'Context', exact: true })
  for (let step = 0; step < 12 && !(await context.evaluate(node => node === document.activeElement)); step++) await page.keyboard.press('ArrowDown')
  await expect(context).toBeFocused()
  await page.keyboard.press('Enter')
  const panels = page.getByTestId('session-panels')
  await expect(panels).toBeVisible()
  await expect(panels.getByRole('heading', { name: 'Context', exact: true })).toBeVisible()
  await expect(page.getByTestId('session-context')).toHaveAttribute('aria-pressed', 'true')
  // Beside, not over: the panel starts where the timeline ends on a wide screen.
  const main = await box(page.locator('.session-view .native-session-main'))
  const aside = await box(panels)
  expect(aside.x).toBeGreaterThanOrEqual(main.x + main.width - 0.5)
  // A second panel switches by icon; the menu shows both checked.
  await trigger.click()
  await menu.getByRole('menuitemcheckbox', { name: 'Terminal', exact: true }).click()
  await expect(panels.getByRole('radiogroup', { name: 'Shown panel' }).getByRole('radio')).toHaveCount(2)
  await trigger.click()
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Context', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Terminal', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // Close both with the panel's own close icon and Escape; focus returns to the composer.
  await panels.getByRole('button', { name: 'Close Terminal', exact: true }).click()
  await panels.getByRole('button', { name: 'Close Context', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(panels).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused()
  // The context value in the header toggles the same panel; its name does not flip with the state
  // (aria-pressed carries it).
  const contextControl = page.getByTestId('session-context')
  const unpressedName = await contextControl.getAttribute('aria-label')
  expect(unpressedName).toMatch(/^Context panel: /u)
  await contextControl.click()
  await expect(contextControl).toHaveAttribute('aria-pressed', 'true')
  await expect(contextControl).toHaveAttribute('aria-label', unpressedName!)
  await expect(panels.getByRole('heading', { name: 'Context', exact: true })).toBeVisible()
  // On a phone the panel is a modal sheet: the app behind it is inert, focus is inside; Escape closes it.
  // Narrowing the window does not turn open side panels into a sheet that grabs focus (review 4).
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panels).toHaveCount(0)
  await page.getByTestId('session-context').click()
  await expect(panels.getByRole('button', { name: 'Close Context', exact: true })).toBeFocused()
  await expect(page.locator('#root')).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(panels).toHaveCount(0)
  await expect(page.locator('#root')).not.toHaveAttribute('inert', /.*/u)
  // A medium session keeps the panel beside the timeline, under the header that stays reachable.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByTestId('session-context').click()
  const header = await box(page.getByTestId('session-header'))
  expect(overlaps(header, await box(panels)), 'panel covers the header at 1280').toBe(false)
  await trigger.click({ trial: true })
})

// Round 4 review (coordinator, 2026-10-24): the narrow-session panel is a modal sheet.

test('closing the last panel of a phone sheet returns focus to the composer, not the page body (review 1)', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/chat/${THREAD}`)
  await page.getByTestId('session-context').click()
  const sheet = page.getByTestId('session-panels')
  await sheet.getByRole('button', { name: 'Close Context', exact: true }).click()
  await expect(page.getByTestId('session-panels')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
})

test('arrow keys in the sheet panel switcher keep focus on the switcher (review 2)', async ({ page }) => {
  await setup(page, LONG_TITLE, { open: ['context', 'terminal'], active: 'context' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/chat/${THREAD}`)
  const sheet = page.getByTestId('session-panels')
  await expect(page.getByTestId('session-title')).toBeVisible()
  // Stored panels open only by a user action on a phone (review 4); the context value is one.
  if (await sheet.count() === 0) await page.getByTestId('session-context').click()
  const switcher = sheet.getByRole('radiogroup', { name: 'Shown panel' })
  await expect(switcher.getByRole('radio')).toHaveCount(2)
  await switcher.getByRole('radio', { name: 'Context' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(sheet.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible()
  await expect(switcher.getByRole('radio', { name: 'Terminal' })).toBeFocused()
})

const SHEET = { name: 'Side panels' }
for (const width of [390, 680]) test(`a narrow session's panel is a modal sheet that contains focus at ${width} px (review 3)`, async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width, height: 844 })
  await page.goto(`/chat/${THREAD}`)
  await page.getByTestId('session-context').click()
  const sheet = page.getByRole('dialog', SHEET)
  await expect(sheet).toHaveAttribute('aria-modal', 'true')
  await expect(sheet.getByRole('button', { name: 'Close Context', exact: true })).toBeFocused()
  // The shell behind it is inert: Tab and Shift+Tab never leave the sheet.
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await sheet.evaluate(node => node.contains(document.activeElement)), `${key} stays in the sheet`).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused()
})

test('stored panels never reopen as a sheet on a phone, but do beside the timeline on a wide screen (review 4)', async ({ page }) => {
  await setup(page, LONG_TITLE, { open: ['context'], active: 'context' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/chat/${THREAD}`)
  await expect(page.getByTestId('session-title')).toBeVisible()
  await expect(page.getByTestId('session-panels')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message' })).not.toBeFocused()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/chat/${THREAD}`)
  await expect(page.getByTestId('session-panels')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
