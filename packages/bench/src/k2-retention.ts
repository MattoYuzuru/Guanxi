import { createHash } from 'node:crypto'
import type { SessionEvent, SessionEventData } from '@guanxi/contract'
import type { Connections } from '../../server/src/connections/service.ts'
import type { EgressScrubber } from '../../server/src/egress/types.ts'
import type { Attempt } from '../../server/src/runs/types.ts'
import type { RunStore } from '../../server/src/runs/store.ts'
import type { AppendOptions, AppendResult, SessionEventInput, SessionLog } from '../../server/src/session-log/log.ts'
import { storedPublicMessage, type PublicAssistantMessage, type PublicToolCall } from './public-projection.ts'
import type { TrialBinding } from './trial-binding.ts'

type CompletionResult = Awaited<ReturnType<Connections['complete']>>
type TrialRunStore = Pick<RunStore, 'append' | 'get' | 'mutate' | 'renew'>
type SessionReader = Pick<SessionLog, 'session' | 'readAll'>

/** Versioned private-retention envelope inside the existing reasoning event class. */
export const SIGNATURE_PREFIX = 'guanxi.bench.thinking-signature/v1\n'
/** Versioned private two-phase completion receipt, also inside the reasoning class. */
export const COMPLETION_RECEIPT_PREFIX = 'guanxi.bench.completion-receipt/v1\n'

const SPAN_DOMAIN = 'guanxi.bench.completion-span/v1\n'
const BINDING_NAMESPACE_DOMAIN = 'guanxi.bench.completion-binding/v1\n'
const REQUEST_NAMESPACE_DOMAIN = 'guanxi.bench.completion-request/v1\n'
const LEGACY_KEY_PREFIX_MAXIMUM = 512
const STOP_REASON_MAXIMUM = 200

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
type BuiltSpec = EventSpec & { sha256: string }
interface PublicValues {
  text: string
  toolCalls: PublicToolCall[]
  stopReason: CompletionResult['stopReason']
}
interface ReceiptSpec {
  role: EventSpec['role']
  type: EventSpec['type']
  key: string
  sha256: string
}
interface BeginReceipt {
  version: 1
  phase: 'begin'
  span: string
  bindingHash: string
  requestHash: string
  stopReason: string
  specs: ReceiptSpec[]
  specCount: number
  manifestSha256: string
  publicSha256: string
}
interface DoneReceipt {
  version: 1
  phase: 'done'
  span: string
  bindingHash: string
  requestHash: string
  stopReason: string
  specCount: number
  manifestSha256: string
  publicSha256: string
  beginSeq: number
  contentSeqs: number[]
}
type Receipt = BeginReceipt | DoneReceipt
interface ReceiptEntry { event: SessionEvent; receipt: Receipt }
interface ScopedCompletion {
  content: SessionEvent[]
  begin?: ReceiptEntry
  done?: ReceiptEntry
  receipts: ReceiptEntry[]
}

function fail(code: TrialRetentionCode): never { throw new TrialRetentionError(code) }
function conflict(): never { fail('retention_idempotency_conflict') }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function bytes(value: unknown): number {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { fail('retention_unsupported_content') }
  if (serialized === undefined) fail('retention_unsupported_content')
  return Buffer.byteLength(serialized)
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) fail('retention_id_invalid')
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('retention_unsupported_content')
  return value as Record<string, unknown>
}
function parseStopReason(value: unknown): CompletionResult['stopReason'] {
  if (typeof value !== 'string' || value.length === 0 || value.length > STOP_REASON_MAXIMUM || value.includes('\0')) {
    fail('retention_unsupported_content')
  }
  return value as CompletionResult['stopReason']
}

/** Canonical JSON without a dependency: sorted object keys, preserved array order, JSON values only. */
function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('retention_unsupported_content')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail('retention_unsupported_content')
    const source = value as Record<string, unknown>
    const keys = Object.keys(source).sort()
    return `{${keys.map(key => {
      if (source[key] === undefined) fail('retention_unsupported_content')
      return `${JSON.stringify(key)}:${canonical(source[key])}`
    }).join(',')}}`
  }
  fail('retention_unsupported_content')
}
function hashCanonical(value: unknown): string { return sha256(canonical(value)) }
function completionSpan(binding: TrialBinding, requestId: string): string {
  return sha256(`${SPAN_DOMAIN}${binding.nonce}\n${requestId}`)
}
function bindingNamespaceHash(binding: TrialBinding): string {
  return sha256(`${BINDING_NAMESPACE_DOMAIN}${binding.nonce}`)
}
function requestNamespaceHash(requestId: string): string {
  return sha256(`${REQUEST_NAMESPACE_DOMAIN}${requestId}`)
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
  if (code === 'idempotency_conflict' || code === 'sequence_conflict') fail('retention_idempotency_conflict')
  fail('retention_failed')
}
function appendCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
}

function sizeofSignature(signature: unknown, policy: RetentionPolicy): string | undefined {
  if (typeof signature !== 'string' || signature.length === 0) return undefined
  if (Buffer.byteLength(signature) > policy.maximumSignatureBytes) fail('retention_too_large')
  return signature
}

function buildCompletion(clean: CompletionResult, binding: TrialBinding, policy: RetentionPolicy,
  requestId: string): { specs: BuiltSpec[]; public: PublicValues } {
  if (!clean || !Array.isArray(clean.content) || typeof clean.stopReason !== 'string') {
    fail('retention_unsupported_content')
  }
  const stopReason = parseStopReason(clean.stopReason)
  const specs: EventSpec[] = []
  let step = 0
  const nextStep = () => step++
  const textBlocks: string[] = []
  const toolCalls: PublicToolCall[] = []
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
      const data = { toolCallId, name: block.name, arguments: args, source: binding.toolSource,
        parsedFrom: 'native' as const, diffPath: null }
      tools.push({ role: 'tool', key: '', type: 'tool.call', data })
      toolCalls.push({ id: toolCallId, name: block.name, arguments: structuredClone(args) })
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
    else spec.key = `tool:${sha256((spec as Extract<EventSpec, { role: 'tool' }>).data.toolCallId)}`
  }
  const total = specs.reduce((sum, spec) => sum + bytes(spec.data), 0)
  if (total > policy.maximumRetainedBytes) fail('retention_too_large')
  return {
    specs: specs.map(spec => ({ ...spec, sha256: hashCanonical(spec.data) })),
    public: { text, toolCalls, stopReason },
  }
}

function receiptSpecs(specs: readonly BuiltSpec[]): ReceiptSpec[] {
  return specs.map(spec => ({ role: spec.role, type: spec.type, key: spec.key, sha256: spec.sha256 }))
}
function manifestSha(specs: readonly ReceiptSpec[]): string {
  return hashCanonical(specs.map(spec => [spec.role, spec.type, spec.key, spec.sha256]))
}
function publicSha(publicValues: PublicValues): string {
  return hashCanonical({ text: publicValues.text, toolCalls: publicValues.toolCalls,
    stopReason: publicValues.stopReason })
}
function canonicalReceipt(receipt: Receipt): string { return canonical(receipt) }
function receiptText(receipt: Receipt): string { return COMPLETION_RECEIPT_PREFIX + canonicalReceipt(receipt) }
function receiptData(span: string, requestId: string, receipt: Receipt): SessionEventInput<'reasoning'> {
  return { type: 'reasoning', spanId: span, data: { messageId: requestId, step: null, text: receiptText(receipt) } }
}
function checkReceiptText(text: string, policy: RetentionPolicy): void {
  if (Buffer.byteLength(text) > policy.maximumReasoningTextBytes) fail('retention_too_large')
}

function contentKey(binding: TrialBinding, requestId: string, suffix: string): string {
  return `bench:${binding.nonce}:${requestId}:${suffix}`
}
function beginKey(binding: TrialBinding, requestId: string): string {
  return contentKey(binding, requestId, 'receipt:begin')
}
function doneKey(binding: TrialBinding, requestId: string): string {
  return contentKey(binding, requestId, 'receipt:done')
}

function validReceiptSpec(value: unknown): value is ReceiptSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const spec = value as Record<string, unknown>
  if (typeof spec.role !== 'string' || typeof spec.type !== 'string' || typeof spec.key !== 'string' ||
    typeof spec.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(spec.sha256)) return false
  if (spec.role === 'reasoning') return spec.type === 'reasoning' && /^reasoning:\d+$/.test(spec.key)
  if (spec.role === 'signature') return spec.type === 'reasoning' && /^reasoning-signature:\d+$/.test(spec.key)
  if (spec.role === 'assistant') return spec.type === 'assistant.message' && spec.key === 'assistant'
  if (spec.role === 'tool') return spec.type === 'tool.call' && /^tool:[a-f0-9]{64}$/.test(spec.key)
  return false
}

function parseReceiptText(text: string, expected: { span: string; bindingHash: string; requestHash: string }): Receipt {
  let parsed: Record<string, unknown>
  try { parsed = record(JSON.parse(text.slice(COMPLETION_RECEIPT_PREFIX.length))) }
  catch { conflict() }
  if (parsed.version !== 1 || (parsed.phase !== 'begin' && parsed.phase !== 'done') ||
    parsed.span !== expected.span || parsed.bindingHash !== expected.bindingHash ||
    parsed.requestHash !== expected.requestHash || typeof parsed.stopReason !== 'string' ||
    parsed.stopReason.length === 0 || parsed.stopReason.length > STOP_REASON_MAXIMUM ||
    parsed.stopReason.includes('\0') ||
    typeof parsed.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.manifestSha256) ||
    typeof parsed.publicSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.publicSha256) ||
    !Number.isSafeInteger(parsed.specCount) || (parsed.specCount as number) < 0) conflict()
  if (parsed.phase === 'begin') {
    if (!Array.isArray(parsed.specs) || parsed.specs.length !== parsed.specCount ||
      !parsed.specs.every(validReceiptSpec)) conflict()
    const specs = parsed.specs as ReceiptSpec[]
    if (new Set(specs.map(spec => spec.key)).size !== specs.length) conflict()
    if (manifestSha(specs) !== parsed.manifestSha256) conflict()
    return { version: 1, phase: 'begin', span: parsed.span as string,
      bindingHash: parsed.bindingHash as string, requestHash: parsed.requestHash as string,
      stopReason: parsed.stopReason as string, specs, specCount: parsed.specCount as number,
      manifestSha256: parsed.manifestSha256 as string, publicSha256: parsed.publicSha256 as string }
  }
  if (!Number.isSafeInteger(parsed.beginSeq) || (parsed.beginSeq as number) <= 0 ||
    !Array.isArray(parsed.contentSeqs) || parsed.contentSeqs.length > (parsed.specCount as number) ||
    !parsed.contentSeqs.every(seq => Number.isSafeInteger(seq) && (seq as number) > 0)) conflict()
  const contentSeqs = parsed.contentSeqs as number[]
  if (contentSeqs.some((seq, index) => index > 0 && seq <= contentSeqs[index - 1]!)) conflict()
  return { version: 1, phase: 'done', span: parsed.span as string,
    bindingHash: parsed.bindingHash as string, requestHash: parsed.requestHash as string,
    stopReason: parsed.stopReason as string, specCount: parsed.specCount as number,
    manifestSha256: parsed.manifestSha256 as string, publicSha256: parsed.publicSha256 as string,
    beginSeq: parsed.beginSeq as number, contentSeqs }
}

function receiptCandidate(event: SessionEvent): { text: string } | null {
  if (event.type !== 'reasoning' || event.data === null) return null
  const data = event.data as { step?: unknown; text?: unknown }
  if (data.step !== null || typeof data.text !== 'string' || !data.text.startsWith(COMPLETION_RECEIPT_PREFIX)) return null
  return { text: data.text }
}

function classifyScoped(events: readonly SessionEvent[], span: string, expected: {
  span: string; bindingHash: string; requestHash: string
}, policy: RetentionPolicy): ScopedCompletion {
  const content: SessionEvent[] = []
  const receipts: ReceiptEntry[] = []
  for (const event of events) {
    if (event.spanId !== span) continue
    if (event.type === 'reasoning' && 'purgedAt' in event && event.purgedAt !== null) conflict()
    const candidate = receiptCandidate(event)
    if (candidate) {
      checkReceiptText(candidate.text, policy)
      receipts.push({ event, receipt: parseReceiptText(candidate.text, expected) })
      continue
    }
    if (event.type === 'reasoning') {
      const data = event.data as { step?: unknown } | null
      if (data && data.step === null) conflict()
    }
    if (!['reasoning', 'assistant.message', 'tool.call'].includes(event.type)) conflict()
    content.push(event)
  }
  const begins = receipts.filter(entry => entry.receipt.phase === 'begin')
  const dones = receipts.filter(entry => entry.receipt.phase === 'done')
  if (begins.length > 1 || dones.length > 1) conflict()
  if (!begins[0] && (content.length > 0 || dones.length > 0)) conflict()
  return { content, begin: begins[0], done: dones[0], receipts }
}

interface ValidatedCompletion {
  content: SessionEvent[]
  done?: ReceiptEntry
  begin: ReceiptEntry
  publicValues: PublicValues
  contentBytes: number
}

function validateCompletion(state: ScopedCompletion, begin: ReceiptEntry, policy: RetentionPolicy): ValidatedCompletion {
  const beginReceipt = begin.receipt as BeginReceipt
  const content = [...state.content].sort((a, b) => a.seq - b.seq)
  let assistantText: string | undefined
  const toolCalls: PublicToolCall[] = []
  let contentBytes = bytes(begin.event.data)
  for (let index = 0; index < content.length; index++) {
    const event = content[index]!
    const spec = beginReceipt.specs[index]
    if (!spec || event.type !== spec.type || event.data === null) conflict()
    if (event.seq <= begin.event.seq || (index > 0 && event.seq <= content[index - 1]!.seq)) conflict()
    contentBytes += bytes(event.data)
    if (event.type === 'reasoning') {
      const data = event.data as SessionEventData<'reasoning'>
      if (Buffer.byteLength(data.text) > policy.maximumReasoningTextBytes) fail('retention_too_large')
    } else if (event.type === 'assistant.message') {
      const data = event.data as SessionEventData<'assistant.message'>
      if (Buffer.byteLength(data.text) > policy.maximumAssistantTextBytes) fail('retention_too_large')
      if (assistantText !== undefined) conflict()
      assistantText = data.text
    } else {
      const data = event.data as SessionEventData<'tool.call'>
      if (bytes(data.arguments) > policy.maximumToolArgumentBytes) fail('retention_too_large')
      toolCalls.push({ id: data.toolCallId, name: data.name, arguments: structuredClone(data.arguments) })
    }
    if (hashCanonical(event.data) !== spec.sha256) conflict()
  }
  if (content.length > beginReceipt.specs.length) conflict()
  if (contentBytes > policy.maximumRetainedBytes) fail('retention_too_large')
  const publicValues: PublicValues = { text: assistantText ?? '', toolCalls,
    stopReason: parseStopReason(beginReceipt.stopReason) }
  const publicDigest = publicSha(publicValues)
  // A crash may leave only a prefix of the ordered manifest. Its digest can only
  // be checked after the full content set exists; a done receipt always requires it.
  if (content.length === beginReceipt.specs.length && publicDigest !== beginReceipt.publicSha256) conflict()
  if (state.done) {
    const done = state.done.receipt as DoneReceipt
    if (content.length !== beginReceipt.specs.length) conflict()
    if (done.beginSeq !== begin.event.seq || done.specCount !== beginReceipt.specCount ||
      done.manifestSha256 !== beginReceipt.manifestSha256 || done.publicSha256 !== publicDigest ||
      done.stopReason !== beginReceipt.stopReason) conflict()
    const seqs = content.map(event => event.seq)
    if (done.contentSeqs.length !== seqs.length || done.contentSeqs.some((seq, index) => seq !== seqs[index])) conflict()
    if (state.done.event.seq <= (content.at(-1)?.seq ?? begin.event.seq)) conflict()
    if (contentBytes + bytes(state.done.event.data) > policy.maximumRetainedBytes) fail('retention_too_large')
  }
  return { content, done: state.done, begin, publicValues, contentBytes }
}

function requireBegin(state: ScopedCompletion): ReceiptEntry {
  if (!state.begin) conflict()
  return state.begin
}

function nextSeq(session: SessionReader, sessionId: string): number {
  let head: { lastSeq: number } | null
  try { head = session.session(sessionId) } catch (error) { mapAppendError(error) }
  if (!head) fail('retention_failed')
  return head.lastSeq + 1
}

/**
 * Refuse a legacy raw-span trace only when the fenced store metadata proves that
 * this binding/request key prefix has a row under the old raw span. The old tool
 * key contains a hash of the toolCallId; a secret registered after that append
 * hides the id on read, so the key cannot be recomputed from an event. The query
 * reads no payload, binds every parameter and compares an exact bounded prefix,
 * so another binding or request can never match it.
 */
function rejectLegacyTrace(requestId: string, binding: TrialBinding,
  attempt: Attempt, runs: TrialRunStore): void {
  const prefix = contentKey(binding, requestId, '')
  if (prefix.length > LEGACY_KEY_PREFIX_MAXIMUM) fail('retention_id_invalid')
  let present = false
  try {
    present = runs.mutate(attempt, db => {
      const row = db.prepare(
        `SELECT 1 AS present FROM session_events
         WHERE session_id = ? AND span_id = ? AND substr(idempotency_key, 1, ?) = ?
         LIMIT 1`,
      ).get(binding.sessionId, requestId, prefix.length, prefix) as { present?: number } | undefined
      return row !== undefined
    })
  } catch (error) { mapAppendError(error) }
  if (present) conflict()
}

/**
 * Structural production adapter around R1's fenced append and K2's real SessionLog.
 * No server package is imported at runtime; the coordinator wires the actual stores.
 */
export function createK2TrialRetention(input: {
  binding: TrialBinding
  attempt: Attempt
  runs: TrialRunStore
  session: SessionReader
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

  const readAll = (): SessionEvent[] => {
    try { return session.readAll(binding.sessionId, 'person') } catch (error) { mapAppendError(error) }
  }

  const append = (input: SessionEventInput, requestId: string, suffix: string, expectedSeq: number): AppendResult => {
    try {
      return runs.append(attempt, input,
        { idempotencyKey: contentKey(binding, requestId, suffix), expectedSeq } satisfies AppendOptions & { expectedSeq: number })
    } catch (error) { mapAppendError(error) }
  }

  const retainAndProject = async (requestId: string, result: CompletionResult): Promise<PublicAssistantMessage> => {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) fail('retention_id_invalid')
    verify()
    if (!scrubber.isReady()) fail('retention_not_ready')
    let clean: CompletionResult
    try { clean = scrubber.scrub(result) } catch (error) {
      const code = appendCode(error)
      if (code === 'unsupported_value') fail('retention_unsupported_content')
      if (code === 'closed') fail('retention_not_ready')
      fail('retention_failed')
    }
    const span = completionSpan(binding, requestId)
    const bindingHash = bindingNamespaceHash(binding)
    const requestHash = requestNamespaceHash(requestId)
    const { specs, public: expectedPublic } = buildCompletion(clean, binding, policy, requestId)
    const beginReceipt: BeginReceipt = { version: 1, phase: 'begin', span, bindingHash, requestHash,
      stopReason: expectedPublic.stopReason as string, specs: receiptSpecs(specs), specCount: specs.length,
      manifestSha256: manifestSha(receiptSpecs(specs)), publicSha256: publicSha(expectedPublic) }
    const beginData = receiptData(span, requestId, beginReceipt)
    const beginText = beginData.data.text
    checkReceiptText(beginText, policy)
    const plannedContentBytes = specs.reduce((sum, spec) => sum + bytes(spec.data), 0)
    if (plannedContentBytes + bytes(beginData) > policy.maximumRetainedBytes) fail('retention_too_large')

    let events = readAll()
    let state = classifyScoped(events, span, { span, bindingHash, requestHash }, policy)
    rejectLegacyTrace(requestId, binding, attempt, runs)
    let authoritativeBegin: AppendResult | undefined
    if (!state.begin) {
      if (state.content.length > 0 || state.done) conflict()
      authoritativeBegin = append(beginData, requestId, 'receipt:begin', nextSeq(session, binding.sessionId))
      const parsed = parseReceiptText((authoritativeBegin.event.data as SessionEventData<'reasoning'>).text,
        { span, bindingHash, requestHash })
      if (canonical(parsed) !== canonical(beginReceipt)) conflict()
      events = readAll()
      state = classifyScoped(events, span, { span, bindingHash, requestHash }, policy)
    }
    if (!state.begin) conflict()
    // An existing begin is re-appended at its key before content comparison, so
    // the real R1 fence and same-key changed-payload check decide first.
    const beginAppend = authoritativeBegin ??
      append(beginData, requestId, 'receipt:begin', nextSeq(session, binding.sessionId))
    const storedBeginReceipt = parseReceiptText((beginAppend.event.data as SessionEventData<'reasoning'>).text,
      { span, bindingHash, requestHash })
    if (canonical(storedBeginReceipt) !== canonical(beginReceipt)) conflict()
    events = readAll()
    state = classifyScoped(events, span, { span, bindingHash, requestHash }, policy)
    if (!state.begin) conflict()
    let validated = validateCompletion(state, state.begin, policy)

    if (!validated.done) {
      for (let index = validated.content.length; index < (state.begin.receipt as BeginReceipt).specs.length; index++) {
        verify()
        if (!scrubber.isReady()) fail('retention_not_ready')
        const spec = specs[index]
        if (!spec) conflict()
        const appended = append({ type: spec.type, data: spec.data, spanId: span } as SessionEventInput,
          requestId, spec.key, nextSeq(session, binding.sessionId))
        if (appended.event.type !== spec.type || appended.event.data === null) conflict()
        if (spec.type === 'reasoning') {
          if (Buffer.byteLength((appended.event.data as SessionEventData<'reasoning'>).text) > policy.maximumReasoningTextBytes) {
            fail('retention_too_large')
          }
        } else if (spec.type === 'assistant.message') {
          if (Buffer.byteLength((appended.event.data as SessionEventData<'assistant.message'>).text) > policy.maximumAssistantTextBytes) {
            fail('retention_too_large')
          }
        } else if (bytes((appended.event.data as SessionEventData<'tool.call'>).arguments) > policy.maximumToolArgumentBytes) {
          fail('retention_too_large')
        }
        if (hashCanonical(appended.event.data) !== spec.sha256) conflict()
      }
      events = readAll()
      state = classifyScoped(events, span, { span, bindingHash, requestHash }, policy)
      validated = validateCompletion(state, requireBegin(state), policy)
    }
    const beginEntry = requireBegin(state)
    if (validated.content.length !== (beginEntry.receipt as BeginReceipt).specs.length) conflict()
    const contentSeqs = validated.content.map(event => event.seq)
    const doneReceipt: DoneReceipt = { version: 1, phase: 'done', span, bindingHash, requestHash,
      stopReason: storedBeginReceipt.stopReason, specCount: storedBeginReceipt.specCount,
      manifestSha256: storedBeginReceipt.manifestSha256, publicSha256: publicSha(validated.publicValues),
      beginSeq: beginEntry.event.seq, contentSeqs }
    const doneData = receiptData(span, requestId, doneReceipt)
    checkReceiptText(doneData.data.text, policy)
    if (validated.contentBytes + bytes(doneData) > policy.maximumRetainedBytes) fail('retention_too_large')
    const appendedDone = append(doneData, requestId, 'receipt:done', nextSeq(session, binding.sessionId))
    const storedDone = parseReceiptText((appendedDone.event.data as SessionEventData<'reasoning'>).text,
      { span, bindingHash, requestHash })
    if (canonical(storedDone) !== canonical(doneReceipt)) conflict()
    events = readAll()
    state = classifyScoped(events, span, { span, bindingHash, requestHash }, policy)
    const finalBegin = requireBegin(state)
    const final = validateCompletion(state, finalBegin, policy)
    if (!final.done || final.content.length !== (finalBegin.receipt as BeginReceipt).specs.length) conflict()
    return storedPublicMessage(final.publicValues.text, final.publicValues.toolCalls,
      parseStopReason(storedBeginReceipt.stopReason))
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
