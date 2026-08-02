import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StreamingMessage } from '../../src/features/chat/ChatPage.tsx'
import { StreamBuffer } from '../../src/features/chat/streamBuffer.ts'

describe('streaming Chat rendering', () => {
  it('does not treat the scroll result as an effect cleanup across phase updates', () => {
    const buffer = new StreamBuffer()
    const scrollToEnd = vi.fn(() => Promise.resolve())

    const view = render(
      <StreamingMessage
        buffer={buffer}
        phase="prefill"
        toolCalls={[]}
        onChange={scrollToEnd}
      />,
    )

    act(() => {
      buffer.appendThinking('Inspecting context')
      buffer.flushNow()
    })
    view.rerender(
      <StreamingMessage
        buffer={buffer}
        phase="thinking"
        toolCalls={[]}
        onChange={scrollToEnd}
      />,
    )

    act(() => {
      buffer.appendToken('First answer token')
      buffer.flushNow()
    })
    view.rerender(
      <StreamingMessage
        buffer={buffer}
        phase="generating"
        toolCalls={[]}
        onChange={scrollToEnd}
      />,
    )

    expect(screen.getByText('First answer token')).toBeTruthy()
    expect(scrollToEnd).toHaveBeenCalledTimes(3)
  })
})
