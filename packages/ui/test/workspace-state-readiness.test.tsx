import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ErrorState, Textarea, UiLocaleProvider, useUiText, WorkspaceChrome } from '../src/index.ts'
import meta, { Invalid } from '../src/components/textarea/textarea.stories.tsx'
import { resolveMessages } from '../src/story-kit/index.tsx'

function InvalidStory() {
  const args = resolveMessages({ ...meta.args, ...Invalid.args }, useUiText())
  return Invalid.render ? Invalid.render(args) : <Textarea {...args} />
}

for (const locale of ['en', 'ru'] as const) describe(`Textarea invalid (${locale})`, () => {
  it('links its named field to one visible localized error', () => {
    render(<UiLocaleProvider locale={locale}><InvalidStory /></UiLocaleProvider>)
    const input = screen.getByRole('textbox', { name: locale === 'en' ? 'Prompt' : 'Запрос' })
    const error = screen.getByRole('alert')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect((input as HTMLTextAreaElement).value).toBe('')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.id).toBeTruthy()
    expect(error.textContent).toBe(locale === 'en' ? 'Enter a description before continuing.' : 'Введите описание, прежде чем продолжить.')
    expect(error.hidden).toBe(false)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})

describe('workspace state composition', () => {
  it('reserves a noninteractive loading skeleton instead of an empty state', () => {
    const { container } = render(<WorkspaceChrome {...{ kind: 'state' as const, title: 'Loading layouts', loading: true }} />)
    expect(screen.getByRole('status').textContent).toBe('Loading layouts')
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="workspace-loading-geometry"][aria-hidden="true"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="empty-state"]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps pane capability descriptions as supporting text', () => {
    const { container } = render(<WorkspaceChrome kind="pane" id="terminal" title="Terminal"
      moveLabel="Move" hideLabel="Hide" onMove={() => {}} onHide={() => {}}
      description="This draft does not execute commands." />)
    expect(screen.getByText('This draft does not execute commands.').tagName).toBe('P')
    expect(container.querySelector('[data-slot="empty-state"]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('preserves legacy error/action props without inventing source or time', () => {
    const { container } = render(<WorkspaceChrome kind="state" title="Legacy error" error
      action={{ label: 'Retry', onClick() {} }} />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(container.querySelector('time')).toBeNull()
    expect(container.querySelector('[data-slot="empty-state"]')).toBeNull()
  })

  it('distinguishes a locally observed error time from an occurrence time', () => {
    const { container } = render(<ErrorState {...{ title: 'Load failed', source: 'GET /api/layouts',
      occurredAt: '2026-10-22T12:00:00.000Z', timeMeaning: 'observed' as const }} />)
    expect(screen.getByRole('alert').textContent).toContain('Observed')
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-22T12:00:00.000Z')
  })
})
