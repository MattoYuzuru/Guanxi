/**
 * G16 Reduced motion: no story keeps a looping animation or moves an element (transform,
 * translate, scale or rotate that changes) when reduced motion comes from the OS alone (the
 * catalog's `system` setting) or from the in-app setting alone (`data-motion=reduced`).
 *
 * Motion is recorded as it starts, not after it settles: an init script, installed before the
 * page runs, records every CSS animation and transition (`animationstart`, `transitionrun`) and
 * every `Element.animate` call with its keyframes. The story is opened without the settle step,
 * then driven by keyboard (Tab through it, Space on switches, checkboxes, radios, tabs and
 * toggle buttons), so entry motion and interaction motion are both seen, however short.
 */
import { expect, test, type Page } from '@playwright/test'
import { gateStories, openStory } from './stories.ts'

const SOURCES = [
  { name: 'os', media: 'reduce' as const, motion: 'system' },
  { name: 'setting', media: 'no-preference' as const, motion: 'reduced' },
]

/** Keyboard steps per story: enough to reach every control in a catalog story. */
const MAX_TABS = 24

interface MotionRecord {
  name: string
  loops: boolean
  frames: Array<Record<string, unknown>>
}

declare global {
  interface Window {
    __G16_MOTION__?: MotionRecord[]
  }
}

function recordMotion(): void {
  const records: MotionRecord[] = []
  window.__G16_MOTION__ = records
  const describe = (target: Element | null, what: string) =>
    `${target?.tagName.toLowerCase() ?? '?'}.${typeof target?.className === 'string' ? target.className : ''} ${what}`
  const add = (animation: Animation, what: string) => {
    const effect = animation.effect as KeyframeEffect | null
    if (!effect) return
    records.push({
      name: describe(effect.target as Element | null, what),
      loops: effect.getComputedTiming().iterations === Infinity,
      frames: effect.getKeyframes().map((frame) => ({ ...frame })),
    })
  }
  const seen = new WeakSet<Animation>()
  const capture = (event: Event, match: (animation: Animation) => boolean, what: string) => {
    const target = event.target as Element | null
    if (!target?.getAnimations) return
    for (const animation of target.getAnimations()) {
      if (seen.has(animation) || !match(animation)) continue
      seen.add(animation)
      add(animation, what)
    }
  }
  document.addEventListener(
    'animationstart',
    (event) => {
      const name = (event as AnimationEvent).animationName
      capture(event, (animation) => (animation as CSSAnimation).animationName === name, name)
    },
    true,
  )
  document.addEventListener(
    'transitionrun',
    (event) => {
      const property = (event as TransitionEvent).propertyName
      capture(event, (animation) => (animation as CSSTransition).transitionProperty === property, property)
    },
    true,
  )
  const animate = Element.prototype.animate
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
    const animation = animate.apply(this, args)
    seen.add(animation)
    add(animation, 'animate()')
    return animation
  }
}

/** Tab through the story, pressing Space on controls that toggle state. */
async function exercise(page: Page): Promise<void> {
  for (let step = 0; step < MAX_TABS; step += 1) {
    await page.keyboard.press('Tab')
    const toggles = await page.evaluate(() => {
      const active = document.activeElement
      if (!active || !active.closest('[data-gx-regime]')) return null
      const role = active.getAttribute('role') ?? (active instanceof HTMLInputElement ? active.type : '')
      return ['switch', 'checkbox', 'radio', 'tab'].includes(role) || active.hasAttribute('aria-pressed')
    })
    if (toggles === null) break
    if (toggles) await page.keyboard.press('Space')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
}

const IDENTITY = /^(none|translate[XY]?\(0(px)?(, ?0(px)?)?\)|scale\(1\)|rotate\(0(deg|turn)?\)|matrix\(1, 0, 0, 1, 0, 0\))$/

function violations(records: MotionRecord[]): string[] {
  const found = new Set<string>()
  for (const record of records) {
    if (record.loops) {
      found.add(`loops: ${record.name}`)
      continue
    }
    for (const property of ['transform', 'translate', 'scale', 'rotate']) {
      const values = new Set(record.frames.map((frame) => frame[property]).filter((value) => value !== undefined && value !== null).map(String))
      if (values.size > 1 && ![...values].every((value) => IDENTITY.test(value))) {
        found.add(`moves ${property}: ${record.name} ${[...values].join(' → ')}`)
      }
    }
  }
  return [...found]
}

for (const story of gateStories()) for (const source of SOURCES) {
  test(`G16 ${story.key} ${source.name}`, async ({ page }) => {
    await page.addInitScript(recordMotion)
    await page.emulateMedia({ reducedMotion: source.media })
    await openStory(page, story.key, { motion: source.motion }, { settle: false })
    await exercise(page)
    // Animations still running at the end, recorded or not (a loop that started before load).
    const records = await page.evaluate(() => {
      const running = document.getAnimations().filter((animation) => animation.playState === 'running')
      const live = running.map((animation) => {
        const effect = animation.effect as KeyframeEffect | null
        const target = effect?.target as Element | null
        return {
          name: `${target?.tagName.toLowerCase() ?? '?'}.${typeof target?.className === 'string' ? target.className : ''} ${(animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? ''}`,
          loops: effect?.getComputedTiming().iterations === Infinity,
          frames: effect?.getKeyframes().map((frame) => ({ ...frame })) ?? [],
        }
      })
      return [...(window.__G16_MOTION__ ?? []), ...live]
    })
    expect(violations(records), `motion under reduced motion in ${story.key}`).toEqual([])
  })
}
