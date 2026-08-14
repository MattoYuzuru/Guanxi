import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../src/components/ErrorBoundary.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

function BrokenChat(): never {
  throw new TypeError('render exploded')
}

describe('ErrorBoundary', () => {
  it('contains a Chat render error with focused, navigable diagnostics', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <ErrorBoundary scope="chat">
        <BrokenChat />
      </ErrorBoundary>,
    )

    const alert = screen.getByRole('alert')
    const title = screen.getByRole('heading', { name: 'Не удалось показать чат' })

    expect(alert.contains(title)).toBe(true)
    expect(title).toBe(document.activeElement)
    expect(screen.getByRole('button', { name: 'Перезагрузить' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'К чатам' }).getAttribute('href')).toBe('/chat')
    expect(screen.getByRole('link', { name: 'К моделям' }).getAttribute('href')).toBe('/')
    expect(
      screen.getAllByText('ui-00000000-0000-4000-8000-000000000001'),
    ).toHaveLength(2)

    const diagnostics = screen.getByText('Диагностические сведения')
    diagnostics.click()

    expect(screen.getByText('/')).toBeTruthy()
    expect(screen.getByText('TypeError: render exploded')).toBeTruthy()
    expect(screen.getByText('BrokenChat', { exact: false })).toBeTruthy()
  })

  it('uses English as the fallback locale', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setActiveLocale('en')

    render(
      <ErrorBoundary scope="root">
        <BrokenChat />
      </ErrorBoundary>,
    )

    expect(
      screen.getByRole('heading', { name: 'The application could not be displayed' }),
    ).toBeTruthy()

    setActiveLocale('ru')
  })

  it('contains a Runtime Bar render failure without replacing or refocusing the shell', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <>
        <button type="button" autoFocus>Shell navigation</button>
        <ErrorBoundary scope="runtime">
          <BrokenChat />
        </ErrorBoundary>
      </>,
    )

    const shell = screen.getByRole('button', { name: 'Shell navigation' })
    expect(shell).toBe(document.activeElement)
    expect(screen.getByRole('heading', { name: 'Не удалось показать состояние runtime' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'К моделям' })).toBeTruthy()
  })
})
