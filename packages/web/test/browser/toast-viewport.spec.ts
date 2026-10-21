/**
 * GPT N7: the toast viewport stays inside the window on a phone-width screen, with its normal
 * document-body portal, and keeps its token gutters and maximum width on a desktop screen.
 */
import { expect, test, type Page } from '@playwright/test'

async function rects(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/test/browser/fixtures/toast-viewport.html')
  await expect(page.locator('.gx-toast')).toHaveCount(1)
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
    }
    return {
      window: document.documentElement.clientWidth,
      portalledToBody: document.querySelector('.gx-toast-viewport')!.closest('#root') === null,
      viewport: box('.gx-toast-viewport'),
      toast: box('.gx-toast'),
      action: box('.gx-toast-action'),
      close: box('.gx-toast [data-variant="ghost"]'),
      gutter: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing-16')),
    }
  })
}

test('at 320 px the toast, its action and its close button stay inside both window edges', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  const r = await rects(page)
  expect(r.portalledToBody).toBe(true)
  for (const [name, rect] of Object.entries({ viewport: r.viewport, toast: r.toast, action: r.action, close: r.close })) {
    expect(rect.left, `${name} left`).toBeGreaterThanOrEqual(r.gutter)
    expect(rect.right, `${name} right`).toBeLessThanOrEqual(r.window - r.gutter)
  }
})

test('on a desktop the viewport keeps its right gutter and the container width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const r = await rects(page)
  expect(r.viewport.right).toBe(r.window - r.gutter)
  expect(r.viewport.width).toBe(384)
})
