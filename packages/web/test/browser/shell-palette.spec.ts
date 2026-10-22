import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('palette modal traps focus, returns it on Escape, skips unavailable actions and executes exactly one command', async ({ page }) => {
  await page.goto('/test/browser/fixtures/shell-palette.html')
  const trigger = page.getByRole('button', { name: 'Open commands' })
  await trigger.click()
  const search = page.getByRole('combobox', { name: 'Search commands' })
  await expect(search).toBeFocused()
  const modal = page.getByRole('dialog', { name: 'Command palette' })
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab')
    await expect(modal.locator(':focus')).toHaveCount(1)
  }
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(search).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Projects', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('option', { name: 'Models', exact: true })).toHaveAttribute('aria-selected', 'true')
  await search.fill('Settings')
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.waitForFunction(() => document.querySelector('[data-starting-style], [data-ending-style]') === null && document.getAnimations().every(animation => animation.playState !== 'running'))
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])
  await page.keyboard.press('Enter')
  await expect(modal).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveText('Settings selected')
  await expect(page.getByText('Unavailable command executed')).toHaveCount(0)
})

test('Russian palette and its named controls fit a 320px phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/test/browser/fixtures/shell-palette.html?locale=ru')
  await page.getByRole('button', { name: 'Open commands' }).click()
  const modal = page.getByRole('dialog', { name: 'Палитра команд' })
  await expect(modal).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Поиск команд' })).toBeFocused()
  const boxes = await modal.evaluate(node => [node, ...node.querySelectorAll('input,button')].map(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight }
  }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(box.width)
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(box.height)
  }
  await page.getByRole('button', { name: 'Закрыть' }).click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open commands' })).toBeFocused()
})
