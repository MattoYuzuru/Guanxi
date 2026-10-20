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
const ACCEPTED: Array<{ rule: string; target: RegExp; reason: string }> = [
  { rule: 'aria-hidden-focus', target: /data-base-ui-focus-guard/, reason: 'Base UI focus guard' },
  { rule: 'aria-hidden-focus', target: /^\.gx-toast$/, reason: 'high-priority toast, aria-hidden until focused' },
]

function accepted(rule: string, target: string): boolean {
  return ACCEPTED.some((item) => item.rule === rule && item.target.test(target))
}

for (const story of gateStories()) {
  for (const theme of ['light', 'dark']) {
    test(`G14 ${story.key} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openStory(page, story.key, { theme, motion: 'reduced' })
      const results = await new AxeBuilder({ page }).include('[data-gx-regime]').withTags(TAGS).analyze()
      const blocking = results.violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => ({
          ...violation,
          nodes: violation.nodes.filter((node) => !accepted(violation.id, node.target.join(' '))),
        }))
        .filter((violation) => violation.nodes.length > 0)
        .map((violation) => `${violation.impact} ${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
      expect(blocking, `axe violations in ${story.key} (${theme})`).toEqual([])
    })
  }
}
