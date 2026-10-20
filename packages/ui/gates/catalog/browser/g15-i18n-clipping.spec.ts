/**
 * G15 i18n, browser part: no story clips its text in Russian or in the +40% pseudo-locale.
 * Clipped means a visible element that hides overflow (or ellipsizes) holds text wider or
 * taller than its box; screen-reader-only boxes (1 px) are hidden on purpose and skipped.
 */
import { expect, test } from '@playwright/test'
import { gateStories, openStory } from './stories.ts'

for (const story of gateStories()) {
  for (const locale of ['ru', 'pseudo']) {
    test(`G15 ${story.key} ${locale}`, async ({ page }) => {
      await openStory(page, story.key, { locale, motion: 'reduced' })
      const clipped = await page.evaluate(() => {
        const root = document.querySelector('[data-gx-regime]')
        if (!root) return ['no regime frame']
        const found: string[] = []
        for (const element of root.querySelectorAll<HTMLElement>('*')) {
          const style = getComputedStyle(element)
          const hides = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY)
          if (!hides || style.display === 'contents') continue
          // Screen-reader-only text (1 px boxes, live regions) is hidden on purpose, not clipped.
          if (element.clientWidth <= 1 || element.clientHeight <= 1) continue
          const text = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && /\p{L}/u.test(node.textContent ?? ''))
          const nestedText = text || /\p{L}/u.test(element.innerText ?? '')
          if (!nestedText) continue
          if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
            found.push(`${element.tagName.toLowerCase()}.${element.className} (${element.scrollWidth}×${element.scrollHeight} in ${element.clientWidth}×${element.clientHeight})`)
          }
        }
        return found
      })
      expect(clipped, `clipped text in ${story.key} (${locale})`).toEqual([])
    })
  }
}
