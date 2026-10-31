import { render, screen, within } from '@testing-library/react'
import type { Message } from '@guanxi/contract'
import { describe, expect, it } from 'vitest'
import { MessageView } from '../../src/features/chat/ChatPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

function assistant(overrides: Partial<Message> = {}): Message {
  return {
    id: 'assistant-1',
    threadId: 'thread-1',
    jobId: null,
    role: 'assistant',
    content: '',
    thinking: null,
    toolCalls: [],
    usage: null,
    createdAt: '2026-08-02T12:00:00.000Z',
    isCompaction: false,
    turnStatus: null,
    turnError: null,
    stopReason: null,
    ...overrides,
  }
}

describe('persisted turn projection', () => {
  it('keeps partial output visible together with a protocol failure alert', () => {
    render(
      <MessageView
        message={assistant({
          content: 'partial answer',
          thinking: 'partial thought',
          turnStatus: 'failed',
          turnError: {
            code: 'runtime_protocol',
            message: 'Ollama ended the stream without the required terminal chunk',
          },
          stopReason: 'protocol_error',
        })}
      />,
    )

    expect(screen.getByText('partial answer')).toBeTruthy()
    expect(screen.getByText('partial thought')).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(
      within(alert).getByText('Ollama завершила поток без обязательного terminal chunk.'),
    ).toBeTruthy()
    expect(within(alert).getByText(/Причина остановки: ошибка протокола provider/)).toBeTruthy()
  })

  it('announces pending, cancelled, and legacy ambiguity without claiming success', () => {
    const pending = render(
      <MessageView message={assistant({ id: 'pending', turnStatus: 'pending' })} />,
    )
    expect(
      within(pending.container).getByText('Ответ всё ещё ожидает итогового состояния'),
    ).toBeTruthy()
    pending.unmount()

    const cancelled = render(
      <MessageView
        message={assistant({
          id: 'cancelled',
          content: 'partial',
          turnStatus: 'cancelled',
          stopReason: 'connection_aborted',
        })}
      />,
    )
    expect(within(cancelled.container).getByText('Генерация отменена')).toBeTruthy()
    expect(
      within(cancelled.container).getByText(/Причина остановки: соединение закрыто/),
    ).toBeTruthy()
    cancelled.unmount()

    const legacy = render(<MessageView message={assistant({ id: 'legacy' })} />)
    expect(
      within(legacy.container).getByText('У старого ответа нет подтверждённого итога'),
    ).toBeTruthy()
    expect(within(legacy.container).queryByText('завершён')).toBeNull()
  })

  it('explains an evidenced completed response with no visible output', () => {
    render(
      <MessageView
        message={assistant({
          turnStatus: 'completed',
          stopReason: 'stop',
        })}
      />,
    )

    expect(screen.getByText('Завершено без видимого содержимого')).toBeTruthy()
    expect(screen.getByText(/Причина остановки: остановка provider/)).toBeTruthy()
  })

  it('keeps partial output failed with a stable stream-idle timeout message', () => {
    render(
      <MessageView
        message={assistant({
          content: 'partial before stall',
          turnStatus: 'failed',
          turnError: {
            code: 'ollama_stream_idle_timeout',
            message: 'safe persisted timeout',
          },
          stopReason: 'provider_error',
        })}
      />,
    )

    expect(screen.getByText('partial before stall')).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('stream idle deadline')
    expect(alert.textContent).toContain('Причина остановки: ошибка provider')
    expect(screen.queryByText('завершён')).toBeNull()
  })

  it('uses the English source copy as fallback', () => {
    setActiveLocale('en')
    render(
      <MessageView
        message={assistant({
          turnStatus: 'failed',
          turnError: { code: 'storage_error', message: 'safe fallback' },
          stopReason: 'storage_error',
        })}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain(
      'The final response state could not be saved.',
    )
  })

  it('prints no status badge, cache caption or completion line for a completed answer; the details popover holds them (round 4)', async () => {
    const usage = { promptTokens: 1840, evalTokens: 212, promptEvalDurationMs: 410, evalDurationMs: 5200, loadDurationMs: 0, totalDurationMs: 5610, tokensPerSecond: 40.8, cacheHit: true, cachedTokens: 1600 }
    const { container } = render(<MessageView message={assistant({ content: 'The answer', turnStatus: 'completed', stopReason: 'stop', usage })} />)
    expect(screen.queryByText('завершён')).toBeNull()
    expect(screen.queryByText('KV-кэш')).toBeNull()
    const announced = screen.getByRole('status')
    expect(announced.className).toContain('sr-only')
    expect(announced.textContent).toBe('завершён, Причина остановки: остановка provider')
    expect([...container.querySelectorAll('[data-slot="badge"], .badge')].map(node => node.textContent)).toEqual([])
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('button', { name: 'Подробности сообщения' }))
    const details = await screen.findByRole('dialog')
    expect(within(details).getByText('завершён')).toBeTruthy()
    expect(within(details).getByText('остановка provider')).toBeTruthy()
    expect(within(details).getByText('KV-кэш')).toBeTruthy()
  })
})
