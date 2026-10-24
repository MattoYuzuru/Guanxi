import { describe, expect, it, vi } from 'vitest'
import { gateStoredPanels, type SessionPanels } from '../../src/features/session/panels.ts'

const stored = (): SessionPanels => ({ open: ['context', 'terminal'], active: 'context', toggle: vi.fn(), show: vi.fn() })

describe('stored session panels in a narrow session (round 4 review 4)', () => {
  it('read as closed until a user action, which is reported and still reaches the store', () => {
    const panels = stored(), opened = vi.fn()
    const gated = gateStoredPanels(panels, true, opened)
    expect(gated.open).toEqual([])
    expect(gated.active).toBeNull()
    gated.toggle('plan', true)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(panels.toggle).toHaveBeenCalledWith('plan', true)
  })

  it('pass through unchanged when not suppressed (a wide session)', () => {
    const panels = stored()
    const gated = gateStoredPanels(panels, false)
    expect(gated.open).toEqual(['context', 'terminal'])
    expect(gated.active).toBe('context')
  })
})
