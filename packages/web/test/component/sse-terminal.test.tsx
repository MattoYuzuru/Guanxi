import { chatStreamEventSchema, type ChatStreamEvent } from '@guanxi/contract'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SseServerError, sseStream } from '../../src/lib/sse.ts'

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


describe('typed SSE server errors', () => {
  it('turns a guanxi-error frame into a non-retryable typed error without onInvalidFrame', async () => {
    const body = JSON.stringify({
      code: 'session_event_version_unsupported',
      message: 'The next event needs a newer trace format',
      details: { seq: 41, supported: 1, required: 2 },
    })
    const encoded = new TextEncoder().encode(`event: guanxi-error\ndata: ${body}\n\n`)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close() } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const onInvalidFrame = vi.fn()
    let caught: unknown
    try {
      for await (const _event of sseStream({
        url: '/api/sessions/s/stream',
        schema: z.object({ seq: z.number() }),
        maxRetries: 5,
        onInvalidFrame,
      })) {
        // The server sent only an error frame.
      }
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SseServerError)
    const typed = caught as SseServerError
    expect(typed.retryable).toBe(false)
    expect(typed.payload?.code).toBe('session_event_version_unsupported')
    expect(typed.payload?.details).toEqual({ seq: 41, supported: 1, required: 2 })
    expect(onInvalidFrame).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
