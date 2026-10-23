/** D-206: Max graphics keeps chrome text readable and steps aside whenever the user asks for less. */
import Color from 'colorjs.io'
import { describe, expect, it } from 'vitest'
import flat from '../../../ui/generated/tokens.flat.json'
import { graphicsSuppressed, MAX_GRAPHICS_STRENGTH, worstFieldColor } from '../../src/features/shell/MaxGraphics.tsx'

const tokens = flat as Record<string, Array<{ name: string; $value: { hex?: string } }>>
const hex = (context: string, name: string) => tokens[context]!.find(token => token.name === name)!.$value.hex!
const rgb = (value: string) => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
const toHex = (value: number[]) => `#${value.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`
const contrast = (a: string, b: string) => new Color(a).contrast(new Color(b), 'WCAG21')

describe('Max graphics contrast', () => {
  for (const [context, dark] of [['light/compact/full', false], ['dark/compact/full', true]] as const) {
    it(`keeps secondary chrome text at 4.5:1 and primary at 7:1 over the field's worst colour (${context})`, () => {
      const field = toHex(worstFieldColor(rgb(hex(context, 'color.background.primary')), rgb(hex(context, 'color.background.accent')),
        rgb(hex(context, dark ? 'color.background.pressed' : 'color.background.secondary')), dark))
      expect(contrast(hex(context, 'color.text.secondary'), field)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(hex(context, 'color.text.primary'), field)).toBeGreaterThanOrEqual(7)
    })
  }
  it('fails the check when the strength is pushed too far (the assertion can fail)', () => {
    const base = rgb(hex('light/compact/full', 'color.background.primary')), accent = rgb(hex('light/compact/full', 'color.background.accent'))
    const tooStrong = toHex(base.map((value, index) => value * 0.4 + accent[index]! * 0.6))
    expect(contrast(hex('light/compact/full', 'color.text.secondary'), tooStrong)).toBeLessThan(4.5)
    expect(MAX_GRAPHICS_STRENGTH.light).toBeLessThan(0.6)
  })
})

describe('graphicsSuppressed', () => {
  it('steps aside for in-app reduced motion, reduced transparency, battery saver, GPU off and high contrast', () => {
    const cases: Array<[string, string]> = [['motion', 'reduced'], ['reduceTransparency', ''], ['batterySaver', ''], ['gpuCompositing', 'off'], ['theme', 'dark-hc']]
    for (const [key, value] of cases) {
      const root = document.createElement('div')
      root.dataset[key] = value
      expect(graphicsSuppressed(root), key).toBe(true)
    }
    expect(graphicsSuppressed(document.createElement('div'))).toBe(false)
  })
})
