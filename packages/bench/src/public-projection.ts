import type { Connections } from '../../server/src/connections/service.ts'

type CompletionResult = Awaited<ReturnType<Connections['complete']>>

/** The only completion fields allowed to cross the private task boundary. */
export interface PublicToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}
export interface PublicAssistantMessage {
  readonly text: string
  readonly toolCalls: readonly PublicToolCall[]
  readonly stopReason: CompletionResult['stopReason']
}

function freezeMessage(text: string, toolCalls: PublicToolCall[],
  stopReason: CompletionResult['stopReason']): PublicAssistantMessage {
  return Object.freeze({
    text,
    toolCalls: Object.freeze(toolCalls.map(call => Object.freeze({
      id: call.id, name: call.name, arguments: Object.freeze(call.arguments),
    }))),
    stopReason,
  })
}

/**
 * Derive the public completion without mutating or forwarding the private result.
 * Thinking/signature, usage, provider metadata and unknown content stay behind.
 */
export function publicAssistantMessage(result: CompletionResult): PublicAssistantMessage {
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const toolCalls: PublicToolCall[] = []
  for (const block of result.content) {
    if (block.type !== 'toolCall') continue
    toolCalls.push({ id: block.id, name: block.name,
      arguments: structuredClone(block.arguments) as Record<string, unknown> })
  }
  return freezeMessage(text, toolCalls, result.stopReason)
}

/** Used by the K2 sink after it reads back the scrubbed stored events. */
export function storedPublicMessage(text: string, toolCalls: PublicToolCall[],
  stopReason: CompletionResult['stopReason']): PublicAssistantMessage {
  return freezeMessage(text, toolCalls, stopReason)
}
