/**
 * Text on component surfaces that the G3 manifest cannot express for every theme: in light and
 * dark the secondary tone on the pressed track (SegmentedControl labels) and on the tertiary fill
 * (neutral Badge) keeps 4.5:1; high-contrast themes switch those surfaces to the pane (CSS).
 */
import Color from 'colorjs.io'
import { describe, expect, it } from 'vitest'
import flat from '../generated/tokens.flat.json'

const tokens = flat as Record<string, Array<{ name: string; $value: { hex?: string } }>>
const hex = (context: string, name: string) => tokens[context]!.find(token => token.name === name)!.$value.hex!

describe('surface contrast', () => {
  for (const context of ['light/compact/full', 'dark/compact/full']) {
    it(`secondary text on pressed and tertiary fills keeps 4.5:1 (${context})`, () => {
      for (const surface of ['color.background.pressed', 'color.background.tertiary']) {
        const ratio = new Color(hex(context, 'color.text.secondary')).contrast(new Color(hex(context, surface)), 'WCAG21')
        expect(ratio, surface).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})
