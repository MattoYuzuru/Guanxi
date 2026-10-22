import { expect, test, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const fixture = '/test/browser/fixtures/workspace-state-readiness.html'
async function open(page: Page, params: Record<string, string> = {}) {
  await page.goto(`${fixture}?${new URLSearchParams(params)}`)
  await expect(page.getByTestId('controlled')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}
async function target(control: Locator) {
  const box = await control.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(24)
  expect(box!.height).toBeGreaterThanOrEqual(24)
}
async function fits(locator: Locator) {
  expect(await locator.evaluate(node => {
    const box = node.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1
  })).toBe(true)
}

test('Textarea native multiline edits, row defaults, disabled and readonly boundaries remain intact', async ({ page }) => {
  await open(page)
  const controlled = page.getByTestId('controlled'), uncontrolled = page.getByTestId('uncontrolled')
  await expect(controlled).toHaveAttribute('rows', '3')
  await expect(uncontrolled).toHaveAttribute('rows', '5')
  await expect(controlled).not.toHaveAttribute('maxlength')
  await controlled.pressSequentially('First line')
  await controlled.press('Enter')
  await controlled.pressSequentially('Second line')
  await expect(controlled).toHaveValue('First line\nSecond line')
  await expect(page.getByTestId('value')).toHaveText('First line\nSecond line')
  await expect(page.getByTestId('changes')).toHaveText('22')
  const large = `Русский текст\n${'multiline description '.repeat(1000)}`
  await uncontrolled.fill(large)
  await expect(uncontrolled).toHaveValue(large)
  await controlled.focus()
  await page.keyboard.press('Tab')
  await expect(uncontrolled).toBeFocused()
  await page.keyboard.press('Tab')
  const readonly = page.getByTestId('readonly')
  await expect(readonly).toBeFocused()
  const before = await readonly.inputValue()
  await page.keyboard.type('forbidden')
  await expect(readonly).toHaveValue(before)
  const disabled = page.getByTestId('disabled')
  await expect(disabled).toBeDisabled()
  await disabled.evaluate(node => (node as HTMLTextAreaElement).focus())
  await expect(disabled).not.toBeFocused()
  await page.keyboard.type('still forbidden')
  await expect(disabled).toHaveValue(before)
})

test('Textarea actual vertical resizing preserves focus ring and horizontal bounds', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const field = page.getByTestId('controlled')
  await page.keyboard.press('Tab')
  await expect(field).toBeFocused()
  const before = (await field.boundingBox())!
  await page.mouse.move(before.x + before.width - 4, before.y + before.height - 4)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width - 4, before.y + before.height + 60, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(before.height + 30)
  const after = (await field.boundingBox())!
  expect(after.width).toBeCloseTo(before.width, 0)
  await expect(field).toBeFocused()
  expect(await field.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2)
  await fits(field)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('textarea-resize.png') })
})

test('EmptyState has one sentence and one named action with exact pointer and keyboard effects', async ({ page }) => {
  await open(page)
  const state = page.locator('[data-slot="empty-state"]')
  await expect(state.locator('p')).toHaveCount(1)
  await expect(state.locator('p')).toHaveText('No sessions in this project yet.')
  await expect(state.getByRole('button')).toHaveCount(1)
  await expect(state.locator('.gx-empty-state-icon')).toHaveAttribute('aria-hidden', 'true')
  await expect(state.getByRole('img')).toHaveCount(0)
  const action = state.getByRole('button', { name: 'New session', exact: true })
  await action.click()
  await expect(page.getByTestId('empty-actions')).toHaveText('1')
  await action.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('empty-actions')).toHaveText('2')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('empty-actions')).toHaveText('3')
})

test('ErrorState keyboard disclosure, actual clipboard, current feedback and retry busy guard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  const error = page.getByRole('alert')
  await expect(error).toHaveCount(1)
  await expect(error).toContainText('Observed')
  await expect(error.locator('time')).toHaveAttribute('datetime', '2026-10-22T12:00:00.000Z')
  const disclosure = error.locator('summary')
  await disclosure.focus()
  await page.keyboard.press('Enter')
  await expect(error.locator('details')).toHaveAttribute('open', '')
  const copy = error.getByRole('button', { name: 'Copy details', exact: true })
  await page.keyboard.press('Tab')
  await expect(copy).toBeFocused()
  await page.keyboard.press('Space')
  await expect(error.getByRole('status')).toHaveText('Details copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('source=fixture-layouts\nstatus=503')
  await page.getByTestId('change-details').click()
  await expect(error.getByRole('status')).toHaveText('')
  await copy.click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('source=fixture-geometry\nstatus=502')
  const retry = error.getByRole('button', { name: 'Retry', exact: true })
  await retry.click()
  const busy = error.getByRole('button', { name: 'Retrying…', exact: true })
  await expect(busy).toHaveAttribute('aria-busy', 'true')
  await busy.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('retries')).toHaveText('1')
  await expect(busy).toBeFocused()
})

test('ErrorState clipboard rejection offers selectable details and announces the failure', async ({ page }) => {
  await open(page)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError') } } }))
  const error = page.getByRole('alert')
  await error.locator('summary').click()
  await error.getByRole('button', { name: 'Copy details', exact: true }).click()
  await expect(error.getByRole('status')).toHaveText('Copy failed; select the text instead')
  expect(await error.locator('pre').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); return getSelection()!.toString() })).toBe('source=fixture-layouts\nstatus=503')
})

test('Textarea and ErrorState focus remain visible in actual emulated forced colours', async ({ page }, testInfo) => {
  await page.emulateMedia({ forcedColors: 'active' })
  await open(page)
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
  await page.keyboard.press('Tab')
  const textarea = page.getByTestId('controlled')
  await expect(textarea).toBeFocused()
  expect(await textarea.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2)
  await page.screenshot({ path: testInfo.outputPath('forced-textarea.png') })
  const summary = page.getByRole('alert').locator('summary')
  await summary.focus()
  expect(await summary.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2)
  await target(summary)
  await page.screenshot({ path: testInfo.outputPath('forced-error.png') })
})

for (const theme of ['light', 'dark', 'light-hc', 'dark-hc']) for (const density of ['compact', 'comfortable']) for (const glass of ['glass', 'tinted', 'solid']) {
  test(`state components fit localized phone ${theme}/${density}/${glass}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 900 })
    for (const locale of ['ru', 'pseudo']) {
      await open(page, { theme, density, glass, locale, transparency: 'reduced' })
      for (const field of [page.getByTestId('controlled'), page.getByTestId('uncontrolled'), page.getByTestId('disabled'), page.getByTestId('readonly')]) {
        await target(field)
        await fits(field)
        await expect(field).toHaveAccessibleName(/.+/)
      }
      const empty = page.locator('[data-slot="empty-state"]'), error = page.getByRole('alert')
      await expect(empty.getByRole('button')).toHaveCount(1)
      await expect(error).toHaveCount(1)
      await error.locator('summary').click()
      for (const node of [empty, empty.locator('p'), error, error.locator('pre'), error.locator('summary')]) await fits(node)
      for (const action of [empty.getByRole('button'), ...await error.locator('button,summary').all()]) await target(action)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.getByTestId('controlled').evaluate(node => getComputedStyle(node).fontSize)).toBe(density === 'compact' ? '13px' : '14px')
      for (const node of [empty, error]) expect(await node.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
      expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0)
      const violations = (await new AxeBuilder({ page }).include('main').analyze()).violations.filter(item => item.impact === 'serious' || item.impact === 'critical')
      expect(violations).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`${locale}-${theme}-${density}-${glass}.png`), fullPage: true })
    }
  })
}
