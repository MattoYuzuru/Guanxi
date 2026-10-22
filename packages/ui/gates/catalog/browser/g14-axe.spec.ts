/** G14 Accessibility: no serious or critical axe violation in any story, light and dark. */
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { gateStories, openStory } from './stories.ts'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/**
 * Library behaviour axe reads as `aria-hidden-focus`, accepted node by node (never a whole rule):
 * - Base UI focus guards are empty aria-hidden sentinels that hand focus on as soon as they get it;
 * - Base UI hides a high-priority toast from the accessibility tree until it is focused (its text
 *   is announced through the viewport's live region) and removes `aria-hidden` on focus.
 */
const ACCEPTED: Array<{ rule: string; target: RegExp; html: RegExp; reason: string }> = [
  { rule: 'aria-hidden-focus', target: /data-base-ui-focus-guard/, html: /data-base-ui-focus-guard/, reason: 'Base UI focus guard' },
  {
    rule: 'aria-hidden-focus',
    target: /^\.gx-toast$/,
    html: /role="alertdialog"/,
    reason: 'high-priority toast, aria-hidden until focused',
  },
]

function accepted(rule: string, target: string, html: string): boolean {
  return ACCEPTED.some((item) => item.rule === rule && item.target.test(target) && item.html.test(html))
}

async function blocking(page: import('@playwright/test').Page, include: string): Promise<string[]> {
  const results = await new AxeBuilder({ page }).include(include).withTags(TAGS).analyze()
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter((node) => !accepted(violation.id, node.target.join(' '), node.html)),
    }))
    .filter((violation) => violation.nodes.length > 0)
    .map((violation) => `${violation.impact} ${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
}

const stories = gateStories()

for (const story of stories) {
  // Primitives in all four themes (high contrast included); patterns in light and dark.
  const themes = story.level === 'primitive' ? ['light', 'dark', 'light-hc', 'dark-hc'] : ['light', 'dark']
  for (const theme of themes) {
    test(`G14 ${story.key} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openStory(page, story.key, { theme, motion: 'reduced' })
      expect(await blocking(page, '[data-gx-regime]'), `axe violations in ${story.key} (${theme})`).toEqual([])
    })
  }
}

// The catalog chrome itself (toolbar, navigation, overview) in light and dark.
if (process.env['GUANXI_GATE_FIXTURES'] !== '1' && stories.length > 1) {
  for (const theme of ['light', 'dark']) {
    test(`G14 catalog chrome ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(`/index.html?mode=catalog&theme=${theme}&motion=reduced`)
      await page.locator('.gx-catalog-layout').waitFor()
      await page.locator('[data-story]').first().waitFor()
      expect(await blocking(page, '.gx-catalog'), `axe violations in the catalog chrome (${theme})`).toEqual([])
    })
  }
}

/**
 * The phone story is rendered inside the catalog harness, whose cell reserves a 16 px gutter on
 * each side. Give only its synthetic host wrapper the width left by a 390 px viewport after those
 * gutters, then measure the real shell. This is deliberately not a CSS/jsdom assertion: it fails
 * in Chromium while the sidebar's 1 px glass border sits outside its 18 rem/100% content width.
 */
const PHONE_VIEWPORT = { width: 390, height: 844 } as const
const PHONE_RIGHT_GUTTER = 16
const phoneStory = stories.find((story) => story.key === 'app-shell-chrome--phone')

if (phoneStory) {
  const phoneKey = phoneStory.key
  for (const theme of ['light', 'dark']) {
    test(`G14 ${phoneKey} geometry ${theme}`, async ({ page }) => {
      await page.setViewportSize(PHONE_VIEWPORT)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openStory(page, phoneKey, { theme, motion: 'reduced' })

      const host = page.locator(`[data-harness-story="${phoneKey}"] .gx-story-root > div`)
      await expect(host).toHaveCount(1)
      const availableWidth = await host.evaluate((element, rightGutter) => {
        const leftGutter = element.getBoundingClientRect().left
        return Math.floor(window.innerWidth - leftGutter - rightGutter)
      }, PHONE_RIGHT_GUTTER)

      expect(availableWidth, 'positive synthetic host width').toBeGreaterThan(0)
      await host.evaluate((element, width) => {
        ;(element as HTMLElement).style.width = `${width}px`
      }, availableWidth)
      await page.waitForFunction(
        ({ key, width }) => {
          const wrapper = document.querySelector(`[data-harness-story="${key}"] .gx-story-root > div`)
          return wrapper !== null && Math.abs(wrapper.getBoundingClientRect().width - width) < 1
        },
        { key: phoneKey, width: availableWidth },
      )

      const geometry = await page.evaluate(() => {
        const cell = document.querySelector('[data-harness-story="app-shell-chrome--phone"]')
        if (!cell) throw new Error('app-shell-chrome--phone harness cell is missing')
        const host = cell.querySelector('.gx-story-root > div')
        const shell = document.querySelector('[data-slot="app-shell-chrome"]')
        const body = document.querySelector('[data-slot="app-shell-body"]')
        const sidebar = document.querySelector('[data-slot="app-shell-sidebar"]')
        const main = document.querySelector('[data-slot="app-shell-main"]')
        if (!host || !shell || !body || !sidebar || !main) throw new Error('app-shell-chrome phone geometry is missing')
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect()
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            height: box.height,
          }
        }
        return {
          host: rect(host),
          shell: rect(shell),
          bodyFlexDirection: getComputedStyle(body).flexDirection,
          sidebar: rect(sidebar),
          main: rect(main),
        }
      })

      expect(geometry.host.width, 'positive host width').toBeGreaterThan(0)
      expect(geometry.host.width).toBeCloseTo(availableWidth, 1)
      expect(geometry.shell.width).toBeCloseTo(geometry.host.width, 1)
      // The bordered sidebar owns the whole shell width, so both its edges are the shell's.
      expect(geometry.sidebar.left).toBeCloseTo(geometry.shell.left, 1)
      expect(geometry.sidebar.right).toBeCloseTo(geometry.shell.right, 1)
      expect(geometry.sidebar.width).toBeCloseTo(geometry.shell.width, 1)
      expect(geometry.sidebar.left).toBeGreaterThanOrEqual(geometry.shell.left - 0.5)
      expect(geometry.sidebar.right).toBeLessThanOrEqual(geometry.shell.right + 0.5)
      expect(geometry.main.left).toBeGreaterThanOrEqual(geometry.shell.left - 0.5)
      expect(geometry.main.right).toBeLessThanOrEqual(geometry.shell.right + 0.5)
      // At the phone breakpoint the body is a column and the sidebar precedes main.
      expect(geometry.bodyFlexDirection).toBe('column')
      expect(geometry.main.left).toBeCloseTo(geometry.sidebar.left, 1)
      expect(geometry.main.top).toBeGreaterThanOrEqual(geometry.sidebar.bottom - 0.5)
    })
  }
}
