/**
 * G13 Visual regression: every story in light and dark (and both high-contrast themes for
 * primitives) matches its baseline. Baselines are produced and compared only inside the
 * pinned Playwright image (see gates.ts); the runner refuses to run this spec elsewhere.
 */
import { expect, test } from '@playwright/test'
import { gateStories, openStory } from './stories.ts'

if (process.env['GUANXI_GATE_DOCKER'] !== '1') {
  throw new Error('G13 runs only inside the pinned Playwright image (GUANXI_GATE_DOCKER=1)')
}

for (const story of gateStories()) {
  const themes = story.level === 'primitive' ? ['light', 'dark', 'light-hc', 'dark-hc'] : ['light', 'dark']
  for (const theme of themes) {
    test(`G13 ${story.key} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openStory(page, story.key, { theme, motion: 'reduced' })
      // snapshots/<component>/<state>-<theme>.png; the approval binds these files' hashes.
      await expect(page).toHaveScreenshot([story.component, `${story.state}-${theme}.png`], { fullPage: false })
    })
  }
}
