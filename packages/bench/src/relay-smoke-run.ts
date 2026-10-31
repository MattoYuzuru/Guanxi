// B3-b: configuration, plan assembly and the cohort orchestrator. The orchestrator takes its source, clock, sleeper and
// observation store as parameters, so the same code runs against the HTTP owner API and against the fake relay.
// It records and describes; it evaluates no B3 criterion and never imputes.
import { relayStartInputSchema, type RelayStartInput, type RelayStartStatus } from '@guanxi/contract'
import { z } from 'zod'
import {
  EvidenceBook, assembleMeasurement, buildTrialSlot, missingTrial, type ArmProfile, type TrialObservation,
} from './relay-smoke-build.ts'
import { SMOKE_BASE_COMMIT, SMOKE_TASK_IDS, smokeDigests, smokePlan } from './relay-smoke-corpus.ts'
import { projectEvents, sha256Hex, type EventLike } from './relay-smoke-facts.ts'
import { SmokeSourceError, loopbackOrigin, type RelaySource } from './relay-smoke-source.ts'
import { checkRelayMeasurement, type RelayMeasurementInput, type RelayPlan, type RelayIssue, type RelayTrialSlot } from './relay-protocol.ts'
import { reduceRelayMeasurement, type RelayMeasurementReport } from './relay-measurement.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/)
const posint = z.number().int().positive().safe()
const descriptor = z.string().min(1).max(500)
const armSchema = z.object({
  kind: z.enum(['ledger_relay', 'naive_compaction']), id,
  /** A naive-compaction arm needs a relay that implements it (docs/plans/lanes/B3-b-smoke.plan.md); it is off unless enabled here. */
  enabled: z.boolean().optional(),
  url: z.string().optional(), homeDb: z.string().min(1).optional(),
  /** Describes the arm honestly: does a sealed ledger handoff exist, and is a repeated dead end a guarded one. */
  ledgerHandoff: z.boolean().optional(), deadEndGuard: z.boolean().optional(),
}).strict()
export const smokeConfigSchema = z.object({
  version: z.literal(1),
  experimentId: id,
  /** Git commit of the home checkout under test; part of every arm's harness digest. */
  harnessRevision: z.string().regex(/^[a-f0-9]{40}$/),
  /** Added to every start key; change it to re-run trials that ended cancelled. */
  keySalt: z.string().regex(/^[A-Za-z0-9]{0,16}$/).default(''),
  endpoint: z.object({ url: z.string(), homeDb: z.string().min(1).optional() }).strict(),
  start: z.object({ projectId: z.string().min(1), connectionId: z.string().min(1), model: z.string().min(1), domains: z.array(z.string()).default([]) }).strict(),
  stratum: z.object({
    provider: id, model: id, revision: id,
    quantization: z.union([z.object({ kind: z.literal('not_applicable') }).strict(), z.object({ kind: z.literal('quantized'), id }).strict()]),
    runtime: descriptor, adapter: descriptor, resourceProfile: descriptor,
    windowTokens: posint, tokenCountConvention: id,
  }).strict(),
  horizon: z.number().int().min(1).max(64).default(10),
  etaSelectionCycle: z.number().int().min(1).max(64).default(2),
  caps: z.object({ tokens: posint.nullable(), moneyMicros: z.number().int().nonnegative().safe().nullable(), wallMs: posint.nullable() }).strict(),
  tasks: z.array(id).min(1).optional(),
  seeds: z.array(z.number().int().nonnegative().safe()).min(1).max(16).default([0]),
  arms: z.array(armSchema).min(1).max(2).optional(),
  timing: z.object({ pollMs: posint.default(5_000), trialDeadlineMs: posint.default(6 * 3_600_000), statusFailuresBeforeAbort: posint.default(5) }).strict().default({}),
}).strict()
export type SmokeConfig = z.infer<typeof smokeConfigSchema>

export interface ResolvedArm { id: string; kind: 'ledger_relay' | 'naive_compaction'; planned: boolean; profile: ArmProfile; url: string; homeDb: string | undefined }
export function resolveArms(config: SmokeConfig): ResolvedArm[] {
  const entries = config.arms ?? [{ kind: 'ledger_relay' as const, id: 'ledger-relay' }, { kind: 'naive_compaction' as const, id: 'naive-compaction' }]
  if (new Set(entries.map(a => a.id)).size !== entries.length || new Set(entries.map(a => a.kind)).size !== entries.length) throw new Error('smoke_config_arms')
  return entries.map(a => {
    const naive = a.kind === 'naive_compaction'
    const url = a.url ?? config.endpoint.url
    return {
      id: a.id, kind: a.kind,
      // The ledger arm runs unless disabled. A naive arm runs only when explicitly enabled (it needs a relay that implements it).
      planned: a.enabled ?? !naive,
      profile: { id: a.id, kind: a.kind, ledgerHandoff: a.ledgerHandoff ?? !naive, deadEndGuard: a.deadEndGuard ?? !naive },
      url, homeDb: a.homeDb ?? (a.url === undefined ? config.endpoint.homeDb : undefined),
    }
  })
}
export function parseSmokeConfig(text: string): SmokeConfig {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('smoke_config_invalid') }
  const parsed = smokeConfigSchema.safeParse(raw)
  if (!parsed.success) throw new Error('smoke_config_invalid')
  const config = parsed.data
  loopbackOrigin(config.endpoint.url)
  for (const arm of config.arms ?? []) if (arm.url !== undefined) loopbackOrigin(arm.url)
  const tasks = config.tasks ?? SMOKE_TASK_IDS
  if (tasks.some(t => !SMOKE_TASK_IDS.includes(t)) || new Set(tasks).size !== tasks.length) throw new Error('smoke_config_tasks')
  if (new Set(config.seeds).size !== config.seeds.length) throw new Error('smoke_config_seeds')
  if (config.etaSelectionCycle > config.horizon) throw new Error('smoke_config_eta')
  resolveArms(config)
  return config
}

const digest = (tuple: unknown) => sha256Hex(JSON.stringify(tuple))
/** The B3-a plan for the selected cohort. Arm declarations (unsupported arms) are registered in `book`. */
export function buildSmokePlan(config: SmokeConfig, book: EvidenceBook): RelayPlan {
  const tasks = [...(config.tasks ?? SMOKE_TASK_IDS)]
  const s = config.stratum
  return {
    experimentId: config.experimentId,
    stratum: {
      provider: s.provider, model: s.model, revision: s.revision, quantization: s.quantization,
      runtimeSha256: digest(['guanxi.b3.smoke.stratum/v1', 'runtime', s.runtime]), adapterSha256: digest(['guanxi.b3.smoke.stratum/v1', 'adapter', s.adapter]),
      resourceProfileSha256: digest(['guanxi.b3.smoke.stratum/v1', 'resource', s.resourceProfile]),
      windowTokens: s.windowTokens, tokenCountConvention: s.tokenCountConvention, eCalibration: { state: 'unknown', reason: 'not_collected' },
    },
    ...smokeDigests(tasks), sourceCommit: SMOKE_BASE_COMMIT,
    tasks, seeds: [...config.seeds],
    arms: resolveArms(config).map(a => ({
      id: a.id, kind: a.kind, harnessSha256: digest(['guanxi.b3.smoke.harness/v1', a.kind, config.harnessRevision, a.profile.ledgerHandoff, a.profile.deadEndGuard]),
      availability: a.planned ? { state: 'planned' as const } : { state: 'unsupported' as const, reason: 'unsupported' as const, ref: book.add('arm_declaration', null, null, null, null, null) },
    })),
    horizon: config.horizon, eta: { selectionCycle: config.etaSelectionCycle, cohortId: `${config.experimentId}-eta` },
  }
}

/** Idempotent start key: the same trial always maps to the same key, so a rerun re-attaches to the same run. */
export const trialKey = (experimentId: string, task: string, arm: string, seed: number, salt = ''): string =>
  'b3s-' + digest(['guanxi.b3.smoke.key/v1', experimentId, task, arm, seed, salt]).slice(0, 16)

export interface ObservationStore { load(key: string): TrialObservation | null; save(observation: TrialObservation): void }
export const memoryStore = (): ObservationStore & { all: Map<string, TrialObservation> } => {
  const all = new Map<string, TrialObservation>()
  return { all, load: key => all.get(key) ?? null, save: o => { all.set(o.key, structuredClone(o)) } }
}
export interface RunDeps {
  source: RelaySource
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  store: ObservationStore
  signal?: AbortSignal
  /** Fixed-code progress lines; never content. */
  log?: (line: Record<string, unknown>) => void
}
const NON_TERMINAL: ReadonlySet<RelayStartStatus['status']> = new Set(['preparing', 'running', 'wrapping_up'])

async function collect(deps: RunDeps, arm: string, status: RelayStartStatus): Promise<{ facts: TrialObservation['facts']; ledger: TrialObservation['ledger']; ledgerError: string | null }> {
  const events: EventLike[] = []
  if (status.sessionId) {
    let after = 0
    for (let page = 0; page < 10_000; page++) {
      const result = await deps.source.events(arm, status.sessionId, after)
      events.push(...result.events)
      if (!result.hasMore || result.nextAfter <= after) break
      after = result.nextAfter
    }
  }
  let ledger: TrialObservation['ledger'] = null
  let ledgerError: string | null = null
  if (status.runId) {
    try { ledger = await deps.source.ledger(arm, status.runId) } catch (error) { ledgerError = error instanceof SmokeSourceError ? error.code : 'ledger_unreadable' }
  }
  return { facts: status.runId ? projectEvents(events, status.runId) : [], ledger, ledgerError }
}

/** Runs (or resumes) one trial and returns its stored observation. Never throws for a relay or endpoint failure. */
export async function runTrial(config: SmokeConfig, arm: ResolvedArm, task: string, seed: number, deps: RunDeps): Promise<TrialObservation> {
  const key = trialKey(config.experimentId, task, arm.id, seed, config.keySalt)
  const cached = deps.store.load(key)
  // A start that failed is never stored, so a rerun tries it again; every stored observation (even a cancelled one) is final.
  if (cached) { deps.log?.({ event: 'trial_resumed', task, arm: arm.id, seed }); return cached }
  const base = { version: 1 as const, task, arm: arm.id, seed, key }
  const failed = (code: string, startedAtMs: number | null): TrialObservation => ({ ...base, runId: null, startedAtMs, finishedAtMs: deps.now(), status: null, statusError: code,
    windowTokens: null, facts: [], ledger: null, ledgerError: null, endedBy: 'start_failed' })
  const input: RelayStartInput = relayStartInputSchema.parse({
    key, projectId: config.start.projectId, connectionId: config.start.connectionId, model: config.start.model, consent: 'full-access', domains: config.start.domains,
    plan: smokePlan(task), caps: { cycles: config.horizon, tokens: config.caps.tokens, moneyMicros: config.caps.moneyMicros, wallMs: config.caps.wallMs },
  })
  const startedAtMs = deps.now()
  let status: RelayStartStatus
  try { status = await deps.source.start(arm.id, input, deps.signal) } catch (error) {
    const code = error instanceof SmokeSourceError ? error.code : 'start_failed'
    deps.log?.({ event: 'trial_start_failed', task, arm: arm.id, seed, code })
    return failed(code, startedAtMs)
  }
  deps.log?.({ event: 'trial_started', task, arm: arm.id, seed })
  let endedBy: TrialObservation['endedBy'] = 'terminal'
  let consecutiveFailures = 0
  let lastError: string | null = null
  while (NON_TERMINAL.has(status.status)) {
    const stopReason = deps.signal?.aborted ? 'aborted' : deps.now() - startedAtMs >= config.timing.trialDeadlineMs ? 'deadline' : null
    if (stopReason) {
      endedBy = stopReason
      try { status = await deps.source.stop(arm.id, key) } catch { /* the observation below says what the relay reports */ }
      break
    }
    try { await deps.sleep(config.timing.pollMs, deps.signal) } catch { endedBy = 'aborted'; try { status = await deps.source.stop(arm.id, key) } catch { /* see above */ } break }
    try { status = await deps.source.status(arm.id, key, deps.signal); consecutiveFailures = 0 } catch (error) {
      lastError = error instanceof SmokeSourceError ? error.code : 'status_failed'
      if (++consecutiveFailures >= config.timing.statusFailuresBeforeAbort) { endedBy = 'aborted'; break }
    }
  }
  let facts: TrialObservation['facts'] = [], ledger: TrialObservation['ledger'] = null, ledgerError: string | null = null
  try { ({ facts, ledger, ledgerError } = await collect(deps, arm.id, status)) } catch (error) { ledgerError = error instanceof SmokeSourceError ? error.code : 'events_unreadable' }
  const observation: TrialObservation = { ...base, runId: status.runId, startedAtMs, finishedAtMs: deps.now(), status: status.status, statusError: status.error ?? lastError,
    windowTokens: status.runtime?.contextTokens ?? null, facts, ledger, ledgerError, endedBy }
  deps.store.save(observation)
  deps.log?.({ event: 'trial_done', task, arm: arm.id, seed, status: status.status, endedBy })
  return observation
}

export interface SmokeSummary {
  format: 'guanxi.b3.smoke-summary/v1'
  experimentId: string
  origin: 'synthetic_fixture' | 'recorded_observation'
  gate: 'measurement_only'
  planSha256: string
  arms: Array<{ id: string; kind: string; availability: 'planned' | 'unsupported' }>
  trials: Array<{ task: string; arm: string; seed: number; key: string; endedBy: string; status: string | null; cycles: number; ledgerRead: boolean; ledgerError: string | null; notes: string[] }>
  expectedTrials: number
  incomplete: number
  document: { valid: boolean; issues: RelayIssue[] }
}
export interface SmokeResult { measurement: RelayMeasurementInput | null; report: RelayMeasurementReport | null; summary: SmokeSummary; exitCode: 0 | 1 | 3 }

/** Runs every planned trial, assembles the document, validates it and reduces it. */
export async function runSmoke(config: SmokeConfig, deps: RunDeps): Promise<SmokeResult> {
  const arms = resolveArms(config)
  const book = new EvidenceBook()
  const plan = buildSmokePlan(config, book)
  const planned = arms.filter(a => a.planned)
  const tasks = plan.tasks
  const observed = new Map<string, TrialObservation>()
  const slots: RelayTrialSlot[] = []
  const rows: SmokeSummary['trials'] = []
  for (const task of tasks) for (const seed of config.seeds) for (const arm of planned) {
    if (deps.signal?.aborted) break
    observed.set(JSON.stringify([task, arm.id, seed]), await runTrial(config, arm, task, seed, deps))
  }
  let incomplete = 0
  const origin = deps.source.kind === 'http' ? 'recorded_observation' : 'synthetic_fixture'
  for (const task of tasks) for (const arm of planned) for (const seed of config.seeds) {
    const obs = observed.get(JSON.stringify([task, arm.id, seed]))
    if (!obs) { slots.push(missingTrial(task, arm.id, seed, 'not_collected')); incomplete++; rows.push({ task, arm: arm.id, seed, key: trialKey(config.experimentId, task, arm.id, seed, config.keySalt), endedBy: 'not_run', status: null, cycles: 0, ledgerRead: false, ledgerError: null, notes: [] }); continue }
    const built = buildTrialSlot({ horizon: config.horizon, book, arm: arm.profile }, obs, plan)
    slots.push(built.slot)
    if (obs.endedBy !== 'terminal') incomplete++
    rows.push({ task, arm: arm.id, seed, key: obs.key, endedBy: obs.endedBy, status: obs.status, cycles: built.slot.state === 'observed' ? built.slot.cycles.filter(c => c.state === 'observed').length : 0,
      ledgerRead: obs.ledger !== null, ledgerError: obs.ledgerError ?? null, notes: built.notes })
  }
  const latest = Math.max(deps.now(), ...[...observed.values()].map(o => Math.max(o.finishedAtMs ?? 0, ...o.facts.map(f => f.atMs))))
  const raw = assembleMeasurement({ plan, origin, trials: slots, book, recordedAtMs: latest, analysisAsOfMs: latest })
  const checked = checkRelayMeasurement(raw)
  const summary: SmokeSummary = {
    format: 'guanxi.b3.smoke-summary/v1', experimentId: config.experimentId, origin, gate: 'measurement_only', planSha256: raw.planSha256,
    arms: arms.map(a => ({ id: a.id, kind: a.kind, availability: a.planned ? 'planned' : 'unsupported' })), trials: rows,
    expectedTrials: tasks.length * config.seeds.length * planned.length, incomplete,
    document: { valid: checked.ok, issues: checked.ok ? [] : [...checked.issues] },
  }
  if (!checked.ok) return { measurement: null, report: null, summary, exitCode: 1 }
  return { measurement: raw, report: reduceRelayMeasurement(raw), summary, exitCode: incomplete ? 3 : 0 }
}
