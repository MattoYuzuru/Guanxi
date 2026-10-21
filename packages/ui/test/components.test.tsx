import { render, screen } from '@testing-library/react'
import { Settings } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { Button, IconButton, ProvenanceLabel, StatusPill, UiLocaleProvider } from '../src/index.ts'
import { en, ru } from '../src/i18n/messages.ts'
import { PSEUDO_EXPANSION, pseudoLocalize } from '../src/i18n/pseudo.ts'
import { msg, resolveMessages } from '../src/story-kit/index.tsx'
import { translateUi } from '../src/i18n/context.tsx'

describe('messages', () => {
  it('has a curated Russian string for every English key', () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(ru[key], key).toBeTruthy()
    }
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
  })

  it('pseudo-localizes with at least +40% length and keeps placeholders', () => {
    for (const value of Object.values(en)) {
      const pseudo = pseudoLocalize(value)
      expect(pseudo.length).toBeGreaterThanOrEqual(Math.ceil(value.length * (1 + PSEUDO_EXPANSION)))
      for (const placeholder of value.match(/\{\w+\}/g) ?? []) expect(pseudo).toContain(placeholder)
    }
  })

  it('resolves message markers in story args, but not inside React elements', () => {
    const t = (key: keyof typeof en) => translateUi('ru', key)
    const element = <span>{msg('story.button.label')}</span>
    const resolved = resolveMessages({ children: msg('story.button.label'), list: [msg('ui.status.running')], element }, t)
    expect(resolved.children).toBe(ru['story.button.label'])
    expect(resolved.list).toEqual([ru['ui.status.running']])
    expect(resolved.element).toBe(element)
  })
})

describe('primitives', () => {
  it('keeps a loading button focusable and busy, with visible text', () => {
    render(
      <Button loading loadingLabel="Saving">
        Save
      </Button>,
    )
    const button = screen.getByRole('button', { name: /Saving/ })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.getAttribute('tabindex')).not.toBe('-1')
    expect(button.querySelector('.gx-spinner')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('names an icon button with its label and hides the icon', () => {
    render(<IconButton label="Open settings" icon={<Settings />} />)
    const button = screen.getByRole('button', { name: 'Open settings' })
    expect(button.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('patterns', () => {
  it('labels every run status in words, with the dot hidden', () => {
    const { container } = render(
      <UiLocaleProvider locale="ru">
        {(['running', 'waiting', 'hibernating', 'finished', 'error', 'unknown'] as const).map((status) => (
          <StatusPill key={status} status={status} />
        ))}
      </UiLocaleProvider>,
    )
    expect(container.textContent).toBe(
      [ru['ui.status.running'], ru['ui.status.waiting'], ru['ui.status.hibernating'], ru['ui.status.finished'], ru['ui.status.error'], ru['ui.status.unknown']].join(''),
    )
    for (const dot of container.querySelectorAll('.gx-status-dot')) expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders an unknown value as Unknown with its source, never as zero', () => {
    const { container } = render(<ProvenanceLabel source="model metadata" observedAt={null} />)
    expect(container.textContent).toBe('Unknown · would come from model metadata')
    expect(container.textContent).not.toMatch(/\b0\b/)
  })

  it('shows source and age, switches to "as of" when old, and marks estimates', () => {
    const now = '2026-10-20T14:08:00.000Z'
    const fresh = render(<ProvenanceLabel source="ollama /api/ps" observedAt="2026-10-20T14:07:48.000Z" now={now} />)
    expect(fresh.container.textContent).toBe('ollama /api/ps · 12 sec. ago')
    fresh.unmount()
    const aged = render(<ProvenanceLabel source="node" observedAt="2026-10-20T14:02:00.000Z" now={now} estimated />)
    expect(aged.container.textContent).toMatch(/^node · as of .+, 6 min\. agoestimated$/)
    expect(aged.container.querySelector('[data-state="aged"]')).not.toBeNull()
  })
})
