import { chatStreamEventSchema, type ChatStreamEvent } from '@guanxi/contract'
import { describe, expect, it, vi } from 'vitest'
import { sseStream } from '../../src/lib/sse.ts'

describe('terminal SSE parsing', () => {
  it('parses a split failed terminal frame with its outcome and stop reason', async () => {
    const payload = JSON.stringify({
      type: 'done',
      seq: 7,
      data: {
        messageId: 'assistant-1',
        outcome: 'failed',
        stopReason: 'error',
        terminalStopReason: 'protocol_error',
        steps: 1,
      },
    })
    const encoded = new TextEncoder().encode(`id: 7\nevent: guanxi\ndata: ${payload}\n\n`)
    const split = Math.floor(encoded.length / 2)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoded.slice(0, split))
            controller.enqueue(encoded.slice(split))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )

    const events: ChatStreamEvent[] = []
    for await (const event of sseStream({
      url: '/api/threads/thread-1/messages',
      schema: chatStreamEventSchema,
      maxRetries: 0,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: 'done',
        seq: 7,
        data: {
          messageId: 'assistant-1',
          outcome: 'failed',
          stopReason: 'error',
          terminalStopReason: 'protocol_error',
          steps: 1,
        },
      },
    ])
  })
})
