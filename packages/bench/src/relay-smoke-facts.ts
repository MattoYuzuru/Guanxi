// B3-b: content-free facts projected from a relay run's observable surface. Pure. Event text, tool
// arguments and assistant messages are parsed for fixed keys and then dropped; nothing here keeps them.
import { createHash } from 'node:crypto'

/** The only shape this module needs from a session event (a subset of the contract's event envelope). */
export interface EventLike { seq: number; type: string; createdAt: string; jobId: string | null; data: unknown }

export type SmokeFact =
  | { kind: 'cycle_begin'; seq: number; atMs: number; cycle: number }
  | { kind: 'sealed'; seq: number; atMs: number; cycle: number }
  | { kind: 'probe'; seq: number; atMs: number; cycle: number; retry: number; correct: boolean; damaged: boolean }
  | { kind: 'probe_degraded'; seq: number; atMs: number; cycle: number }
  | { kind: 'context_dropped'; seq: number; atMs: number; cycle: number; dropped: number; cut: number }
  | { kind: 'call_retry'; seq: number; atMs: number; cycle: number; purpose: string; reason: string }
  | { kind: 'call_failed'; seq: number; atMs: number; cycle: number; purpose: string; reason: string }
  | { kind: 'call_started'; seq: number; atMs: number; cycle: number; messageId: string; purpose: string }
  | { kind: 'call_done'; seq: number; atMs: number; cycle: number; messageId: string }
  | { kind: 'judge_signals'; seq: number; atMs: number; cycle: number; phase: string; signals: string[]; unknownFacts: string[] }
  | { kind: 'cap'; seq: number; atMs: number; cycle: number; reason: string }
  | { kind: 'initialized'; seq: number; atMs: number; cycle: number }
  /** The naive-compaction arm writes this once per executor attempt, before that attempt's first model call (`attempt` is the R1 attempt id,
   * the same value as `relay_seals.attempt_id`); a ledger attempt never does. */
  | { kind: 'compaction'; seq: number; atMs: number; cycle: number; mode: string; attempt: string | null; epoch: number | null }
  /** A cycle's probe does not apply to the arm: not a result, neither a pass nor a fail. */
  | { kind: 'probe_not_applicable'; seq: number; atMs: number; cycle: number; damaged: boolean }
  /** Written by the naive arm after each seal. `degradedReason` is the relay's fixed code (null when intact); the limits are the machinery's, not caps of the runner. */
  | { kind: 'compaction_summary'; seq: number; atMs: number; cycle: number; attempt: string | null; summaryBytes: number | null; summaryLimitBytes: number | null; outputLimitTokens: number | null
      truncated: boolean; degraded: boolean; degradedReason: string | null; inputDropped: number; inputCut: number }
  | { kind: 'error'; seq: number; atMs: number; cycle: number; code: string }

const record = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
const fixedCode = (v: unknown): string | null => typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : null
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const identifier = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v) ? v : null
const codes = (v: unknown): string[] => Array.isArray(v) ? v.map(fixedCode).filter((c): c is string => c !== null) : []

/** Parses the text of a relay `agent.note`: store events are `{data, relay}`, executor events are flat. */
function relayNote(text: unknown): { relay: string; payload: Record<string, unknown> } | null {
  if (typeof text !== 'string' || text.length > 20_000) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  const note = record(value)
  const relay = fixedCode(note?.relay)
  if (!note || !relay) return null
  const nested = record(note.data)
  if (nested) return { relay, payload: nested }
  const { relay: _relay, ...rest } = note
  return { relay, payload: rest }
}

/** Facts of one relay run, in event order, each stamped with the cycle in force (`step` of a call, else the last `cycle_begin`). */
export function projectEvents(events: readonly EventLike[], runId: string): SmokeFact[] {
  const out: SmokeFact[] = []
  let current = 0
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.jobId !== runId) continue
    const atMs = Date.parse(e.createdAt)
    if (!Number.isSafeInteger(atMs)) continue
    const base = { seq: e.seq, atMs }
    const data = record(e.data)
    if (e.type === 'assistant.started' || e.type === 'assistant.message') {
      const messageId = identifier(data?.messageId)
      if (!messageId) continue
      const cycle = count(data?.step) ?? current
      if (e.type === 'assistant.message') { out.push({ ...base, kind: 'call_done', cycle, messageId }); continue }
      const model = typeof data?.model === 'string' && data.model.startsWith('relay:') ? fixedCode(data.model.slice(6)) : null
      out.push({ ...base, kind: 'call_started', cycle, messageId, purpose: model ?? 'unknown' })
      continue
    }
    if (e.type === 'error') {
      const code = fixedCode(data?.code)
      if (code) out.push({ ...base, kind: 'error', cycle: current, code })
      continue
    }
    if (e.type !== 'agent.note') continue
    const note = relayNote(data?.text)
    if (!note) continue
    const p = note.payload
    switch (note.relay) {
      case 'cycle_begin': { const cycle = count(p.cycle); if (cycle !== null && cycle > 0) { current = cycle; out.push({ ...base, kind: 'cycle_begin', cycle }) } break }
      case 'sealed': { const cycle = count(p.cycle); if (cycle !== null && cycle > 0) out.push({ ...base, kind: 'sealed', cycle }); break }
      case 'probe': {
        const retry = count(p.retry)
        if (retry !== null && typeof p.correct === 'boolean') out.push({ ...base, kind: 'probe', cycle: current, retry, correct: p.correct, damaged: p.damaged === true })
        break
      }
      case 'probe_degraded': out.push({ ...base, kind: 'probe_degraded', cycle: count(p.cycle) ?? current }); break
      case 'context_dropped': out.push({ ...base, kind: 'context_dropped', cycle: count(p.cycle) ?? current, dropped: count(p.dropped) ?? 0, cut: count(p.cut) ?? 0 }); break
      case 'call_retry': out.push({ ...base, kind: 'call_retry', cycle: current, purpose: fixedCode(p.purpose) ?? 'unknown', reason: fixedCode(p.reason) ?? 'unknown' }); break
      case 'call_failed_reason': out.push({ ...base, kind: 'call_failed', cycle: current, purpose: fixedCode(p.purpose) ?? 'unknown', reason: fixedCode(p.reason) ?? 'unknown' }); break
      case 'judge_signals': out.push({ ...base, kind: 'judge_signals', cycle: count(p.cycle) ?? current, phase: fixedCode(p.phase) ?? 'unknown', signals: codes(Array.isArray(p.signals) ? p.signals.map(s => record(s)?.code) : []), unknownFacts: codes(p.unknownFacts) }); break
      case 'initialized': out.push({ ...base, kind: 'initialized', cycle: 0 }); break
      case 'compaction': out.push({ ...base, kind: 'compaction', cycle: current, mode: fixedCode(p.mode) ?? 'unknown', attempt: identifier(p.attempt), epoch: count(p.epoch) }); break
      case 'probe_not_applicable': out.push({ ...base, kind: 'probe_not_applicable', cycle: count(p.cycle) ?? current, damaged: p.damaged === true }); break
      case 'compaction_summary':
        out.push({ ...base, kind: 'compaction_summary', cycle: count(p.cycle) ?? current, attempt: identifier(p.attempt), summaryBytes: count(p.summaryBytes), summaryLimitBytes: count(p.summaryLimitBytes),
          outputLimitTokens: count(p.outputLimitTokens), truncated: p.truncated === true, degraded: p.degraded === true, degradedReason: fixedCode(p.degradedReason),
          inputDropped: count(p.inputDropped) ?? 0, inputCut: count(p.inputCut) ?? 0 })
        break
      case 'cap': out.push({ ...base, kind: 'cap', cycle: current, reason: fixedCode(p.reason) ?? 'unknown' }); break
      default: break
    }
  }
  return out
}

export type SmokeOutcome = 'passed' | 'failed' | 'escalated' | 'cancelled' | 'infra_error' | 'infra_tainted' | 'unknown'
/** Codes that say the infrastructure, not the model or the harness under test, failed. */
const INFRA_CODES: ReadonlySet<string> = new Set(['runtime_meter_unavailable', 'llama_server_unavailable', 'provider_failed', 'relay_workspace_unavailable',
  'cleanup_unconfirmed', 'egress_not_ready', 'stale_lease', 'writer_busy', 'runtime_identity_unknown', 'runtime_count_invalid', 'runtime_counter_mismatch'])
const ESCALATION_CODES: ReadonlySet<string> = new Set(['probe_failed_twice', 'no_progress'])
export type StatusName = 'preparing' | 'running' | 'wrapping_up' | 'input_required' | 'completed' | 'canceled' | 'interrupted' | 'failed'

/** The fixed outcome table. A deadline or an operator stop is `cancelled`; it is never a model failure. */
export function outcomeOf(status: StatusName, statusError: string | null, facts: readonly SmokeFact[], endedBy: 'terminal' | 'deadline' | 'aborted'): SmokeOutcome {
  if (endedBy !== 'terminal') return 'cancelled'
  const lastError = [...facts].reverse().find((f): f is Extract<SmokeFact, { kind: 'error' }> => f.kind === 'error')?.code ?? fixedCode(statusError)
  const failedCall = [...facts].reverse().find((f): f is Extract<SmokeFact, { kind: 'call_failed' }> => f.kind === 'call_failed')?.reason ?? null
  switch (status) {
    case 'completed': return 'passed'
    case 'canceled': return 'cancelled'
    case 'interrupted': return 'infra_error'
    case 'input_required':
    case 'failed':
      if (lastError === 'relay_stopped') return 'cancelled'
      if (lastError && ESCALATION_CODES.has(lastError)) return 'escalated'
      if ((lastError && INFRA_CODES.has(lastError)) || (failedCall && INFRA_CODES.has(failedCall))) return 'infra_error'
      return 'failed'
    case 'preparing': case 'running': case 'wrapping_up': return 'unknown'
  }
}

/** Stable key order, byte-identical to the relay's own canonical form (so a re-hash by the runner is comparable). */
export function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalText).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => JSON.stringify(k) + ':' + canonicalText(v)).join(',') + '}'
  return JSON.stringify(value)
}
export const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

export type ArmMode = 'ledger' | 'naive' | 'mixed' | 'unconfirmed'
/** One sealed cycle as the home database stores it (`relay_seals`): the sealing attempt and the epoch of the seal. */
export interface SealingAttempt { attemptId: string; epoch: number; cycle: number }
/** What armModeOf needs from the home database. `snapshot` is whether the run's own `relay_runs` row was found: a database that has the schema
 * but no row for this run (a wrong or stale file) proves nothing about its attempts. */
export interface SealEvidence { seals: readonly SealingAttempt[]; snapshot: boolean }
/** The arm a run really was, read from its own events and its own seals and from nothing else.
 *
 * A naive attempt writes `{relay:'compaction', mode:'naive', attempt, epoch}` before its first model call; a ledger attempt writes nothing, so the
 * proof of a naive run sits on the naive side: every attempt that sealed a cycle must have its own marker, and every `compaction_summary` must name
 * a marked attempt. A sealing attempt without a marker is a ledger attempt inside a run that also has naive ones: `mixed`. The ledger arm's
 * check is the inverse: no naive note of any kind, and no marker-less hint of one. Anything that cannot be read (no events, an unknown mode, a
 * marker without an attempt id, `evidence` null because the home database was not read, a database without this run's row, or a `sealed` event
 * with no matching `relay_seals` row) is `unconfirmed`, never a guess.
 *
 * A naive attempt never asks the ledger probe, so a `probe` or `probe_degraded` note, or a model call whose purpose is `probe` (the executor writes
 * `assistant.started` before the call, so this survives an attempt killed in the middle of it), is a ledger attempt: `mixed`, whatever the database says.
 * A ledger attempt that is interrupted before it seals anything or starts a probe call leaves no trace in either source; the relay's README states the same limit. */
export function armModeOf(facts: readonly SmokeFact[], evidence: SealEvidence | null): ArmMode {
  if (!facts.length) return 'unconfirmed'
  const markers = facts.filter((f): f is Extract<SmokeFact, { kind: 'compaction' }> => f.kind === 'compaction')
  const summaries = facts.filter((f): f is Extract<SmokeFact, { kind: 'compaction_summary' }> => f.kind === 'compaction_summary')
  if (!markers.length) return summaries.length || facts.some(f => f.kind === 'probe_not_applicable') ? 'unconfirmed' : 'ledger'
  if (markers.some(m => m.mode !== 'naive' || m.attempt === null || m.epoch === null)) return 'unconfirmed'
  if (facts.some(f => f.kind === 'probe' || f.kind === 'probe_degraded' || (f.kind === 'call_started' && f.purpose === 'probe'))) return 'mixed'
  if (evidence === null || !evidence.snapshot) return 'unconfirmed'
  const marked = new Map<string, number>()
  for (const m of markers) {
    // An attempt marks itself once; a second, different statement for it cannot come from the executor.
    if (marked.has(m.attempt!) && marked.get(m.attempt!) !== m.epoch) return 'unconfirmed'
    marked.set(m.attempt!, m.epoch!)
  }
  if (summaries.some(s => s.attempt === null || !marked.has(s.attempt))) return 'unconfirmed'
  const stored = new Set(evidence.seals.map(s => s.cycle))
  if (facts.some(f => f.kind === 'sealed' && !stored.has(f.cycle))) return 'unconfirmed'
  for (const seal of evidence.seals) {
    if (!marked.has(seal.attemptId)) return 'mixed'
    if (marked.get(seal.attemptId) !== seal.epoch) return 'unconfirmed'
  }
  return 'naive'
}
