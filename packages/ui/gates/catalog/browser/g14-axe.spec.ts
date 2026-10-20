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
