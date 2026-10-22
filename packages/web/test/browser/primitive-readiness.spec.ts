import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

const fixture = '/test/browser/fixtures/primitive-readiness.html'
const localizedLabels = [
  { locale: 'ru', menu: 'Действия с сессией', icon: 'Открыть настройки' },
  { locale: 'pseudo', menu: '⟦Šéššíóñ áçţíóñš····⟧', icon: '⟦Óþéñ šéţţíñĝš····⟧' },
] as const

async function open(page: Page, params: Record<string, string> = {}) {
  await page.goto(`${fixture}?${new URLSearchParams(params)}`)
  await expect(page.getByTestId('menu-trigger')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function settled(page: Page) {
  await page.waitForFunction(() => document.querySelector('[data-starting-style], [data-ending-style]') === null
    && document.getAnimations().every(animation => animation.playState !== 'running'))
}

async function target24(control: Locator) {
  const box = await control.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(24)
  expect(box!.height).toBeGreaterThanOrEqual(24)
}

async function tooltipFor(page: Page, trigger: Locator, label: string) {
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveCount(1)
  await expect(tooltip).toHaveText(label)
  const id = await tooltip.getAttribute('id')
  expect(id).toBeTruthy()
  const references = `${await trigger.getAttribute('aria-describedby') ?? ''} ${await trigger.getAttribute('aria-labelledby') ?? ''}`.trim().split(/\s+/)
  expect(references).toContain(id)
  await expect(trigger).toHaveAccessibleName(label)
  return tooltip
}

async function fitsViewport(locator: Locator) {
  const boxes = await locator.evaluate(node => [node, ...node.querySelectorAll('[role="menuitem"]')].map(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      width: innerWidth, height: innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
  }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(box.width)
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(box.height)
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
  }
}

test('uncontrolled Menu keyboard navigation focuses disabled commands but never activates them', async ({ page }) => {
  await open(page)
  const trigger = page.getByTestId('menu-trigger')
  const items = page.getByRole('menuitem')
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(items).toHaveCount(4)
  await expect(items.nth(0)).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.nth(3)).toBeFocused()
  await page.keyboard.press('r')
  await expect(items.nth(0)).toBeFocused()
  // A fresh open clears the typeahead buffer before testing Space activation semantics.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(0)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const disabled = items.nth(2)
  await expect(disabled).toBeFocused()
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Enter')
  await expect(items).toHaveCount(4)
  await expect(page.getByTestId('disabled-actions')).toHaveText('0')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('disabled-actions')).toHaveText('0')
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(3)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(items.nth(0)).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.nth(3)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(disabled).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.getByTestId('menu-actions')).toHaveText('0')
})

test('Menu enabled keyboard and pointer actions execute exactly once; disabled pointer action executes zero', async ({ page }) => {
  await open(page)
  const trigger = page.getByTestId('menu-trigger')
  for (const key of ['Enter', 'Space']) {
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press(key)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByTestId('menu-actions')).toHaveText(key === 'Enter' ? '1' : '2')
    await expect(trigger).toBeFocused()
  }
  await trigger.click()
  const disabled = page.getByRole('menuitem', { name: 'Export trace' })
  const box = await disabled.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(page.getByTestId('disabled-actions')).toHaveText('0')
  await expect(page.getByRole('menu')).toHaveCount(1)
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click()
  await expect(page.getByTestId('menu-actions')).toHaveText('3')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('small IconButton targets preserve name, hidden glyph, disabled nonactivation and toggle semantics', async ({ page }) => {
  await open(page)
  const icon = page.getByTestId('icon')
  const disabled = page.getByTestId('disabled-icon')
  const toggle = page.getByTestId('toggle')
  for (const control of [icon, disabled, toggle]) await target24(control)
  await expect(icon).toHaveAccessibleName('Open settings')
  await expect(icon.locator('.gx-icon-button-glyph')).toHaveAttribute('aria-hidden', 'true')
  await expect(icon.locator('svg')).toHaveAttribute('aria-hidden', 'true')
  await icon.click()
  await expect(page.getByTestId('icon-actions')).toHaveText('1')
  await icon.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('icon-actions')).toHaveText('2')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('icon-actions')).toHaveText('3')
  await expect(disabled).toBeDisabled()
  const box = await disabled.boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(page.getByTestId('disabled-actions')).toHaveText('0')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAccessibleName('Pin session')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAccessibleName('Pin session')
  await expect(page.getByTestId('toggle-actions')).toHaveText('1')
})

test('pointer-active IconButton fill changes independently of its toggle state', async ({ page }) => {
  await open(page)
  const icon = page.getByTestId('icon')
  await icon.hover()
  const hover = await icon.evaluate(node => getComputedStyle(node).backgroundColor)
  await page.mouse.down()
  await expect.poll(() => icon.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(hover)
  await expect(icon).not.toHaveAttribute('aria-pressed')
  await expect(page.getByTestId('icon-actions')).toHaveText('0')
  await page.mouse.up()
  await expect(page.getByTestId('icon-actions')).toHaveText('1')
})

for (const composition of ['icon', 'dialog'] as const) {
  test(`${composition} Tooltip opens on pointer and keyboard, has an accessible relation and dismisses without activation`, async ({ page }) => {
    await open(page)
    if (composition === 'dialog') await page.getByTestId('dialog-trigger').click()
    const trigger = composition === 'icon' ? page.getByTestId('icon') : page.getByRole('button', { name: 'Close', exact: true })
    const label = composition === 'icon' ? 'Open settings' : 'Close'
    // Move keyboard focus away so the first opening is actually pointer driven.
    if (composition === 'dialog') await page.getByRole('dialog').focus()
    await trigger.hover()
    await tooltipFor(page, trigger, label)
    await page.mouse.move(310, 600)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await trigger.focus()
    await tooltipFor(page, trigger, label)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByTestId('icon-actions')).toHaveText('0')
    if (composition === 'dialog') {
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await trigger.click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('dialog-trigger')).toBeFocused()
    }
  })
}

test('forced colors preserves visible trigger focus, highlighted command contrast and Tooltip boundary', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' })
  await open(page)
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
  const trigger = page.getByTestId('menu-trigger')
  await trigger.focus()
  const ring = await trigger.evaluate(node => {
    const style = getComputedStyle(node)
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor, background: style.backgroundColor }
  })
  expect(ring.style).toBe('solid')
  expect(ring.width).toBeGreaterThanOrEqual(2)
  expect(ring.color).not.toBe(ring.background)
  await page.keyboard.press('ArrowDown')
  const highlighted = page.getByRole('menuitem').first()
  await expect(highlighted).toBeFocused()
  await expect(highlighted).toHaveAttribute('data-highlighted')
  const colors = await highlighted.evaluate(node => ({ fg: getComputedStyle(node).color, bg: getComputedStyle(node).backgroundColor }))
  expect(colors.fg).not.toBe(colors.bg)
  expect(colors.bg).not.toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('Escape')
  await page.getByTestId('icon').focus()
  const tooltip = await tooltipFor(page, page.getByTestId('icon'), 'Open settings')
  const border = await tooltip.evaluate(node => ({ style: getComputedStyle(node).borderTopStyle, width: parseFloat(getComputedStyle(node).borderTopWidth) }))
  expect(border.style).toBe('solid')
  expect(border.width).toBeGreaterThanOrEqual(1)
})

for (const theme of ['light', 'dark']) for (const density of ['compact', 'comfortable']) for (const glass of ['glass', 'tinted', 'solid']) {
  test(`localized phone popups and focused targets fit ${theme}/${density}/${glass}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 640 })
    for (const { locale, menu: menuLabel, icon: iconLabel } of localizedLabels) {
      await open(page, { theme, density, glass, locale })
      const trigger = page.getByTestId('menu-trigger')
      await expect(trigger).toHaveText(menuLabel)
      await trigger.focus()
      await page.keyboard.press('ArrowDown')
      const menu = page.getByRole('menu')
      await expect(page.getByRole('menuitem')).toHaveCount(4)
      await expect(page.getByRole('menuitem').first()).toBeFocused()
      await settled(page)
      await fitsViewport(menu)
      await expect(page.getByRole('menuitem').nth(2)).toHaveAttribute('aria-disabled', 'true')
      await testInfo.attach(`${locale}-menu`, { body: await page.screenshot(), contentType: 'image/png' })
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      const icon = page.getByTestId('icon')
      await target24(icon)
      await icon.focus()
      const tooltip = await tooltipFor(page, icon, iconLabel)
      await settled(page)
      await fitsViewport(tooltip)
      await testInfo.attach(`${locale}-tooltip`, { body: await page.screenshot(), contentType: 'image/png' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const axe = await new AxeBuilder({ page }).include('main').include('[role="tooltip"]').analyze()
      expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])
    }
  })
}

test('reduced transparency makes open Menu opaque while retaining localized interaction', async ({ page }) => {
  await open(page, { glass: 'glass', transparency: 'reduced', locale: 'ru' })
  await page.getByTestId('menu-trigger').click()
  const menu = page.getByRole('menu')
  const material = await menu.evaluate(node => ({ backdrop: getComputedStyle(node).backdropFilter,
    opacity: getComputedStyle(node).getPropertyValue('--material-glass-fill-opacity').trim(), background: getComputedStyle(node).backgroundColor }))
  expect(material.backdrop).toBe('none')
  // Actual resolved fill has no alpha channel, rather than merely an attribute on the host.
  expect(material.background).not.toMatch(/\/\s*0\.|rgba\([^)]*,\s*0\./)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('menu-trigger')).toBeFocused()
})
