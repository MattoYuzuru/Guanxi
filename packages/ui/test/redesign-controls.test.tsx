import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Composer, domainIconNames, Icon, iconNames, Kbd, SegmentedControl, StatusItem } from '../src/index.ts'

describe('Icon', () => {
  it('is decorative by default and named when labelled', () => {
    const { container } = render(<><Icon name="memory-unified" /><Icon name="inbox" label="Inbox" /></>)
    const [decorative] = container.querySelectorAll('svg')
    expect(decorative?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('img', { name: 'Inbox' })).toBeTruthy()
  })

  it('keeps a constant 1.75 px stroke at every size, Guanxi glyphs included', () => {
    for (const name of domainIconNames) {
      for (const size of [12, 16, 24] as const) {
        const { container, unmount } = render(<Icon name={name} size={size} />)
        const svg = container.querySelector('svg')!
        expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
        expect(Number(svg.getAttribute('stroke-width')) * size / 24).toBeCloseTo(1.75)
        unmount()
      }
    }
    expect(new Set(iconNames).size).toBe(iconNames.length)
    expect(domainIconNames.every(name => iconNames.includes(name))).toBe(true)
  })
})

describe('Kbd', () => {
  it('renders one nested key per entry', () => {
    const { container } = render(<Kbd keys={['⌘', 'K']} />)
    expect(container.querySelectorAll('kbd.gx-kbd-key')).toHaveLength(2)
  })
})

describe('SegmentedControl', () => {
  function Harness({ iconOnly = false }: { iconOnly?: boolean }) {
    const [value, setValue] = useState<'compact' | 'comfortable'>('compact')
    return <SegmentedControl label="Density" value={value} onValueChange={setValue} iconOnly={iconOnly}
      options={[{ value: 'compact', label: 'Compact', icon: 'density-compact' }, { value: 'comfortable', label: 'Comfortable', icon: 'density-comfortable' }]} />
  }

  it('is a named radio group with exactly one checked segment', () => {
    render(<Harness />)
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios.filter(radio => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }))
    expect(screen.getByRole('radio', { name: 'Comfortable' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByRole('radio').filter(radio => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  })

  it('names icon-only segments by their label and shows no visible text', () => {
    const { container } = render(<Harness iconOnly />)
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeTruthy()
    expect(container.querySelector('.gx-segmented-item span')).toBeNull()
  })
})

describe('StatusItem', () => {
  it('names the trigger with label and value, and reveals facts on click', () => {
    render(<StatusItem icon="memory-unified" label="Memory" value="16.8 GB"><p>Total 24 GB</p></StatusItem>)
    const trigger = screen.getByRole('button', { name: 'Memory: 16.8 GB' })
    expect(screen.queryByText('Total 24 GB')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByText('Total 24 GB')).toBeTruthy()
  })

  it('renders unknown as "Unknown", never as zero', () => {
    render(<StatusItem icon="quota" label="Quota" tone="unknown" />)
    const trigger = screen.getByRole('button', { name: 'Quota: Unknown' })
    expect(trigger.textContent).not.toMatch(/0/)
    fireEvent.click(trigger)
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
  })

  it('caps the count badge and hides it from assistive technology', () => {
    const { container } = render(<StatusItem icon="inbox" label="Inbox" badge={120} />)
    const badge = container.querySelector('.gx-icon-button-badge')!
    expect(badge.textContent).toBe('99+')
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    render(<StatusItem icon="inbox" label="Inbox zero" badge={0} />)
    expect(container.ownerDocument.querySelectorAll('.gx-icon-button-badge')).toHaveLength(1)
  })
})

describe('Composer', () => {
  function Harness(props: { running?: boolean; onSend?: () => void; onStop?: () => void; sendDisabled?: boolean }) {
    const [value, setValue] = useState('')
    return <Composer label="Message" value={value} onValueChange={setValue} onSend={props.onSend ?? (() => setValue(''))}
      onStop={props.onStop} running={props.running} sendDisabled={props.sendDisabled} />
  }

  it('sends on Enter, adds a line on Shift+Enter and never sends while composing', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const area = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.keyDown(area, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled() // empty prompt
    fireEvent.change(area, { target: { value: 'Fix the build' } })
    fireEvent.keyDown(area, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(area, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(area, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(area, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('keeps Send focusable but inert while blocked, and swaps to Stop while running', () => {
    const onSend = vi.fn(), onStop = vi.fn()
    const { rerender } = render(<Harness onSend={onSend} sendDisabled />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'go' } })
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send.getAttribute('tabindex')).not.toBe('-1')
    fireEvent.click(send)
    expect(onSend).not.toHaveBeenCalled()
    rerender(<Harness onSend={onSend} onStop={onStop} running />)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
