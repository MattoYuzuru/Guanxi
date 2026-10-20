import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ContextCheckpoint, ContextState, Message } from '@guanxi/contract'
import { MessageTimeline } from '../../src/features/chat/ChatPage.tsx'
import { StreamBuffer } from '../../src/features/chat/streamBuffer.ts'
import { ContextPanel } from '../../src/features/context/ContextPanel.tsx'

const observedAt = '2026-08-14T10:00:00.000Z'

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  })
})

function message(id: string, content: string, isCompaction = false): Message {
  return {
    id,
    threadId: 'thread',
    jobId: null,
    role: isCompaction ? 'system' : 'user',
    content,
    thinking: null,
    toolCalls: [],
    usage: null,
    createdAt: observedAt,
    isCompaction,
    turnStatus: null,
    turnError: null,
    stopReason: null,
  }
}

function checkpoint(overrides: Partial<ContextCheckpoint> = {}): ContextCheckpoint {
  return {
    contextCheckpointVersion: 1,
    id: 'checkpoint-1',
    threadId: 'thread',
    previousCheckpointId: null,
    source: { state: 'source_preserved', upToSeq: 1, messageCount: 2 },
    summary: {
      format: 'text_utf8_v1',
      content: 'Preserved summary',
      byteSize: 17,
      sha256: 'a'.repeat(64),
    },
    createdAt: observedAt,
    ...overrides,
  }
}

const context: ContextState = {
  usedTokens: 7_000,
  allocatedTokens: 8_192,
  percent: 85.45,
  cacheHit: false,
  cachedTokens: 0,
  compactable: true,
  estimatedRepefillMs: 41_800,
}

describe('visible non-destructive context checkpoint', () => {
  it('renders every original once, inserts one checkpoint at its boundary and explains preservation', () => {
    const messages = [message('m0', 'Original zero'), message('m1', 'Original one'), message('m2', 'Tail')]
    const view = render(
      <MessageTimeline
        messages={messages}
        contextCheckpoints={[checkpoint()]}
        buffer={new StreamBuffer()}
        phase="idle"
        liveOutputRetained={false}
        liveToolCalls={[]}
        streamError={null}
      />,
    )

    expect(screen.getAllByText('Original zero')).toHaveLength(1)
    expect(screen.getAllByText('Original one')).toHaveLength(1)
    expect(screen.getAllByText('Tail')).toHaveLength(1)
    expect(screen.getAllByText('Preserved summary')).toHaveLength(1)
    expect(screen.getByText(/История сохранена: 2 исходных сообщений/)).toBeTruthy()
    const text = view.container.textContent ?? ''
    expect(text.indexOf('Original one')).toBeLessThan(text.indexOf('Preserved summary'))
    expect(text.indexOf('Preserved summary')).toBeLessThan(text.indexOf('Tail'))
  })

  it('replaces one legacy summary Message with one honest legacy marker', () => {
    const legacy = checkpoint({
      id: 'legacy-message',
      source: { state: 'legacy_source_unavailable', upToSeq: 4, messageCount: null },
      summary: {
        format: 'text_utf8_v1',
        content: 'Legacy summary',
        byteSize: 14,
        sha256: 'b'.repeat(64),
      },
    })
    render(
      <MessageTimeline
        messages={[message('legacy-message', 'Legacy summary', true), message('tail', 'Tail')]}
        contextCheckpoints={[legacy]}
        buffer={new StreamBuffer()}
        phase="idle"
        liveOutputRetained={false}
        liveToolCalls={[]}
        streamError={null}
      />,
    )

    expect(screen.getAllByText('Legacy summary')).toHaveLength(1)
    expect(screen.getByText(/старые исходные сообщения были удалены/)).toBeTruthy()
    expect(document.querySelectorAll('[data-context-checkpoint="legacy-message"]')).toHaveLength(1)
  })

  it('moves focus only when a newly completed checkpoint appears', async () => {
    const original = [message('m0', 'Original zero'), message('m1', 'Original one')]
    const view = render(
      <MessageTimeline
        messages={original}
        contextCheckpoints={[]}
        buffer={new StreamBuffer()}
        phase="idle"
        liveOutputRetained={false}
        liveToolCalls={[]}
        streamError={null}
      />,
    )
    view.rerender(
      <MessageTimeline
        messages={original}
        contextCheckpoints={[checkpoint()]}
        buffer={new StreamBuffer()}
        phase="idle"
        liveOutputRetained={false}
        liveToolCalls={[]}
        streamError={null}
      />,
    )

    await waitFor(() => {
      expect(document.activeElement).toBe(
        document.querySelector('[data-context-checkpoint="checkpoint-1"]'),
      )
    })
  })

  it('keeps confirmation open, focuses an error and retries the same explicit action', async () => {
    const onCompact = vi.fn()
      .mockRejectedValueOnce(new Error('injected checkpoint failure'))
      .mockResolvedValueOnce({ ok: true })
    render(
      <ContextPanel
        context={context}
        usage={null}
        compacting={false}
        onCompact={onCompact}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Свернуть контекст' }))
    fireEvent.click(screen.getByRole('button', { name: 'Создать checkpoint' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('injected checkpoint failure')
    expect(alert).toBe(document.activeElement)
    fireEvent.click(screen.getByRole('button', { name: 'Повторить checkpoint' }))
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
