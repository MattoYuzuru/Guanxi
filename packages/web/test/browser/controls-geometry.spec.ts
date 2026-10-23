/**
 * D-200 pixel checks on the real controls: the switch knob is centred in its track in both
 * states, icon glyphs sit on the exact centre of icon buttons and status items, and segmented
 * segments share one height. Measured from layout boxes in both themes and densities.
 */
import { expect, test, type Locator } from '@playwright/test'

const fixture = '/test/browser/fixtures/controls-geometry.html'
const box = async (locator: Locator) => {
  const value = await locator.boundingBox()
  if (!value) throw new Error('element has no box')
  return value
}
/** Inner (content+padding) box of the track: the border is not part of the knob's travel. */
async function trackInner(track: Locator) {
  return track.evaluate(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    const border = (side: string) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`))
    return { left: rect.left + border('left'), right: rect.right - border('right'), top: rect.top + border('top'), bottom: rect.bottom - border('bottom') }
  })
}

for (const theme of ['light', 'dark']) for (const density of ['compact', 'comfortable']) {
  test(`switch knob is centred in both states (${theme}, ${density})`, async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}&density=${density}`)
    for (const id of ['switch-off', 'switch-on']) {
      const track = page.getByTestId(id)
      const inner = await trackInner(track)
      const knob = await box(track.locator('.gx-switch-thumb'))
      // Vertical: equal gaps above and below.
      expect(Math.abs((knob.y - inner.top) - (inner.bottom - (knob.y + knob.height)))).toBeLessThanOrEqual(0.5)
      // Horizontal: the knob rests against the padding edge on its side, with the same gap.
      const leading = knob.x - inner.left, trailing = inner.right - (knob.x + knob.width)
      const gap = id === 'switch-off' ? leading : trailing
      expect(gap).toBeGreaterThan(0)
      expect(Math.abs(gap - (inner.bottom - (knob.y + knob.height)))).toBeLessThanOrEqual(0.5)
    }
    // Both states use the same gap, so the knob travel is symmetric.
    const offInner = await trackInner(page.getByTestId('switch-off')), onInner = await trackInner(page.getByTestId('switch-on'))
    const offKnob = await box(page.getByTestId('switch-off').locator('.gx-switch-thumb'))
    const onKnob = await box(page.getByTestId('switch-on').locator('.gx-switch-thumb'))
    expect(Math.abs((offKnob.x - offInner.left) - (onInner.right - (onKnob.x + onKnob.width)))).toBeLessThanOrEqual(0.5)
  })

  test(`icons sit on the exact centre of icon controls (${theme}, ${density})`, async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}&density=${density}`)
    for (const target of [page.getByTestId('icon-sm'), page.getByTestId('icon-md'), page.getByTestId('status-icon').getByRole('button')]) {
      const button = await box(target)
      const glyph = await box(target.locator('svg').first())
      expect(Math.abs((glyph.x + glyph.width / 2) - (button.x + button.width / 2))).toBeLessThanOrEqual(0.5)
      expect(Math.abs((glyph.y + glyph.height / 2) - (button.y + button.height / 2))).toBeLessThanOrEqual(0.5)
      expect(button.width).toBeGreaterThanOrEqual(24)
      expect(button.height).toBeGreaterThanOrEqual(24)
    }
  })
}

test('segmented control segments share one height and one checked segment', async ({ page }) => {
  await page.goto(fixture)
  const radios = page.getByRole('radio')
  await expect(radios).toHaveCount(2)
  const [first, second] = [await box(radios.nth(0)), await box(radios.nth(1))]
  expect(first.height).toBe(second.height)
  expect(first.y).toBe(second.y)
  await radios.nth(1).click()
  await expect(page.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1)
})

test('composer send button sits inside the card at its lower right', async ({ page }) => {
  await page.goto(fixture)
  const card = await box(page.locator('[data-slot="composer"]'))
  const send = await box(page.getByRole('button', { name: 'Send' }))
  expect(send.x + send.width).toBeLessThanOrEqual(card.x + card.width)
  expect(send.y + send.height).toBeLessThanOrEqual(card.y + card.height)
  expect(send.x).toBeGreaterThan(card.x + card.width / 2)
})
