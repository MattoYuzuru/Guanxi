// B3-a: offline evidence envelope for the relay benchmark. Pure parsing and structural
// validation. No IO, no clock, no model call. Structure is not authenticity: nothing here can
// prove that a referenced event, seal or run exists. See docs/plans/lanes/B3-a.plan.md.
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const RELAY_MEASUREMENT_FORMAT = 'guanxi.b3.measurement/v1' as const
export const RELAY_ARM_KINDS = ['ledger_relay', 'naive_compaction', 'observation_masking', 'single_large_window', 'mini_swe_control'] as const
export const RELAY_FIELD_KEYS = ['ledgerHash', 'head', 'revision', 'nextItem', 'nextStatus'] as const
export const RELAY_REASONS = ['not_collected', 'unavailable', 'purged', 'not_reached', 'infra_tainted', 'unsupported', 'verifier_missing', 'source_unverified'] as const
export const RELAY_OUTCOMES = ['passed', 'failed', 'escalated', 'cancelled', 'infra_error', 'infra_tainted', 'unknown'] as const
export const RELAY_EVIDENCE_KINDS = ['calibration', 'arm_declaration', 'attempt_receipt', 'cycle_receipt', 'assignment_manifest', 'verifier_result',
  'probe_manifest', 'probe_grading', 'context_manifest', 'runtime_sample', 'guard_manifest', 'guard_observation', 'seal_reference', 'forecast_record'] as const
export const RELAY_ERROR_CODES = ['schema_invalid', 'identity_mismatch', 'duplicate_key', 'missing_slot', 'chronology_invalid', 'reference_mismatch'] as const
export type RelayErrorCode = typeof RELAY_ERROR_CODES[number]
export type RelayEvidenceKind = typeof RELAY_EVIDENCE_KINDS[number]

const MAX_HORIZON = 64
const MAX_ISSUES = 50
const MAX_EVIDENCE = 50_000
const MAX_TRIALS = 10_000
const MAX_TASKS = 64
const MAX_SEEDS = 16
const MAX_ATTEMPTS = 16
const MAX_ITEM_ROWS = 256
const MAX_PROBE_OCCASIONS = 64
const MAX_PROBE_GRADES = 512
const MAX_CONTEXT_ROWS = 256
const MAX_GUARD_ROWS = 256
// Opaque identifiers: never paths, URLs or free text, never opened or fetched.
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/)
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const posint = uint.positive()
const ordinal = z.number().int().min(1).max(MAX_HORIZON)
const reason = z.enum(RELAY_REASONS)
const unknown = z.object({ state: z.literal('unknown'), reason }).strict()
const orUnknown = <T extends z.AnyZodObject>(observed: T) => z.discriminatedUnion('state', [unknown, observed])
const observedValue = <T extends z.ZodTypeAny>(value: T) => z.object({ state: z.literal('observed'), value }).strict()
const observedFact = <T extends z.ZodTypeAny>(value: T) => z.object({ state: z.literal('observed'), ref: id, value }).strict()

const itemsGroup = orUnknown(z.object({
  state: z.literal('observed'),
  manifest: z.object({ ref: id, sha256: sha, assignedAtMs: uint, opportunities: z.array(id).max(MAX_ITEM_ROWS) }).strict(),
  assessments: z.array(z.discriminatedUnion('state', [
    z.object({ opportunity: id, state: z.literal('unknown'), reason }).strict(),
    // `head` is reported structure only: evidence metadata carries no head field to bind it to.
    z.object({ opportunity: id, state: z.literal('observed'), ref: id, head: revision, acceptanceSha256: sha, assessedAtMs: uint, result: z.enum(['passed', 'failed']) }).strict(),
  ])).max(MAX_ITEM_ROWS),
}).strict())
const probesGroup = orUnknown(z.object({
  state: z.literal('observed'),
  manifest: z.object({ ref: id, sha256: sha, occasions: z.array(z.object({ id, scope: z.enum(['whole_answer', 'critical_field']), field: z.enum(RELAY_FIELD_KEYS).nullable() }).strict()).max(MAX_PROBE_OCCASIONS) }).strict(),
  grades: z.array(z.discriminatedUnion('state', [
    z.object({ occasion: id, attempt: z.number().int().min(1).max(8), state: z.literal('unknown'), reason }).strict(),
    z.object({ occasion: id, attempt: z.number().int().min(1).max(8), state: z.literal('observed'), ref: id, result: z.enum(['correct', 'incorrect']) }).strict(),
  ])).max(MAX_PROBE_GRADES),
}).strict())
const contextGroup = orUnknown(z.object({
  state: z.literal('observed'),
  manifest: z.object({ ref: id, sha256: sha, samples: z.array(id).max(MAX_CONTEXT_ROWS) }).strict(),
  samples: z.array(z.discriminatedUnion('state', [
    z.object({ sample: id, state: z.literal('unknown'), reason }).strict(),
    z.object({ sample: id, state: z.literal('observed'), ref: id, actualWindowTokens: posint, renderedTokens: uint, truncationEvents: uint }).strict(),
  ])).max(MAX_CONTEXT_ROWS),
}).strict())
const guardsGroup = orUnknown(z.object({
  state: z.literal('observed'),
  manifest: z.object({ ref: id, sha256: sha, checks: z.array(z.object({ id, deadEnd: id }).strict()).max(MAX_GUARD_ROWS) }).strict(),
  checks: z.array(z.discriminatedUnion('state', [
    z.object({ check: id, state: z.literal('unknown'), reason }).strict(),
    z.object({ check: id, state: z.literal('observed'), ref: id, guardActive: z.boolean(), repeated: z.boolean() }).strict(),
  ])).max(MAX_GUARD_ROWS),
}).strict())
const integrityGroup = orUnknown(observedFact(z.object({
  ledgerSha256: sha, handoffLedgerSha256: sha, bundleSha256: sha, reportedValidation: z.enum(['passed', 'failed']),
}).strict()))

const cycleSlot = z.discriminatedUnion('state', [
  z.object({
    ordinal, state: z.literal('observed'), attempt: id, receiptRef: id, startedAtMs: uint, endedAtMs: uint,
    items: itemsGroup, probes: probesGroup, context: contextGroup, guards: guardsGroup, integrity: integrityGroup,
  }).strict(),
  z.object({ ordinal, state: z.literal('unknown'), reason }).strict(),
  z.object({ ordinal, state: z.literal('not_reached'), reason: z.enum(['not_reached', 'infra_tainted']) }).strict(),
])
const forecast = z.object({
  id, cycle: ordinal, ref: id, issuedAtMs: uint, cohortId: id, p80RemainingMs: uint, taint: z.enum(['none', 'tainted']),
}).strict()
const trialSlot = z.discriminatedUnion('state', [
  z.object({ task: id, arm: id, seed: uint, state: z.literal('missing'), reason }).strict(),
  z.object({
    task: id, arm: id, seed: uint, state: z.literal('observed'), runId: id, outcome: z.enum(RELAY_OUTCOMES),
    attempts: z.array(z.object({ id, epoch: uint, receiptRef: id }).strict()).min(1).max(MAX_ATTEMPTS),
    startedAtMs: orUnknown(observedValue(uint)), finishedAtMs: orUnknown(observedValue(uint)),
    cycles: z.array(cycleSlot).max(MAX_HORIZON), forecasts: z.array(forecast).max(MAX_HORIZON),
  }).strict(),
])
const evidence = z.object({
  id, kind: z.enum(RELAY_EVIDENCE_KINDS), task: id.nullable(), arm: id.nullable(), seed: uint.nullable(),
  attempt: id.nullable(), cycle: ordinal.nullable(), metaSha256: sha,
}).strict()
const arm = z.object({
  id, kind: z.enum(RELAY_ARM_KINDS), harnessSha256: sha,
  availability: z.discriminatedUnion('state', [
    z.object({ state: z.literal('planned') }).strict(),
    z.object({ state: z.literal('unsupported'), reason: z.literal('unsupported'), ref: id }).strict(),
  ]),
}).strict()
const planSchema = z.object({
  experimentId: id,
  stratum: z.object({
    provider: id, model: id, revision: id,
    quantization: z.discriminatedUnion('kind', [z.object({ kind: z.literal('not_applicable') }).strict(), z.object({ kind: z.literal('quantized'), id }).strict()]),
    runtimeSha256: sha, adapterSha256: sha, resourceProfileSha256: sha, windowTokens: posint, tokenCountConvention: id,
    eCalibration: orUnknown(z.object({ state: z.literal('observed'), ref: id, effectiveTokens: posint }).strict()),
  }).strict(),
  taskManifestSha256: sha, acceptanceSha256: sha, verifierSetSha256: sha, sourceCommit: revision,
  tasks: z.array(id).min(1).max(MAX_TASKS), seeds: z.array(uint).min(1).max(MAX_SEEDS), arms: z.array(arm).min(1).max(RELAY_ARM_KINDS.length),
  horizon: ordinal, eta: z.object({ selectionCycle: ordinal, cohortId: id }).strict(),
}).strict()
export const relayMeasurementSchema = z.object({
  format: z.literal(RELAY_MEASUREMENT_FORMAT),
  declaredOrigin: z.enum(['synthetic_fixture', 'recorded_observation']),
  recordedAtMs: uint, analysisAsOfMs: uint,
  plan: planSchema, planSha256: sha,
  evidence: z.array(evidence).max(MAX_EVIDENCE), trials: z.array(trialSlot).max(MAX_TRIALS),
}).strict()
export type RelayMeasurementInput = z.infer<typeof relayMeasurementSchema>
export type RelayPlan = z.infer<typeof planSchema>
export type RelayEvidence = z.infer<typeof evidence>
export type RelayTrialSlot = z.infer<typeof trialSlot>
export type RelayObservedTrial = Extract<RelayTrialSlot, { state: 'observed' }>
export type RelayCycleSlot = z.infer<typeof cycleSlot>
export type RelayObservedCycle = Extract<RelayCycleSlot, { state: 'observed' }>
export type RelayArmKind = typeof RELAY_ARM_KINDS[number]

// Documented digest encodings: JSON of fixed-field tuples; unordered sets sorted by value.
const digest = (tuple: unknown) => createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
export function relayPlanDigest(plan: RelayPlan): string {
  const s = plan.stratum
  return digest(['guanxi.b3.plan/v1', plan.experimentId,
    [s.provider, s.model, s.revision, s.quantization.kind, s.quantization.kind === 'quantized' ? s.quantization.id : null, s.runtimeSha256, s.adapterSha256,
      s.resourceProfileSha256, s.windowTokens, s.tokenCountConvention,
      s.eCalibration.state === 'observed' ? ['observed', s.eCalibration.ref, s.eCalibration.effectiveTokens] : ['unknown', s.eCalibration.reason]],
    plan.taskManifestSha256, plan.acceptanceSha256, plan.verifierSetSha256, plan.sourceCommit,
    [...plan.tasks].sort(), [...plan.seeds].sort((a, b) => a - b),
    [...plan.arms].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(a => [a.id, a.kind, a.harnessSha256, a.availability.state, a.availability.state === 'unsupported' ? a.availability.ref : null]),
    plan.horizon, plan.eta.selectionCycle, plan.eta.cohortId])
}
export function relayEvidenceDigest(planSha256: string, e: Omit<RelayEvidence, 'metaSha256'>): string {
  return digest(['guanxi.b3.evidence/v1', planSha256, e.id, e.kind, e.task, e.arm, e.seed, e.attempt, e.cycle])
}
const rowsDigest = (kind: string, rows: ReadonlyArray<ReadonlyArray<string | null>>) =>
  digest(['guanxi.b3.manifest/v1', kind, rows.map(r => JSON.stringify(r)).sort()])
export const relayItemsManifestDigest = (opportunities: readonly string[]) => rowsDigest('items', opportunities.map(o => [o]))
export const relayProbeManifestDigest = (occasions: ReadonlyArray<{ id: string; scope: string; field: string | null }>) => rowsDigest('probes', occasions.map(o => [o.id, o.scope, o.field]))
export const relayContextManifestDigest = (samples: readonly string[]) => rowsDigest('context', samples.map(o => [o]))
export const relayGuardManifestDigest = (checks: ReadonlyArray<{ id: string; deadEnd: string }>) => rowsDigest('guards', checks.map(o => [o.id, o.deadEnd]))

export interface RelayIssue { code: RelayErrorCode; rule: string; location: string }
/** Fixed codes only. Neither the message nor the issues ever echo supplied values. */
export class RelayMeasurementError extends Error {
  readonly code: RelayErrorCode
  readonly issues: readonly RelayIssue[]
  constructor(issues: readonly RelayIssue[]) {
    const first = issues[0] ?? { code: 'schema_invalid' as const, rule: 'schema', location: '' }
    super(`relay_measurement_${first.code}`)
    this.name = 'RelayMeasurementError'
    this.code = first.code
    this.issues = Object.freeze(issues.map(i => Object.freeze({ ...i })))
  }
}
export type RelayCheck =
  | { ok: true; value: RelayMeasurementInput; referencedEvidence: ReadonlySet<string> }
  | { ok: false; issues: readonly RelayIssue[] }

function safeLocation(path: ReadonlyArray<string | number>): string {
  return path.map(p => typeof p === 'number' ? `[${p}]` : /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(p) ? `.${p}` : '.?').join('').replace(/^\./, '')
}
class Issues {
  readonly list: RelayIssue[] = []
  add(code: RelayErrorCode, rule: string, location: string): void { if (this.list.length < MAX_ISSUES) this.list.push({ code, rule, location }) }
}
// Kinds whose metadata record stands for exactly one observation. A verifier run may back several items.
const SINGLE_USE: ReadonlySet<RelayEvidenceKind> = new Set(['attempt_receipt', 'cycle_receipt', 'probe_grading', 'runtime_sample', 'guard_observation', 'seal_reference', 'forecast_record'])
const seen = <T>(values: readonly T[], onDup: (v: T, i: number) => void): Set<T> => {
  const out = new Set<T>()
  values.forEach((v, i) => { if (out.has(v)) onDup(v, i); out.add(v) })
  return out
}

type Ctx = { task: string | null; arm: string | null; seed: number | null; attempt: string | null; cycle: number | null }
function validateStructure(input: RelayMeasurementInput, out: Issues): Set<string> {
  const { plan } = input
  const referenced = new Set<string>()
  if (input.recordedAtMs > input.analysisAsOfMs) out.add('chronology_invalid', 'recorded_after_analysis', 'recordedAtMs')
  if (relayPlanDigest(plan) !== input.planSha256) out.add('identity_mismatch', 'plan_digest', 'planSha256')
  const tasks = seen(plan.tasks, (_, i) => out.add('duplicate_key', 'task_repeat', `plan.tasks[${i}]`))
  const seeds = seen(plan.seeds, (_, i) => out.add('duplicate_key', 'seed_repeat', `plan.seeds[${i}]`))
  const arms = new Map(plan.arms.map(a => [a.id, a]))
  seen(plan.arms.map(a => a.id), (_, i) => out.add('duplicate_key', 'arm_repeat', `plan.arms[${i}]`))
  seen(plan.arms.map(a => a.kind), (_, i) => out.add('duplicate_key', 'arm_kind_repeat', `plan.arms[${i}]`))
  if (plan.eta.selectionCycle > plan.horizon) out.add('schema_invalid', 'eta_cycle_range', 'plan.eta.selectionCycle')

  const registry = new Map<string, RelayEvidence>()
  input.evidence.forEach((e, i) => {
    const at = `evidence[${i}]`
    if (registry.has(e.id)) out.add('duplicate_key', 'evidence_repeat', at)
    registry.set(e.id, e)
    if (relayEvidenceDigest(input.planSha256, e) !== e.metaSha256) out.add('reference_mismatch', 'evidence_digest', at)
    if ((e.task !== null && !tasks.has(e.task)) || (e.arm !== null && !arms.has(e.arm)) || (e.seed !== null && !seeds.has(e.seed))) out.add('identity_mismatch', 'evidence_foreign', at)
  })
  const resolve = (ref: string, kind: RelayEvidenceKind, ctx: Ctx, at: string) => {
    const e = registry.get(ref)
    if (!e) { out.add('reference_mismatch', 'ref_unresolved', at); return }
    if (referenced.has(ref) && SINGLE_USE.has(e.kind)) out.add('reference_mismatch', 'ref_reuse', at)
    referenced.add(ref)
    if (e.kind !== kind) out.add('reference_mismatch', 'ref_kind', at)
    else if (e.task !== ctx.task || e.arm !== ctx.arm || e.seed !== ctx.seed || e.attempt !== ctx.attempt || e.cycle !== ctx.cycle) out.add('reference_mismatch', 'ref_binding', at)
  }
  const planCtx: Ctx = { task: null, arm: null, seed: null, attempt: null, cycle: null }
  if (plan.stratum.eCalibration.state === 'observed') resolve(plan.stratum.eCalibration.ref, 'calibration', planCtx, 'plan.stratum.eCalibration')
  plan.arms.forEach((a, i) => { if (a.availability.state === 'unsupported') resolve(a.availability.ref, 'arm_declaration', planCtx, `plan.arms[${i}].availability`) })

  const planned = new Set(plan.arms.filter(a => a.availability.state === 'planned').map(a => a.id))
  const keyOf = (t: string, a: string, s: number) => JSON.stringify([t, a, s])
  const present = new Set<string>()
  input.trials.forEach((t, i) => {
    const at = `trials[${i}]`
    if (!tasks.has(t.task) || !planned.has(t.arm) || !seeds.has(t.seed)) { out.add('identity_mismatch', 'trial_key_foreign', at); return }
    const key = keyOf(t.task, t.arm, t.seed)
    if (present.has(key)) { out.add('duplicate_key', 'trial_key_repeat', at); return }
    present.add(key)
    if (t.state === 'observed') validateTrial(input, t, at, resolve, out)
  })
  for (const task of tasks) for (const a of planned) for (const seed of seeds) {
    if (!present.has(keyOf(task, a, seed))) out.add('missing_slot', 'trial_omitted', 'trials')
  }
  return referenced
}

type Resolve = (ref: string, kind: RelayEvidenceKind, ctx: Ctx, at: string) => void
function validateTrial(input: RelayMeasurementInput, t: RelayObservedTrial, at: string, resolve: Resolve, out: Issues): void {
  const { plan, recordedAtMs } = input
  const base = { task: t.task, arm: t.arm, seed: t.seed }
  const attemptIds = t.attempts.map(a => a.id)
  seen(attemptIds, (_, i) => out.add('duplicate_key', 'attempt_repeat', `${at}.attempts[${i}]`))
  t.attempts.forEach((a, i) => {
    if (i > 0 && a.epoch <= t.attempts[i - 1]!.epoch) out.add('chronology_invalid', 'attempt_epoch_order', `${at}.attempts[${i}]`)
    resolve(a.receiptRef, 'attempt_receipt', { ...base, attempt: a.id, cycle: null }, `${at}.attempts[${i}].receiptRef`)
  })
  const started = t.startedAtMs.state === 'observed' ? t.startedAtMs.value : null
  const finished = t.finishedAtMs.state === 'observed' ? t.finishedAtMs.value : null
  if (started !== null && finished !== null && started > finished) out.add('chronology_invalid', 'trial_span', at)
  if ((started ?? 0) > recordedAtMs || (finished ?? 0) > recordedAtMs) out.add('chronology_invalid', 'after_recorded', at)

  if (t.cycles.length !== plan.horizon) out.add('missing_slot', 'cycle_slots', `${at}.cycles`)
  let terminal = false
  let previousAttempt = -1
  let previousEnd: number | null = null
  const opportunityIds = new Set<string>()
  const ordinalsSeen = new Set<number>()
  t.cycles.forEach((c, i) => {
    const cat = `${at}.cycles[${i}]`
    if (ordinalsSeen.has(c.ordinal)) out.add('duplicate_key', 'cycle_repeat', cat)
    else if (c.ordinal !== i + 1) out.add('chronology_invalid', 'cycle_order', cat)
    ordinalsSeen.add(c.ordinal)
    if (c.state === 'not_reached') { terminal = true; return }
    if (terminal) out.add('chronology_invalid', 'cycle_after_terminal', cat)
    if (c.state === 'observed') validateCycle(input, t, c, cat, base, { previousAttempt, previousEnd, started, finished }, opportunityIds, resolve, out)
    if (c.state === 'observed') {
      const index = attemptIds.indexOf(c.attempt)
      if (index >= 0) previousAttempt = Math.max(previousAttempt, index)
      previousEnd = c.endedAtMs
    }
  })

  const forecastCycles = new Set<number>()
  const forecastIds = new Set<string>()
  t.forecasts.forEach((f, i) => {
    const fat = `${at}.forecasts[${i}]`
    if (forecastIds.has(f.id)) out.add('duplicate_key', 'forecast_repeat', fat)
    forecastIds.add(f.id)
    if (forecastCycles.has(f.cycle)) out.add('duplicate_key', 'forecast_cycle_repeat', fat)
    forecastCycles.add(f.cycle)
    if (f.cycle > plan.horizon) out.add('schema_invalid', 'forecast_cycle_range', fat)
    resolve(f.ref, 'forecast_record', { ...base, attempt: null, cycle: f.cycle }, `${fat}.ref`)
    if (f.issuedAtMs > recordedAtMs) out.add('chronology_invalid', 'after_recorded', fat)
    if (finished !== null && f.issuedAtMs > finished) out.add('chronology_invalid', 'forecast_after_completion', fat)
    if (started !== null && f.issuedAtMs < started) out.add('chronology_invalid', 'forecast_before_start', fat)
    const keyed = t.cycles.find(c => c.state === 'observed' && c.ordinal === f.cycle)
    if (keyed?.state === 'observed' && f.issuedAtMs > keyed.endedAtMs) out.add('chronology_invalid', 'forecast_after_cycle', fat)
    if (t.cycles.some(c => c.state === 'not_reached' && c.ordinal === f.cycle)) out.add('chronology_invalid', 'forecast_cycle_not_reached', fat)
  })
}

interface CycleBounds { previousAttempt: number; previousEnd: number | null; started: number | null; finished: number | null }
function validateCycle(input: RelayMeasurementInput, t: RelayObservedTrial, c: RelayObservedCycle, at: string, base: { task: string; arm: string; seed: number },
  bounds: CycleBounds, opportunityIds: Set<string>, resolve: Resolve, out: Issues): void {
  const { plan, recordedAtMs } = input
  const index = t.attempts.findIndex(a => a.id === c.attempt)
  if (index < 0) out.add('reference_mismatch', 'cycle_attempt_unknown', `${at}.attempt`)
  else if (index < bounds.previousAttempt) out.add('chronology_invalid', 'cycle_attempt_regress', `${at}.attempt`)
  const ctx: Ctx = { ...base, attempt: c.attempt, cycle: c.ordinal }
  resolve(c.receiptRef, 'cycle_receipt', ctx, `${at}.receiptRef`)
  if (c.startedAtMs > c.endedAtMs) out.add('chronology_invalid', 'cycle_span', at)
  if (c.endedAtMs > recordedAtMs) out.add('chronology_invalid', 'after_recorded', at)
  if (bounds.previousEnd !== null && c.startedAtMs < bounds.previousEnd) out.add('chronology_invalid', 'cycle_overlap', at)
  if (bounds.started !== null && c.startedAtMs < bounds.started) out.add('chronology_invalid', 'cycle_before_trial', at)
  if (bounds.finished !== null && c.endedAtMs > bounds.finished) out.add('chronology_invalid', 'cycle_after_trial', at)

  // Each group: the supplied manifest must match its digest and the rows must cover it exactly.
  const coverage = (manifestIds: readonly string[], rowIds: readonly string[], rule: string, where: string) => {
    seen(manifestIds, (_, i) => out.add('duplicate_key', `${rule}_manifest_repeat`, `${where}.manifest[${i}]`))
    const manifest = new Set(manifestIds)
    const rows = new Set<string>()
    rowIds.forEach((r, i) => {
      if (!manifest.has(r)) out.add('identity_mismatch', `${rule}_row_foreign`, `${where}[${i}]`)
      else if (rows.has(r)) out.add('duplicate_key', `${rule}_row_repeat`, `${where}[${i}]`)
      rows.add(r)
    })
    for (const m of manifest) if (!rows.has(m)) out.add('missing_slot', `${rule}_row_omitted`, where)
  }
  const items = c.items
  if (items.state === 'observed') {
    const g = `${at}.items`
    resolve(items.manifest.ref, 'assignment_manifest', ctx, `${g}.manifest.ref`)
    if (relayItemsManifestDigest(items.manifest.opportunities) !== items.manifest.sha256) out.add('reference_mismatch', 'manifest_digest', `${g}.manifest`)
    if (items.manifest.assignedAtMs < c.startedAtMs || items.manifest.assignedAtMs > c.endedAtMs) out.add('chronology_invalid', 'assignment_outside_cycle', `${g}.manifest`)
    items.manifest.opportunities.forEach((o, i) => {
      if (opportunityIds.has(o)) out.add('duplicate_key', 'opportunity_repeat', `${g}.manifest.opportunities[${i}]`)
      opportunityIds.add(o)
    })
    coverage(items.manifest.opportunities, items.assessments.map(a => a.opportunity), 'assessment', `${g}.assessments`)
    items.assessments.forEach((a, i) => {
      if (a.state !== 'observed') return
      const aat = `${g}.assessments[${i}]`
      resolve(a.ref, 'verifier_result', ctx, `${aat}.ref`)
      if (a.acceptanceSha256 !== plan.acceptanceSha256) out.add('identity_mismatch', 'acceptance_digest', aat)
      if (a.assessedAtMs < items.manifest.assignedAtMs || a.assessedAtMs > c.endedAtMs) out.add('chronology_invalid', 'assessment_outside_cycle', aat)
    })
  }
  const probes = c.probes
  if (probes.state === 'observed') {
    const g = `${at}.probes`
    resolve(probes.manifest.ref, 'probe_manifest', ctx, `${g}.manifest.ref`)
    if (relayProbeManifestDigest(probes.manifest.occasions) !== probes.manifest.sha256) out.add('reference_mismatch', 'manifest_digest', `${g}.manifest`)
    const fieldKeys = new Set<string>()
    probes.manifest.occasions.forEach((o, i) => {
      if ((o.scope === 'whole_answer') !== (o.field === null)) out.add('schema_invalid', 'probe_field_scope', `${g}.manifest.occasions[${i}]`)
      const key = `${o.scope}\u0000${o.field ?? ''}`
      if (fieldKeys.has(key)) out.add('duplicate_key', 'probe_field_repeat', `${g}.manifest.occasions[${i}]`)
      fieldKeys.add(key)
    })
    const ids = probes.manifest.occasions.map(o => o.id)
    seen(ids, (_, i) => out.add('duplicate_key', 'probe_occasion_repeat', `${g}.manifest.occasions[${i}]`))
    const occasions = new Set(ids)
    const attempts = new Map<string, Array<{ attempt: number; result: string | null }>>()
    const keys = new Set<string>()
    probes.grades.forEach((r, i) => {
      const rat = `${g}.grades[${i}]`
      if (!occasions.has(r.occasion)) { out.add('identity_mismatch', 'probe_row_foreign', rat); return }
      const key = `${r.occasion}\u0000${r.attempt}`
      if (keys.has(key)) { out.add('duplicate_key', 'probe_row_repeat', rat); return }
      keys.add(key)
      attempts.set(r.occasion, [...attempts.get(r.occasion) ?? [], { attempt: r.attempt, result: r.state === 'observed' ? r.result : null }])
      if (r.state === 'observed') resolve(r.ref, 'probe_grading', ctx, `${rat}.ref`)
    })
    for (const o of occasions) {
      const rows = (attempts.get(o) ?? []).sort((a, b) => a.attempt - b.attempt)
      if (!rows.length || rows[0]!.attempt !== 1) out.add('missing_slot', 'probe_first_attempt_omitted', `${g}.grades`)
      rows.forEach((r, i) => {
        if (r.attempt !== i + 1) out.add('missing_slot', 'probe_attempt_gap', `${g}.grades`)
        if (i > 0 && rows[i - 1]!.result === 'correct') out.add('chronology_invalid', 'probe_retry_after_correct', `${g}.grades`)
      })
    }
  }
  const context = c.context
  if (context.state === 'observed') {
    const g = `${at}.context`
    resolve(context.manifest.ref, 'context_manifest', ctx, `${g}.manifest.ref`)
    if (relayContextManifestDigest(context.manifest.samples) !== context.manifest.sha256) out.add('reference_mismatch', 'manifest_digest', `${g}.manifest`)
    coverage(context.manifest.samples, context.samples.map(s => s.sample), 'sample', `${g}.samples`)
    context.samples.forEach((s, i) => { if (s.state === 'observed') resolve(s.ref, 'runtime_sample', ctx, `${g}.samples[${i}].ref`) })
  }
  const guards = c.guards
  if (guards.state === 'observed') {
    const g = `${at}.guards`
    resolve(guards.manifest.ref, 'guard_manifest', ctx, `${g}.manifest.ref`)
    if (relayGuardManifestDigest(guards.manifest.checks) !== guards.manifest.sha256) out.add('reference_mismatch', 'manifest_digest', `${g}.manifest`)
    coverage(guards.manifest.checks.map(k => k.id), guards.checks.map(k => k.check), 'guard', `${g}.checks`)
    guards.checks.forEach((k, i) => { if (k.state === 'observed') resolve(k.ref, 'guard_observation', ctx, `${g}.checks[${i}].ref`) })
  }
  if (c.integrity.state === 'observed') resolve(c.integrity.ref, 'seal_reference', ctx, `${at}.integrity.ref`)
}

const recordOf = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
const bounded = (v: unknown, max: number) => !Array.isArray(v) || v.length <= max
function groupWithin(slot: Record<string, unknown>, groupKey: string, manifestKey: string, manifestMax: number, rowKey: string, rowMax: number): boolean {
  const group = recordOf(slot[groupKey])
  if (!group) return true
  const manifest = recordOf(group.manifest)
  return (!manifest || bounded(manifest[manifestKey], manifestMax)) && bounded(group[rowKey], rowMax)
}
// Walk only the fixed nesting levels and bounds; never touch the elements of an oversized array.
function nestedWithin(raw: Record<string, unknown>): boolean {
  if (!bounded(raw.evidence, MAX_EVIDENCE) || !bounded(raw.trials, MAX_TRIALS)) return false
  const plan = recordOf(raw.plan)
  if (plan && (!bounded(plan.tasks, MAX_TASKS) || !bounded(plan.seeds, MAX_SEEDS) || !bounded(plan.arms, RELAY_ARM_KINDS.length))) return false
  if (!Array.isArray(raw.trials)) return true
  for (const trialRaw of raw.trials) {
    const trial = recordOf(trialRaw)
    if (!trial) continue
    if (!bounded(trial.attempts, MAX_ATTEMPTS) || !bounded(trial.cycles, MAX_HORIZON) || !bounded(trial.forecasts, MAX_HORIZON)) return false
    if (!Array.isArray(trial.cycles)) continue
    for (const cycleRaw of trial.cycles) {
      const cycle = recordOf(cycleRaw)
      if (!cycle) continue
      if (!groupWithin(cycle, 'items', 'opportunities', MAX_ITEM_ROWS, 'assessments', MAX_ITEM_ROWS)) return false
      if (!groupWithin(cycle, 'probes', 'occasions', MAX_PROBE_OCCASIONS, 'grades', MAX_PROBE_GRADES)) return false
      if (!groupWithin(cycle, 'context', 'samples', MAX_CONTEXT_ROWS, 'samples', MAX_CONTEXT_ROWS)) return false
      if (!groupWithin(cycle, 'guards', 'checks', MAX_GUARD_ROWS, 'checks', MAX_GUARD_ROWS)) return false
    }
  }
  return true
}
/** Non-throwing structured validation. Never coerces: any malformed input is refused whole. */
export function checkRelayMeasurement(raw: unknown): RelayCheck {
  try {
    const record = recordOf(raw)
    if (record && record.format !== undefined && record.format !== RELAY_MEASUREMENT_FORMAT) return { ok: false, issues: [{ code: 'schema_invalid', rule: 'format_unsupported', location: 'format' }] }
    // Refuse oversized arrays before the schema walks every element, including nested groups.
    if (record && !nestedWithin(record)) return { ok: false, issues: [{ code: 'schema_invalid', rule: 'bounds', location: 'input' }] }
    const parsed = relayMeasurementSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, MAX_ISSUES).map(i => ({ code: 'schema_invalid' as const, rule: 'schema', location: safeLocation(i.path) }))
      return { ok: false, issues }
    }
    const out = new Issues()
    const referencedEvidence = validateStructure(parsed.data, out)
    if (out.list.length) return { ok: false, issues: out.list }
    return { ok: true, value: parsed.data, referencedEvidence }
  } catch {
    // Hostile input (throwing getters, proxies) must not leak its own message.
    return { ok: false, issues: [{ code: 'schema_invalid', rule: 'unreadable', location: 'input' }] }
  }
}
export function validateRelayMeasurement(raw: unknown): RelayMeasurementInput {
  const result = checkRelayMeasurement(raw)
  if (!result.ok) throw new RelayMeasurementError(result.issues)
  return result.value
}
