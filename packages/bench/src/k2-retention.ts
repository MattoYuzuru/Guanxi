import { createHash } from 'node:crypto'
import type { SessionEventData } from '@guanxi/contract'
import type { Connections } from '../../server/src/connections/service.ts'
import type { EgressScrubber } from '../../server/src/egress/types.ts'
import type { Attempt } from '../../server/src/runs/types.ts'
import type { RunStore } from '../../server/src/runs/store.ts'
import type { AppendOptions, AppendResult, SessionEventInput, SessionLog } from '../../server/src/session-log/log.ts'
import { storedPublicMessage, type PublicAssistantMessage, type PublicToolCall } from './public-projection.ts'
import type { TrialBinding } from './trial-binding.ts'

type CompletionResult = Awaited<ReturnType<Connections['complete']>>
type TrialRunStore = Pick<RunStore, 'append' | 'get' | 'renew'>
type SessionHeadReader = Pick<SessionLog, 'session'>

/** Versioned private-retention envelope inside the existing reasoning event class. */
export const SIGNATURE_PREFIX = 'guanxi.bench.thinking-signature/v1\n'

export type TrialRetentionCode = 'retention_not_ready' | 'retention_fenced'
  | 'retention_idempotency_conflict' | 'retention_too_large'
  | 'retention_unsupported_content' | 'retention_id_invalid' | 'retention_failed'

export class TrialRetentionError extends Error {
  readonly code: TrialRetentionCode
  constructor(code: TrialRetentionCode) { super(code); this.name = 'TrialRetentionError'; this.code = code }
}

export interface RetentionPolicy {
  maximumRetainedBytes: number
  maximumReasoningTextBytes: number
  maximumSignatureBytes: number
  maximumAssistantTextBytes: number
  maximumToolCalls: number
  maximumToolArgumentBytes: number
}

export interface K2TrialRetention {
  retain(requestId: string, result: CompletionResult): Promise<void>
  retainAndProject(requestId: string, result: CompletionResult): Promise<PublicAssistantMessage>
}

type EventSpec =
  | { role: 'reasoning' | 'signature'; key: string; type: 'reasoning'; data: SessionEventData<'reasoning'> }
  | { role: 'assistant'; key: string; type: 'assistant.message'; data: SessionEventData<'assistant.message'> }
  | { role: 'tool'; key: string; type: 'tool.call'; data: SessionEventData<'tool.call'> }

function fail(code: TrialRetentionCode): never { throw new TrialRetentionError(code) }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)) }
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail('retention_id_invalid')
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('retention_unsupported_content')
  return value as Record<string, unknown>
}

function validatePolicy(policy: RetentionPolicy): void {
  if (![policy.maximumRetainedBytes, policy.maximumReasoningTextBytes, policy.maximumSignatureBytes,
    policy.maximumAssistantTextBytes, policy.maximumToolCalls, policy.maximumToolArgumentBytes].every(positive)) {
    fail('retention_too_large')
  }
}

function mapAppendError(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'stale_lease' || code === 'writer_fenced') fail('retention_fenced')
  if (code === 'egress_not_ready') fail('retention_not_ready')
  if (code === 'idempotency_conflict') fail('retention_idempotency_conflict')
  fail('retention_failed')
}

function buildSpecs(clean: CompletionResult, binding: TrialBinding, policy: RetentionPolicy,
  requestId: string): EventSpec[] {
  if (!clean || !Array.isArray(clean.content) || typeof clean.stopReason !== 'string') {
    fail('retention_unsupported_content')
  }
  const specs: EventSpec[] = []
  let step = 0
  const nextStep = () => step++
  const textBlocks: string[] = []
  const tools: Extract<EventSpec, { role: 'tool' }>[] = []
  for (const block of clean.content) {
    if (block.type === 'thinking') {
      if (typeof block.thinking !== 'string') fail('retention_unsupported_content')
      if (Buffer.byteLength(block.thinking) > policy.maximumReasoningTextBytes) fail('retention_too_large')
      if (block.thinking.length > 0) {
        specs.push({ role: 'reasoning', key: '', type: 'reasoning',
          data: { messageId: requestId, step: nextStep(), text: block.thinking } })
      }
      if (block.thinkingSignature !== undefined) {
        const signature = sizeofSignature(block.thinkingSignature, policy)
        if (signature) {
          const envelope = SIGNATURE_PREFIX + JSON.stringify({ signature, redacted: block.redacted === true })
          if (Buffer.byteLength(envelope) > policy.maximumReasoningTextBytes) fail('retention_too_large')
          specs.push({ role: 'signature', key: '', type: 'reasoning',
            data: { messageId: requestId, step: nextStep(), text: envelope } })
        }
      }
    } else if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('retention_unsupported_content')
      textBlocks.push(block.text)
    } else if (block.type === 'toolCall') {
      const toolCallId = id(block.id)
      if (typeof block.name !== 'string' || block.name.length === 0) fail('retention_unsupported_content')
      const args = record(block.arguments)
      if (bytes(args) > policy.maximumToolArgumentBytes) fail('retention_too_large')
      tools.push({ role: 'tool', key: '', type: 'tool.call',
        data: { toolCallId, name: block.name, arguments: args, source: binding.toolSource,
          parsedFrom: 'native', diffPath: null } })
    } else {
      fail('retention_unsupported_content')
    }
  }
  if (tools.length > policy.maximumToolCalls) fail('retention_too_large')
  const ids = new Set(tools.map(spec => spec.data.toolCallId))
  if (ids.size !== tools.length) fail('retention_id_invalid')
  const text = textBlocks.join('')
  if (Buffer.byteLength(text) > policy.maximumAssistantTextBytes) fail('retention_too_large')
  if (text.length > 0) {
    specs.push({ role: 'assistant', key: '', type: 'assistant.message',
      data: { messageId: requestId, step: nextStep(), text } })
  }
  specs.push(...tools)
  // Deterministic correlation suffixes; the request id and nonce stay in the
  // K2 key column, never in a public frame.
  let reasoning = 0, signature = 0
  for (const spec of specs) {
    if (spec.role === 'reasoning') spec.key = `reasoning:${reasoning++}`
    else if (spec.role === 'signature') spec.key = `reasoning-signature:${signature++}`
    else if (spec.role === 'assistant') spec.key = 'assistant'
    else {
      const tool = spec as Extract<EventSpec, { role: 'tool' }>
      spec.key = `tool:${createHash('sha256').update(tool.data.toolCallId).digest('hex')}`
    }
  }
  const total = specs.reduce((sum, spec) => sum + bytes(spec.data), 0)
  if (total > policy.maximumRetainedBytes) fail('retention_too_large')
  return specs
}

function sizeofSignature(signature: unknown, policy: RetentionPolicy): string | undefined {
  if (typeof signature !== 'string' || signature.length === 0) return undefined
  if (Buffer.byteLength(signature) > policy.maximumSignatureBytes) fail('retention_too_large')
  return signature
}

/**
 * Structural production adapter around R1's fenced append and K2's real SessionLog.
 * No server package is imported at runtime; the coordinator wires the actual stores.
 */
export function createK2TrialRetention(input: {
  binding: TrialBinding
  attempt: Attempt
  runs: TrialRunStore
  session: SessionHeadReader
  scrubber: EgressScrubber
  policy: RetentionPolicy
}): K2TrialRetention {
  const { binding, attempt, runs, session, scrubber, policy } = input
  validatePolicy(policy)
  let tail: Promise<void> = Promise.resolve()

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work)
    tail = next.then(() => undefined, () => undefined)
    return next
  }

  const verify = () => {
    if (attempt.id !== binding.attemptId || attempt.run_id !== binding.runId) fail('retention_fenced')
    try {
      const run = runs.get(binding.runId)
      if (run.session_id !== binding.sessionId) fail('retention_fenced')
    } catch (error) {
      if (error instanceof TrialRetentionError) throw error
      mapAppendError(error)
    }
  }

  const retainAndProject = async (requestId: string, result: CompletionResult): Promise<PublicAssistantMessage> => {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) fail('retention_id_invalid')
    verify()
    if (!scrubber.isReady()) fail('retention_not_ready')
    let clean: CompletionResult
    try { clean = scrubber.scrub(result) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (code === 'unsupported_value') fail('retention_unsupported_content')
      if (code === 'closed') fail('retention_not_ready')
      fail('retention_failed')
    }
    const specs = buildSpecs(clean, binding, policy, requestId)
    let assistantText: string | undefined
    const toolCalls: PublicToolCall[] = []
    for (const spec of specs) {
      verify()
      if (!scrubber.isReady()) fail('retention_not_ready')
      let head: { lastSeq: number } | null
      try { head = session.session(binding.sessionId) } catch (error) { mapAppendError(error) }
      if (!head) fail('retention_failed')
      const key = `bench:${binding.nonce}:${requestId}:${spec.key}`
      let appended: AppendResult
      try {
        appended = runs.append(attempt,
          { type: spec.type, data: spec.data, spanId: requestId } as SessionEventInput,
          { idempotencyKey: key, expectedSeq: head.lastSeq + 1 } satisfies AppendOptions & { expectedSeq: number })
      } catch (error) { mapAppendError(error) }
      const event = appended.event
      if (spec.role === 'assistant') {
        if (event.type !== 'assistant.message') fail('retention_failed')
        if (Buffer.byteLength(event.data.text) > policy.maximumAssistantTextBytes) fail('retention_too_large')
        assistantText = event.data.text
      } else if (spec.role === 'tool') {
        if (event.type !== 'tool.call') fail('retention_failed')
        const storedId = id(event.data.toolCallId)
        if (bytes(event.data.arguments) > policy.maximumToolArgumentBytes) fail('retention_too_large')
        toolCalls.push({ id: storedId, name: event.data.name, arguments: structuredClone(event.data.arguments) })
      }
    }
    return storedPublicMessage(assistantText ?? '', toolCalls, clean.stopReason)
  }

  const retain = async (requestId: string, result: CompletionResult): Promise<void> => {
    await exclusive(() => retainAndProject(requestId, result))
  }

  return Object.freeze({
    retain,
    retainAndProject: (requestId: string, result: CompletionResult) =>
      exclusive(() => retainAndProject(requestId, result)),
  })
}
