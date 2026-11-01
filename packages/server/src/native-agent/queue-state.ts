/**
 * The native agent's executable queue state (K4 queue v3).
 *
 * `stateOf` normalizes the latest `agent.queue` snapshot, whatever its version,
 * into one internal union and removes every id already consumed as a
 * `prompt.messageId`. This union is what the consumer executes and what the
 * outward progress bodies are projected from. It is never an outward body: a
 * preview or excerpt must not be executed, and an executable value must not be
 * handed out as a preview.
 */
import {
  INPUT_INLINE_BYTES,
  SESSION_EVENT_VERSION,
  SESSION_EVENT_VERSION_3,
  type AgentProgress,
  type AgentProgressQueueItemV2,
  type SessionEvent,
  type SessionInputArtifactRef,
} from '@guanxi/contract'
import { utf8Excerpt } from '../session-log/input-artifacts.ts'

export type ExecutableQueueItem =
  | { id: string; kind: 'inline'; text: string }
  | { id: string; kind: 'artifact'; artifact: SessionInputArtifactRef }

export interface QueueState {
  /** The envelope version of the latest queue snapshot, or null when none exists. */
  snapshotVersion: typeof SESSION_EVENT_VERSION | typeof SESSION_EVENT_VERSION_3 | null
  /** Unconsumed items of that snapshot, in recorded order. */
  pending: ExecutableQueueItem[]
}

export function queueStateOf(events: readonly SessionEvent[]): QueueState {
  let latest: Extract<SessionEvent, { type: 'agent.queue' }> | undefined
  const consumed = new Set<string>()
  for (const event of events) {
    if (event.type === 'agent.queue') latest = event
    if (event.type === 'prompt') consumed.add(event.data.messageId)
  }
  if (latest === undefined) return { snapshotVersion: null, pending: [] }
  const items: ExecutableQueueItem[] = latest.version === SESSION_EVENT_VERSION_3
    ? latest.data.items.map((item) => item.kind === 'inline'
      ? { id: item.id, kind: 'inline' as const, text: item.text }
      : { id: item.id, kind: 'artifact' as const, artifact: item.artifact })
    : latest.data.items.map((item) => ({ id: item.id, kind: 'inline' as const, text: item.text }))
  return {
    snapshotVersion: latest.version,
    pending: items.filter((item) => !consumed.has(item.id)),
  }
}

/** Thrown by {@link legacyQueueOf} when a pending item has no v1 text form. */
export class ArtifactQueueError extends Error {
  constructor() {
    super('A pending queue item is artifact-backed')
    this.name = 'ArtifactQueueError'
  }
}

/**
 * The legacy v1 body: `{id,text}` with the complete current scrubbed text. An
 * artifact-backed item has no honest v1 form (its text would be an excerpt), so
 * it is refused instead of being approximated.
 */
export function legacyQueueOf(pending: readonly ExecutableQueueItem[]): AgentProgress['queue'] {
  return pending.map((item) => {
    if (item.kind === 'artifact') throw new ArtifactQueueError()
    return { id: item.id, text: item.text }
  })
}

/**
 * The progress v2 body. Inline and artifact items keep their v3 branch. An
 * inline value above the inline bound can only be a legacy v1 entry (v3 inline
 * text is bounded at write and at read), and a read-only request cannot
 * fabricate a persisted artifact reference: it becomes a `legacy-preview`
 * carrying a bounded excerpt of the complete current-registry-scrubbed text and
 * its exact byte size.
 */
export function queueV2Of(
  pending: readonly ExecutableQueueItem[],
  scrub: (text: string) => string,
): AgentProgressQueueItemV2[] {
  return pending.map((item): AgentProgressQueueItemV2 => {
    if (item.kind === 'artifact') return { id: item.id, kind: 'artifact', artifact: item.artifact }
    const text = scrub(item.text)
    const byteSize = Buffer.byteLength(text, 'utf8')
    if (byteSize <= INPUT_INLINE_BYTES) return { id: item.id, kind: 'inline', text }
    const excerpt = utf8Excerpt(text)
    return { id: item.id, kind: 'legacy-preview', excerpt, excerptBytes: Buffer.byteLength(excerpt, 'utf8'), byteSize }
  })
}
