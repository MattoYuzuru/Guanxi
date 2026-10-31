// B3-b: pure builders from a projected trial observation to B3-a trial slots, and the envelope assembler.
// No IO and no clock: times come from observations and from the caller's `recordedAtMs`. A fact that cannot be
// read becomes `unknown{reason}`; nothing is imputed. Structure is not authenticity (see B3-a).
import {
  relayContextManifestDigest, relayEvidenceDigest, relayGuardManifestDigest, relayItemsManifestDigest, relayPlanDigest,
  relayProbeManifestDigest, type RelayEvidence, type RelayEvidenceKind, type RelayMeasurementInput, type RelayObservedTrial, type RelayPlan, type RelayTrialSlot,
} from './relay-protocol.ts'
import { outcomeOf, sha256Hex, type SmokeFact, type SmokeOutcome, type StatusName } from './relay-smoke-facts.ts'

export interface SealObservation {
  cycle: number
  /** R1 epoch of the attempt that sealed the cycle. */
  epoch: number
  head: string
  items: Record<string, string>
  /** Cumulative gate evidence of the ledger at the seal; outputs are never kept. */
  evidence: ReadonlyArray<{ item: string; head: string; ok: boolean }>
  ledgerSha256: string | null
  handoffLedgerSha256: string | null
  bundleSha256: string | null
  /** The runner's own re-hash of the stored bundle equals the handoff's bundle hash. */
  bundleMatchesHandoff: boolean | null
  /** The stored artifact hash equals the re-hash of the stored handoff. */
  artifactMatchesHandoff: boolean | null
  /** The stored ledger did not have the expected shape; every fact derived from this seal is unknown. */
  unreadable?: true
}
export interface LedgerObservation {
  seals: SealObservation[]
  /** The ledger snapshot at observation time; used for a cycle that never sealed. */
  final: Pick<SealObservation, 'cycle' | 'head' | 'items' | 'evidence'> | null
  /** One row per recorded model call, keyed by the call's message id. */
  costs: ReadonlyArray<{ key: string; inputTokens: number; outputTokens: number }>
}
export interface TrialObservation {
  version: 1
  task: string
  arm: string
  seed: number
  key: string
  /** Digest of everything that decides what this trial measures; a stored observation is reused only under the same fingerprint. */
  fingerprint: string
  runId: string | null
  startedAtMs: number | null
  finishedAtMs: number | null
  status: StatusName | null
  statusError: string | null
  /** The observed loaded window of the stratum; null when the status carried none. */
  windowTokens: number | null
  facts: SmokeFact[]
  ledger: LedgerObservation | null
  /** Fixed code when the home database could not be read; null otherwise. */
  ledgerError: string | null
  endedBy: 'terminal' | 'deadline' | 'aborted' | 'start_failed'
  /** Memory only, never stored: the relay for this key could not be confirmed terminal or stopped, so nothing may start after it. */
  unsettled?: true
}
export interface ArmProfile { id: string; kind: string; ledgerHandoff: boolean; deadEndGuard: boolean }
export interface BuildContext { horizon: number; book: EvidenceBook; arm: ArmProfile }

const SHA = /^[a-f0-9]{64}$/
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/

/** Registers evidence metadata records; digests are filled in once the plan digest is known. */
export class EvidenceBook {
  private readonly rows: Array<Omit<RelayEvidence, 'metaSha256'>> = []
  add(kind: RelayEvidenceKind, task: string | null, arm: string | null, seed: number | null, attempt: string | null, cycle: number | null): string {
    const id = `ev-${this.rows.length + 1}`
    this.rows.push({ id, kind, task, arm, seed, attempt, cycle })
    return id
  }
  get size(): number { return this.rows.length }
  finalize(planSha256: string): RelayEvidence[] {
    return this.rows.map(e => ({ ...e, metaSha256: relayEvidenceDigest(planSha256, e) }))
  }
}

export interface BuiltTrial { slot: RelayTrialSlot; notes: string[] }
const maxOf = (values: readonly number[], floor = 0): number => values.reduce((m, v) => v > m ? v : m, floor)
const minOf = (values: readonly number[]): number | null => values.length ? values.reduce((m, v) => v < m ? v : m, values[0]!) : null
const safeId = (value: string, prefix: string): string => ID.test(value) ? value : `${prefix}-${sha256Hex(value).slice(0, 16)}`

export function missingTrial(task: string, arm: string, seed: number, reason: 'not_collected' | 'unavailable' | 'unsupported'): RelayTrialSlot {
  return { task, arm, seed, state: 'missing', reason }
}

/** Opportunities of cycle k: items whose first gate evidence appears in that cycle; the result is the last gate in it. */
function itemOpportunities(ledger: LedgerObservation, cycle: number): { ok: boolean; opportunities: Array<{ item: string; head: string; result: 'passed' | 'failed' }>; unassessable: boolean } {
  const bySeal = new Map(ledger.seals.map(s => [s.cycle, s]))
  const snapshot = (k: number) => bySeal.get(k) ?? (ledger.final && ledger.final.cycle === k ? ledger.final : null)
  const here = snapshot(cycle)
  // The evidence of a cycle is the tail past the previous cycle's: an unreadable seal makes it and the next cycle unassessable.
  if (!here || ('unreadable' in here && here.unreadable) || (cycle > 1 && bySeal.get(cycle - 1)?.unreadable)) return { ok: false, opportunities: [], unassessable: true }
  // The evidence list is append-only, so the entries added in this cycle are the tail past the previous snapshot.
  let seenBefore = 0
  const touchedBefore = new Set<string>()
  for (let k = cycle - 1; k >= 1; k--) {
    const earlier = snapshot(k)
    if (earlier) { seenBefore = earlier.evidence.length; break }
  }
  for (const e of here.evidence.slice(0, seenBefore)) touchedBefore.add(e.item)
  const added = here.evidence.slice(seenBefore)
  const lastOf = new Map<string, { head: string; ok: boolean }>()
  for (const e of added) if (!touchedBefore.has(e.item)) lastOf.set(e.item, { head: e.head, ok: e.ok })
  const opportunities = [...lastOf].map(([item, v]) => ({ item, head: v.head, result: (v.ok ? 'passed' : 'failed') as 'passed' | 'failed' }))
  return { ok: true, opportunities, unassessable: false }
}

type Group<T> = { state: 'unknown'; reason: 'not_collected' | 'unavailable' | 'unsupported' | 'not_reached' } | T

/** Builds one observed-trial slot, or an explicit `missing` slot when the run never produced an observation. */
export function buildTrialSlot(ctx: BuildContext, obs: TrialObservation, plan: Pick<RelayPlan, 'acceptanceSha256'>): BuiltTrial {
  const { book, arm, horizon } = ctx
  const { task, seed } = obs
  const notes: string[] = []
  if (obs.endedBy === 'start_failed' || obs.runId === null || obs.status === null) return { slot: missingTrial(task, arm.id, seed, obs.endedBy === 'start_failed' ? 'unavailable' : 'not_collected'), notes: ['no_run_observed'] }

  const facts = obs.facts
  const ledger = obs.ledger
  const begins = new Map<number, Extract<SmokeFact, { kind: 'cycle_begin' }>>()
  for (const f of facts) if (f.kind === 'cycle_begin' && !begins.has(f.cycle)) begins.set(f.cycle, f)
  const highest = maxOf([...begins.keys(), ...(ledger?.seals.map(s => s.cycle) ?? [])])
  if (highest > horizon) notes.push('cycles_beyond_horizon')
  const last = Math.min(highest, horizon)

  // Attempts: one per distinct epoch of the seals; a single synthetic first attempt when no seal is readable.
  const epochs = [...new Set(ledger?.seals.map(s => s.epoch) ?? [])].sort((a, b) => a - b)
  const attemptList = (epochs.length ? epochs : [1]).map(epoch => ({ id: `att-${epoch}`, epoch }))
  const attemptOf = (cycle: number): string => {
    const seal = ledger?.seals.find(s => s.cycle === cycle)
    return seal ? `att-${seal.epoch}` : attemptList[attemptList.length - 1]!.id
  }
  const attempts = attemptList.map(a => ({ id: a.id, epoch: a.epoch, receiptRef: book.add('attempt_receipt', task, arm.id, seed, a.id, null) }))

  const factTimes = facts.map(f => f.atMs)
  const firstAt = minOf(factTimes)
  const lastAt = factTimes.length ? maxOf(factTimes) : null
  const startMs = obs.startedAtMs === null ? firstAt : firstAt === null ? obs.startedAtMs : Math.min(obs.startedAtMs, firstAt)
  const sealAt = new Map<number, number>()
  for (const f of facts) if (f.kind === 'sealed' && !sealAt.has(f.cycle)) sealAt.set(f.cycle, f.atMs)

  const cycles: unknown[] = []
  let previousEnd: number | null = null
  for (let k = 1; k <= horizon; k++) {
    if (k > last) { cycles.push({ ordinal: k, state: 'not_reached', reason: 'not_reached' }); continue }
    const begin = begins.get(k)
    if (!begin) { cycles.push({ ordinal: k, state: 'unknown', reason: 'unavailable' }); continue }
    const inCycle = facts.filter(f => f.cycle === k)
    const start = Math.max(begin.atMs, previousEnd ?? 0, startMs ?? 0)
    const end = Math.max(start, sealAt.get(k) ?? maxOf(inCycle.map(f => f.atMs)))
    previousEnd = end
    const attempt = attemptOf(k)
    const e = (kind: RelayEvidenceKind) => book.add(kind, task, arm.id, seed, attempt, k)
    const receiptRef = e('cycle_receipt')

    // items
    let items: Group<unknown>
    if (!ledger) items = { state: 'unknown', reason: 'not_collected' }
    else {
      const found = itemOpportunities(ledger, k)
      if (found.unassessable) items = { state: 'unknown', reason: 'unavailable' }
      else {
        const opportunities = found.opportunities.map(o => o.item)
        items = {
          state: 'observed',
          manifest: { ref: e('assignment_manifest'), sha256: relayItemsManifestDigest(opportunities), assignedAtMs: start, opportunities },
          assessments: found.opportunities.map(o => REVISION.test(o.head)
            ? { opportunity: o.item, state: 'observed', ref: e('verifier_result'), head: o.head, acceptanceSha256: plan.acceptanceSha256, assessedAtMs: end, result: o.result }
            : { opportunity: o.item, state: 'unknown', reason: 'unavailable' }),
        }
      }
    }

    // probes: the relay records only whole-answer correctness, so no critical-field occasion exists.
    let probes: Group<unknown>
    const probeFacts = inCycle.filter((f): f is Extract<SmokeFact, { kind: 'probe' }> => f.kind === 'probe').sort((a, b) => a.retry - b.retry)
    if (!probeFacts.length && k > 1) probes = { state: 'unknown', reason: 'unavailable' }
    else {
      const occasions = probeFacts.length ? [{ id: 'p-whole', scope: 'whole_answer' as const, field: null }] : []
      probes = {
        state: 'observed',
        manifest: { ref: e('probe_manifest'), sha256: relayProbeManifestDigest(occasions), occasions },
        grades: probeFacts.map((f, i) => ({ occasion: 'p-whole', attempt: i + 1, state: 'observed', ref: e('probe_grading'), result: f.correct && !f.damaged ? 'correct' : 'incorrect' })),
      }
    }

    // context: one sample per recorded call, from the call/cost join. Without the home database it is unknown.
    let context: Group<unknown>
    if (!ledger) context = { state: 'unknown', reason: 'not_collected' }
    else {
      const costOf = new Map(ledger.costs.map(c => [c.key, c]))
      const calls = inCycle.filter((f): f is Extract<SmokeFact, { kind: 'call_done' }> => f.kind === 'call_done')
      const truncations = inCycle.filter(f => f.kind === 'error' && f.code === 'truncation_protocol').length
      const samples = calls.map(c => ({ id: safeId(`s-${c.messageId}`, 's'), cost: costOf.get(c.messageId) ?? null }))
      const lastObserved = samples.map(s => s.cost !== null && obs.windowTokens !== null).lastIndexOf(true)
      if (truncations > 0 && lastObserved < 0) notes.push('truncation_unattached')
      context = {
        state: 'observed',
        manifest: { ref: e('context_manifest'), sha256: relayContextManifestDigest(samples.map(s => s.id)), samples: samples.map(s => s.id) },
        samples: samples.map((s, i) => s.cost && obs.windowTokens !== null
          ? { sample: s.id, state: 'observed', ref: e('runtime_sample'), actualWindowTokens: obs.windowTokens, renderedTokens: s.cost.inputTokens, truncationEvents: i === lastObserved ? truncations : 0 }
          : { sample: s.id, state: 'unknown', reason: 'unavailable' }),
      }
    }

    // guards: only when the judge observer saw dead ends; the relay itself has no per-check guard record.
    let guards: Group<unknown>
    const judged = inCycle.filter((f): f is Extract<SmokeFact, { kind: 'judge_signals' }> => f.kind === 'judge_signals')
    if (!judged.length || judged.some(f => f.unknownFacts.includes('deadEnds'))) guards = { state: 'unknown', reason: 'not_collected' }
    else {
      const checks = [{ id: `g-${k}`, deadEnd: 'repeated-dead-end' }]
      guards = {
        state: 'observed',
        manifest: { ref: e('guard_manifest'), sha256: relayGuardManifestDigest(checks), checks },
        checks: [{ check: `g-${k}`, state: 'observed', ref: e('guard_observation'), guardActive: arm.deadEndGuard, repeated: judged.some(f => f.signals.includes('repeated_dead_end')) }],
      }
    }

    // integrity: the runner's own re-hash of the stored seal against the handoff it carries.
    let integrity: Group<unknown>
    const seal = ledger?.seals.find(s => s.cycle === k)
    if (!arm.ledgerHandoff) integrity = { state: 'unknown', reason: 'unsupported' }
    else if (!ledger) integrity = { state: 'unknown', reason: 'not_collected' }
    else if (!seal || seal.unreadable || !seal.ledgerSha256 || !seal.handoffLedgerSha256 || !seal.bundleSha256 || ![seal.ledgerSha256, seal.handoffLedgerSha256, seal.bundleSha256].every(h => SHA.test(h))) integrity = { state: 'unknown', reason: 'unavailable' }
    else {
      const agrees = seal.ledgerSha256 === seal.handoffLedgerSha256 && seal.bundleMatchesHandoff === true && seal.artifactMatchesHandoff === true
      integrity = { state: 'observed', ref: e('seal_reference'), value: { ledgerSha256: seal.ledgerSha256, handoffLedgerSha256: seal.handoffLedgerSha256, bundleSha256: seal.bundleSha256, reportedValidation: agrees ? 'passed' : 'failed' } }
    }

    cycles.push({ ordinal: k, state: 'observed', attempt, receiptRef, startedAtMs: start, endedAtMs: end, items, probes, context, guards, integrity })
  }

  const outcome: SmokeOutcome = outcomeOf(obs.status, obs.statusError, facts, obs.endedBy)
  if (ledger) {
    const touched = new Set((ledger.final?.evidence ?? ledger.seals[ledger.seals.length - 1]?.evidence ?? []).map(x => x.item))
    const all = Object.keys(ledger.final?.items ?? ledger.seals[ledger.seals.length - 1]?.items ?? {})
    const unassessed = all.filter(i => !touched.has(i)).sort()
    if (unassessed.length) notes.push(`items_never_assessed:${unassessed.join(',')}`)
  }
  const finishMs = Math.max(obs.finishedAtMs ?? 0, lastAt ?? 0, previousEnd ?? 0)
  const slot: RelayTrialSlot = {
    task, arm: arm.id, seed, state: 'observed', runId: safeId(obs.runId, 'run'), outcome, attempts,
    startedAtMs: startMs === null ? { state: 'unknown', reason: 'not_collected' } : { state: 'observed', value: startMs },
    finishedAtMs: finishMs > 0 ? { state: 'observed', value: Math.max(finishMs, startMs ?? 0) } : { state: 'unknown', reason: 'not_collected' },
    cycles: cycles as RelayObservedTrial['cycles'],
    forecasts: [],
  }
  return { slot, notes }
}

export interface AssembleInput {
  plan: RelayPlan
  origin: 'synthetic_fixture' | 'recorded_observation'
  trials: RelayTrialSlot[]
  book: EvidenceBook
  recordedAtMs: number
  analysisAsOfMs: number
}
/** The raw envelope (before validation). Digests of the plan and of every evidence record are computed here. */
export function assembleMeasurement(input: AssembleInput): RelayMeasurementInput {
  const planSha256 = relayPlanDigest(input.plan)
  return {
    format: 'guanxi.b3.measurement/v1', declaredOrigin: input.origin, recordedAtMs: input.recordedAtMs, analysisAsOfMs: input.analysisAsOfMs,
    plan: input.plan, planSha256, evidence: input.book.finalize(planSha256), trials: input.trials,
  }
}
