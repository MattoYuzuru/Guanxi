/**
 * The story list a browser gate run covers, passed by the runner (JSON in
 * GUANXI_GATE_STORIES), plus helpers to open one story in the harness.
 */
import type { Page } from '@playwright/test'

export interface GateStory {
  key: string
  component: string
  state: string
  level: 'primitive' | 'pattern'
  frame: string
}

export function gateStories(): GateStory[] {
  const raw = process.env['GUANXI_GATE_STORIES']
  if (!raw) throw new Error('GUANXI_GATE_STORIES is not set; run the gate through packages/ui/gates/catalog/run.ts')
  return JSON.parse(raw) as GateStory[]
}

export function storyUrl(key: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ story: key, ...params })
  if (process.env['GUANXI_GATE_FIXTURES'] === '1') search.set('fixtures', '1')
  const seed = process.env['GUANXI_GATE_SEED']
  if (seed) search.set('seed', seed)
  return `/index.html?${search.toString()}`
}

/**
 * Opens a story and waits until it rendered (or failed) and fonts settled. By default it then
 * waits for enter transitions and finite animations to finish, so screenshots are exact; G16
 * passes `settle: false`, because it must see motion before it completes.
 */
export async function openStory(
  page: Page,
  key: string,
  params: Record<string, string> = {},
  options: { settle?: boolean } = {},
): Promise<void> {
  await page.goto(storyUrl(key, params))
  await page.waitForFunction(() => (window as unknown as HarnessWindow).__GUANXI_HARNESS__?.ready === true)
  await page.locator(`[data-harness-story="${key}"], [data-story-error]`).first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  if (await page.locator('[data-story-error]').count()) throw new Error(`story ${key} failed to render`)
  if (options.settle === false) return
  await page.waitForFunction(
    () =>
      document.querySelector('[data-starting-style], [data-ending-style]') === null &&
      document
        .getAnimations()
        .every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity),
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

interface HarnessWindow {
  __GUANXI_HARNESS__?: { ready: boolean }
}
