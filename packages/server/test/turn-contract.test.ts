import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import {
  chatStreamEventSchema,
  messageSchema,
} from '@guanxi/contract'

const legacyMessage = {
  id: 'legacy-assistant',
  threadId: 'thread-1',
  role: 'assistant',
  content: '',
  thinking: null,
  toolCalls: [],
  usage: null,
  createdAt: '2026-08-02T12:00:00.000Z',
  isCompaction: false,
} as const

describe('turn compatibility contract', () => {
  it('reads a legacy Message without treating the missing optional state as success', () => {
    const parsed = messageSchema.parse(legacyMessage)

    assert.equal(parsed.turnStatus, null)
    assert.equal(parsed.turnError, null)
    assert.equal(parsed.stopReason, null)
  })

  it('keeps a new Message readable by a legacy shape that ignores additive fields', () => {
    const current = messageSchema.parse({
      ...legacyMessage,
      content: 'partial',
      turnStatus: 'failed',
      turnError: {
        code: 'runtime_protocol',
        message: 'Ollama ended the stream without the required terminal chunk',
      },
      stopReason: 'protocol_error',
    })
    const legacyReader = messageSchema.omit({
      turnStatus: true,
      turnError: true,
      stopReason: true,
    })

    assert.equal(legacyReader.parse(current).content, 'partial')
  })

  it('accepts an older done frame while exposing outcome on current frames', () => {
    const legacyDone = chatStreamEventSchema.parse({
      type: 'done',
      seq: 3,
      data: {
        messageId: 'assistant-1',
        stopReason: 'stop',
        steps: 1,
      },
    })
    const currentDone = chatStreamEventSchema.parse({
      type: 'done',
      seq: 4,
      data: {
        messageId: 'assistant-2',
        outcome: 'failed',
        stopReason: 'error',
        terminalStopReason: 'protocol_error',
        steps: 1,
      },
    })
    const legacyDoneReader = z.object({
      type: z.literal('done'),
      seq: z.number(),
      data: z.object({
        messageId: z.string(),
        stopReason: z.enum(['stop', 'length', 'tool_limit', 'stopped_by_user', 'error']),
        steps: z.number(),
      }),
    })

    assert.equal(legacyDone.type === 'done' ? legacyDone.data.outcome : 'wrong', undefined)
    assert.equal(currentDone.type === 'done' ? currentDone.data.outcome : 'wrong', 'failed')
    assert.equal(legacyDoneReader.parse(currentDone).data.stopReason, 'error')
  })
})
