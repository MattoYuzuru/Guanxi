/**
 * G16 Reduced motion: under the OS setting and `data-motion=reduced`, no story keeps a looping
 * animation or moves an element (transform, translate, scale or rotate that changes).
 */
import { expect, test } from '@playwright/test'
import { gateStories, openStory } from './stories.ts'

for (const story of gateStories()) {
  test(`G16 ${story.key}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openStory(page, story.key, { motion: 'reduced' })
    const moving = await page.evaluate(() => {
      const spatial = ['transform', 'translate', 'scale', 'rotate']
      const found: string[] = []
      for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running') continue
        const effect = animation.effect as KeyframeEffect | null
        const target = effect?.target as Element | null
        const name = `${target?.tagName.toLowerCase() ?? '?'}.${target?.className ?? ''} ${(animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? ''}`
        if (effect?.getComputedTiming().iterations === Infinity) {
          found.push(`loops: ${name}`)
          continue
        }
        const frames = effect?.getKeyframes() ?? []
        for (const property of spatial) {
          const values = new Set(frames.map((frame) => frame[property]).filter((value) => value !== undefined && value !== null))
          if (values.size > 1 && ![...values].every((value) => /^(none|translate[XY]?\(0(px)?(, ?0(px)?)?\)|scale\(1\)|rotate\(0(deg|turn)?\)|matrix\(1, 0, 0, 1, 0, 0\))$/.test(String(value)))) {
            found.push(`moves ${property}: ${name} ${[...values].join(' → ')}`)
          }
        }
      }
      return found
    })
    expect(moving, `motion under reduced motion in ${story.key}`).toEqual([])
  })
}
