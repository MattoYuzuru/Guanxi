import {
  sideChatErrorSchema, sideChatRespondResponseSchema, sideChatSaveResponseSchema, sideChatSendResponseSchema,
  type SideChatError, type SideChatErrorCode, type SideChatMessage, type SideChatRespondRequest,
} from '@guanxi/contract'

/** `unreachable` means no HTTP answer at all; every other code is the node's own. */
export type SideChatFailureCode = SideChatErrorCode | 'unreachable'
export class SideChatRequestError extends Error {
  readonly code: SideChatFailureCode
  readonly details: SideChatError['details']
  constructor(code: SideChatFailureCode, details?: SideChatError['details']) { super(code); this.code = code; this.details = details }
}

async function request(sessionId: string, action: 'respond' | 'save' | 'send', body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/side-chat/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new SideChatRequestError('unreachable')
  }
  if (!response.ok) {
    const parsed = sideChatErrorSchema.safeParse(await response.json().catch(() => null))
    throw new SideChatRequestError(parsed.success ? parsed.data.code : 'agent_unavailable', parsed.success ? parsed.data.details : undefined)
  }
  return response.json()
}

/** All three calls are held in memory by the caller; only `save` and `send` change the session. */
export const sideChatApi = {
  respond: async (sessionId: string, body: SideChatRespondRequest, signal?: AbortSignal) =>
    sideChatRespondResponseSchema.parse(await request(sessionId, 'respond', body, signal)),
  save: async (sessionId: string, operationId: string, messages: readonly SideChatMessage[]) =>
    sideChatSaveResponseSchema.parse(await request(sessionId, 'save', { operationId, messages })),
  send: async (sessionId: string, operationId: string, text: string) =>
    sideChatSendResponseSchema.parse(await request(sessionId, 'send', { operationId, text })),
}
