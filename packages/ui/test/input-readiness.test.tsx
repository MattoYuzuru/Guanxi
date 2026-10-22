import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UiLocaleProvider } from '../src/index.ts'
import { Invalid } from '../src/components/input/input.stories.tsx'

for (const locale of ['en', 'ru'] as const) describe(`Input invalid story (${locale})`, () => {
  it('names the invalid field and links a visible error, so color is not the sole signal', () => {
    render(<UiLocaleProvider locale={locale}>{Invalid.render!({})}</UiLocaleProvider>)
    const input = screen.getByRole('textbox', { name: locale === 'en' ? 'Project name' : 'Название проекта' })
    const message = screen.getByRole('alert')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(message.id)
    expect(message.textContent).toBe(locale === 'en' ? 'A project with this name already exists.' : 'Проект с таким названием уже существует.')
    expect(message.hidden).toBe(false)
  })
})
