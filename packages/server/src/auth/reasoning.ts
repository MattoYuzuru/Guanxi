/**
 * Reasoning is person-audience (ADR-0027, review M2/H-A): a grantee may read a session's answer,
 * not the model's chain of thought. The owner-only routes already refuse grantees; this module
 * redacts the reasoning that rides inside routes a viewer or editor may use (the thread read, the
 * chat SSE stream and the job event stream).
 *
 * A request that did not pass the authorization hook (a route mounted bare in a test) has no
 * `authz` context and sees everything; in production every `/api/*` request passes the hook.
 */
import type { ChatStreamEvent, JobStreamEvent, Message } from '@guanxi/contract'
import type { Context } from 'hono'
import type { AuthzContext } from './route-authz.ts'

/** True when the caller owns the resource the route named, or no hook ran (a bare test mount). */
export function canSeeReasoning(context: Context): boolean {
  const authz = (context as Context<{ Variables: { authz?: AuthzContext } }>).get('authz')
  return authz === undefined || authz.resourceOwner
}

/** The messages with every chain of thought removed. */
export function withoutReasoning<T extends Pick<Message, 'thinking'>>(messages: readonly T[]): T[] {
  return messages.map((message) => ({ ...message, thinking: null }))
}

/** A chat stream event for a non-owner: reasoning deltas are dropped, everything else passes. */
export function redactChatEvent(event: ChatStreamEvent): ChatStreamEvent | null {
  return event.type === 'thinking' ? null : event
}

/**
 * A persisted job event for a non-owner. The event keeps its sequence (the replay cursor needs it)
 * and its type; only the reasoning text of a `thinking` output is blanked.
 */
export function redactJobEvent<T extends object>(event: T): T {
  // The replay payload rides on the stored event beyond the public `JobEvent` type; read it structurally.
  const output = (event as { output?: JobStreamEvent['output'] }).output
  if (!output || output.event.type !== 'thinking') return event
  return { ...event, output: { ...output, event: { type: 'thinking', data: { delta: '' } } } }
}
