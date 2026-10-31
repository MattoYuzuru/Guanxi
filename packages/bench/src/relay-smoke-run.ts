// B3-b: configuration, plan assembly and the cohort orchestrator. The orchestrator takes its source, clock, sleeper and
// observation store as parameters, so the same code runs against the HTTP owner API and against the fake relay.
// It records and describes; it evaluates no B3 criterion and never imputes.
import { relayStartInputSchema, type RelayStartInput, type RelayStartStatus } from '@guanxi/contract'
import { z } from 'zod'
import {
  EvidenceBook, assembleMeasurement, buildTrialSlot, missingTrial, type ArmProfile, type ModeProblem, type TrialObservation,
} from './relay-smoke-build.ts'
import { SMOKE_BASE_COMMIT, SMOKE_TASK_IDS, smokeDigests, smokePlan } from './relay-smoke-corpus.ts'
import { armModeOf, projectEvents, sha256Hex, type EventLike } from './relay-smoke-facts.ts'
import { SmokeSourceError, isDefinitiveStartRefusal, loopbackOrigin, type RelaySource } from './relay-smoke-source.ts'
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
  /** The git commit this arm's relay runs, when it differs from `harnessRevision` (a node restarted in another mode). */
  harnessRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
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
  timing: z.object({
    pollMs: posint.default(5_000), trialDeadlineMs: posint.default(6 * 3_600_000), statusFailuresBeforeAbort: posint.default(5),
    /** `POST /api/relay` waits for the relay to be prepared (the first GGUF hash can take minutes), so this must exceed `link.requestTimeoutMs`. */
    startTimeoutMs: posint.default(20 * 60_000), stopTimeoutMs: posint.default(5 * 60_000),
  }).strict().default({}),
}).strict()
export type SmokeConfig = z.infer<typeof smokeConfigSchema>

export interface ResolvedArm { id: string; kind: 'ledger_relay' | 'naive_compaction'; planned: boolean; profile: ArmProfile; url: string; homeDb: string | undefined; harnessRevision: string }
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
      // Defaults describe the arms as designed: only the ledger relay seals a handoff with the live (unexpired) dead-end notes
      // (`selectNotes` in relay/handoff.ts), which is the guard a repeated dead end is counted against.
      profile: { id: a.id, kind: a.kind, ledgerHandoff: a.ledgerHandoff ?? !naive, deadEndGuard: a.deadEndGuard ?? !naive },
      url, homeDb: a.homeDb ?? (a.url === undefined ? config.endpoint.homeDb : undefined), harnessRevision: a.harnessRevision ?? config.harnessRevision,
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
      id: a.id, kind: a.kind, harnessSha256: digest(['guanxi.b3.smoke.harness/v1', a.kind, a.harnessRevision, a.profile.ledgerHandoff, a.profile.deadEndGuard]),
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

const factSchema = z.object({ kind: z.string(), seq: z.number().int(), atMs: z.number().int(), cycle: z.number().int() }).passthrough()
const gateSchema = z.object({ item: z.string(), head: z.string(), ok: z.boolean() }).strict()
const sealSchema = z.object({ cycle: z.number().int(), epoch: z.number().int(), attemptId: z.string().min(1), head: z.string(), items: z.record(z.string(), z.string()),
  evidence: z.array(gateSchema), ledgerSha256: z.string().nullable(), handoffLedgerSha256: z.string().nullable(),
  bundleSha256: z.string().nullable(), bundleMatchesHandoff: z.boolean().nullable(), artifactMatchesHandoff: z.boolean().nullable(), unreadable: z.literal(true).optional() }).strict()
/** The stored shape of a trial observation. A file that does not match is refused, never trusted. */
export const trialObservationSchema = z.object({
  version: z.literal(1), task: z.string(), arm: z.string(), seed: z.number().int().nonnegative(), key: z.string(), fingerprint: z.string(),
  runId: z.string().nullable(), startedAtMs: z.number().int().nullable(), finishedAtMs: z.number().int().nullable(),
  status: z.enum(['preparing', 'running', 'wrapping_up', 'input_required', 'completed', 'canceled', 'interrupted', 'failed']).nullable(),
  statusError: z.string().nullable(), windowTokens: z.number().int().nullable(), facts: z.array(factSchema),
  ledger: z.object({ seals: z.array(sealSchema),
    final: z.object({ cycle: z.number().int(), head: z.string(), items: z.record(z.string(), z.string()), evidence: z.array(gateSchema) }).strict().nullable(),
    costs: z.array(z.object({ key: z.string(), inputTokens: z.number().int(), outputTokens: z.number().int() }).strict()) }).strict().nullable(),
  ledgerError: z.string().nullable(), endedBy: z.enum(['terminal', 'deadline', 'aborted', 'start_failed']),
}).strict()
export interface RunDeps {
  source: RelaySource
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  store: ObservationStore
  signal?: AbortSignal
  /** Run only these arms in this pass; the others are read from the store. Needed when one node serves one arm at a time. */
  only?: readonly string[]
  /** Fixed-code progress lines; never content. */
  log?: (line: Record<string, unknown>) => void
}
const NON_TERMINAL: ReadonlySet<RelayStartStatus['status']> = new Set(['preparing', 'running', 'wrapping_up'])

/** Everything that decides what a trial measures. A stored observation is reused only under the same fingerprint. */
export function trialFingerprint(config: SmokeConfig, arm: ResolvedArm, task: string, seed: number): string {
  return digest(['guanxi.b3.smoke.fingerprint/v1', config.experimentId, config.stratum, config.horizon, config.start, config.caps,
    arm.id, arm.kind, arm.profile, arm.url, arm.homeDb ?? null, arm.harnessRevision, digest(smokePlan(task)), seed])
}
const endpointOf = (arm: ResolvedArm): string => sha256Hex(`${arm.url}\u0000${arm.homeDb ?? ''}`).slice(0, 12)

function loadCached(config: SmokeConfig, arm: ResolvedArm, task: string, seed: number, deps: RunDeps): TrialObservation | null {
  const cached = deps.store.load(trialKey(config.experimentId, task, arm.id, seed, config.keySalt))
  if (!cached) return null
  if (cached.fingerprint !== trialFingerprint(config, arm, task, seed)) throw new Error('smoke_config_observation_mismatch')
  return cached
}

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

/** Runs (or resumes) one trial. Never throws for a relay or endpoint failure.
 * A stored observation is final, except that a transient read failure of the events or the home database is retried.
 * An observation is stored only when the relay for its key is confirmed terminal or stopped; otherwise it is returned
 * `unsettled`, unstored, so that nothing starts after it and a rerun re-attaches to the same key. */
export async function runTrial(config: SmokeConfig, arm: ResolvedArm, task: string, seed: number, deps: RunDeps): Promise<TrialObservation> {
  const key = trialKey(config.experimentId, task, arm.id, seed, config.keySalt)
  const fingerprint = trialFingerprint(config, arm, task, seed)
  const cached = loadCached(config, arm, task, seed, deps)
  if (cached) {
    deps.log?.({ event: 'trial_resumed', task, arm: arm.id, seed })
    if (!cached.ledgerError || !cached.runId) return cached
    try {
      const status = await deps.source.status(arm.id, key)
      const again = await collect(deps, arm.id, status)
      const refreshed: TrialObservation = { ...cached, facts: again.facts.length ? again.facts : cached.facts, ledger: again.ledger ?? cached.ledger, ledgerError: again.ledgerError }
      deps.store.save(refreshed)
      return refreshed
    } catch { return cached }
  }
  const base = { version: 1 as const, task, arm: arm.id, seed, key, fingerprint }
  const failed = (code: string, startedAtMs: number | null): TrialObservation => ({ ...base, runId: null, startedAtMs, finishedAtMs: deps.now(), status: null, statusError: code,
    windowTokens: null, facts: [], ledger: null, ledgerError: null, endedBy: 'start_failed' })
  const input: RelayStartInput = relayStartInputSchema.parse({
    key, projectId: config.start.projectId, connectionId: config.start.connectionId, model: config.start.model, consent: 'full-access', domains: config.start.domains,
    plan: smokePlan(task), caps: { cycles: config.horizon, tokens: config.caps.tokens, moneyMicros: config.caps.moneyMicros, wallMs: config.caps.wallMs },
  })
  const startedAtMs = deps.now()
  const stopRelay = async (): Promise<RelayStartStatus | null> => { try { return await deps.source.stop(arm.id, key) } catch { return null } }
  let status: RelayStartStatus
  try { status = await deps.source.start(arm.id, input, deps.signal) } catch (error) {
    const code = error instanceof SmokeSourceError ? error.code : 'start_failed'
    deps.log?.({ event: 'trial_start_failed', task, arm: arm.id, seed, code })
    // A relay that answered and refused is not running. A timeout, a dropped connection or an unreadable answer is different:
    // the start may have been admitted and still be preparing. Find out by key before anything else starts on the single slot.
    if (isDefinitiveStartRefusal(code)) return failed(code, startedAtMs)
    let found: RelayStartStatus | null = null
    let unknown = true
    for (let attempt = 0; attempt < config.timing.statusFailuresBeforeAbort && unknown; attempt++) {
      try { found = await deps.source.status(arm.id, key); unknown = false } catch (e) {
        if (e instanceof SmokeSourceError && e.code === 'relay_not_found') { unknown = false; break }
        try { await deps.sleep(config.timing.pollMs) } catch { /* cleanup is not interruptible */ }
      }
    }
    if (unknown) {
      const stopped = await stopRelay()
      if (stopped) found = stopped
      else return { ...failed('relay_state_unknown', startedAtMs), unsettled: true }
    }
    if (!found) return failed(code, startedAtMs)
    status = found
  }
  deps.log?.({ event: 'trial_started', task, arm: arm.id, seed })
  let endedBy: TrialObservation['endedBy'] = 'terminal'
  let consecutiveFailures = 0
  let lastError: string | null = null
  const stopNow = async (reason: 'aborted' | 'deadline') => {
    endedBy = reason
    const stopped = await stopRelay()
    if (stopped) status = stopped
  }
  while (NON_TERMINAL.has(status.status)) {
    if (deps.signal?.aborted) { await stopNow('aborted'); break }
    if (deps.now() - startedAtMs >= config.timing.trialDeadlineMs) { await stopNow('deadline'); break }
    try { await deps.sleep(config.timing.pollMs, deps.signal) } catch { await stopNow('aborted'); break }
    try { status = await deps.source.status(arm.id, key, deps.signal); consecutiveFailures = 0 } catch (error) {
      lastError = error instanceof SmokeSourceError ? error.code : 'status_failed'
      if (++consecutiveFailures >= config.timing.statusFailuresBeforeAbort) { await stopNow('aborted'); break }
    }
  }
  // Settled: the relay ended by itself, or our stop returned a terminal status.
  const settled = !NON_TERMINAL.has(status.status)
  let facts: TrialObservation['facts'] = [], ledger: TrialObservation['ledger'] = null, ledgerError: string | null = null
  try { ({ facts, ledger, ledgerError } = await collect(deps, arm.id, status)) } catch (error) { ledgerError = error instanceof SmokeSourceError ? error.code : 'events_unreadable' }
  const observation: TrialObservation = { ...base, runId: status.runId, startedAtMs, finishedAtMs: deps.now(), status: status.status, statusError: status.error ?? lastError,
    windowTokens: status.runtime?.contextTokens ?? null, facts, ledger, ledgerError, endedBy }
  if (!settled) {
    deps.log?.({ event: 'trial_unsettled', task, arm: arm.id, seed, status: status.status })
    return { ...observation, unsettled: true }
  }
  // The arm is confirmed from the run's own events, never from the pass order or the configuration: a naive trial must show the
  // compaction note, a ledger trial none of the naive markers. A disagreement is a failure, not a relabel, and is not stored.
  const mode = armModeOf(facts, ledger ? ledger.seals.map(s => ({ attemptId: s.attemptId, epoch: s.epoch })) : null)
  if (mode !== (arm.kind === 'naive_compaction' ? 'naive' : 'ledger')) {
    const modeProblem: ModeProblem = mode === 'unconfirmed' ? 'arm_mode_unconfirmed' : mode === 'mixed' ? 'arm_mode_mixed' : 'arm_mode_mismatch'
    deps.log?.({ event: 'trial_mode_problem', task, arm: arm.id, seed, code: modeProblem })
    return { ...observation, modeProblem }
  }
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
  /** Which arm a trial belongs to is what the operator configured (endpoint, harness revision); the tool cannot verify the mode a node runs in. */
  armIdentity: 'operator_asserted'
  arms: Array<{ id: string; kind: string; availability: 'planned' | 'unsupported'; endpoint: string; harnessRevision: string }>
  trials: Array<{ task: string; arm: string; seed: number; key: string; endedBy: string; status: string | null; cycles: number; ledgerRead: boolean; ledgerError: string | null; notes: string[] }>
  expectedTrials: number
  incomplete: number
  /** Set when a relay could not be confirmed stopped; nothing was started after it. */
  halted: 'relay_state_unknown' | ModeProblem | null
  document: { valid: boolean; issues: RelayIssue[] }
}
export interface SmokeResult { measurement: RelayMeasurementInput | null; report: RelayMeasurementReport | null; summary: SmokeSummary; exitCode: 0 | 1 | 3 }

/** Runs every selected planned trial (the others come from the store), assembles the document, validates it and reduces it. */
export async function runSmoke(config: SmokeConfig, deps: RunDeps): Promise<SmokeResult> {
  const arms = resolveArms(config)
  const book = new EvidenceBook()
  const plan = buildSmokePlan(config, book)
  const planned = arms.filter(a => a.planned)
  if (deps.only && deps.only.some(id => !planned.some(a => a.id === id))) throw new Error('smoke_config_arms')
  const selected = planned.filter(a => !deps.only || deps.only.includes(a.id))
  // Two arms behind one endpoint would label one node's data with two names. Run them as separate passes against the same store instead.
  if (new Set(selected.map(endpointOf)).size < selected.length) throw new Error('smoke_config_arm_endpoint')
  const tasks = plan.tasks
  const observed = new Map<string, TrialObservation>()
  const slots: RelayTrialSlot[] = []
  const rows: SmokeSummary['trials'] = []
  let halted: SmokeSummary['halted'] = null
  for (const task of tasks) for (const seed of config.seeds) for (const arm of planned) {
    const mapKey = JSON.stringify([task, arm.id, seed])
    if (!selected.includes(arm)) { const cached = loadCached(config, arm, task, seed, deps); if (cached) observed.set(mapKey, cached); continue }
    if (deps.signal?.aborted || halted) continue
    const obs = await runTrial(config, arm, task, seed, deps)
    observed.set(mapKey, obs)
    if (obs.unsettled) halted = 'relay_state_unknown'
    else if (obs.modeProblem) halted = obs.modeProblem
  }
  let incomplete = 0
  const origin = deps.source.kind === 'http' ? 'recorded_observation' : 'synthetic_fixture'
  for (const task of tasks) for (const arm of planned) for (const seed of config.seeds) {
    const obs = observed.get(JSON.stringify([task, arm.id, seed]))
    if (!obs || obs.unsettled || obs.modeProblem) {
      slots.push(missingTrial(task, arm.id, seed, 'not_collected')); incomplete++
      rows.push({ task, arm: arm.id, seed, key: trialKey(config.experimentId, task, arm.id, seed, config.keySalt), endedBy: obs?.modeProblem ?? (obs ? 'unsettled' : 'not_run'), status: obs?.status ?? null, cycles: 0, ledgerRead: false, ledgerError: null, notes: [] })
      continue
    }
    const built = buildTrialSlot({ horizon: config.horizon, book, arm: arm.profile }, obs, plan)
    slots.push(built.slot)
    if (obs.endedBy !== 'terminal') incomplete++
    rows.push({ task, arm: arm.id, seed, key: obs.key, endedBy: obs.endedBy, status: obs.status, cycles: built.slot.state === 'observed' ? built.slot.cycles.filter(c => c.state === 'observed').length : 0,
      ledgerRead: obs.ledger !== null, ledgerError: obs.ledgerError ?? null, notes: built.notes })
  }
  let latest = deps.now()
  for (const o of observed.values()) { latest = Math.max(latest, o.finishedAtMs ?? 0); for (const f of o.facts) if (f.atMs > latest) latest = f.atMs }
  const raw = assembleMeasurement({ plan, origin, trials: slots, book, recordedAtMs: latest, analysisAsOfMs: latest })
  const checked = checkRelayMeasurement(raw)
  const summary: SmokeSummary = {
    format: 'guanxi.b3.smoke-summary/v1', experimentId: config.experimentId, origin, gate: 'measurement_only', planSha256: raw.planSha256, armIdentity: 'operator_asserted',
    arms: arms.map(a => ({ id: a.id, kind: a.kind, availability: a.planned ? 'planned' : 'unsupported', endpoint: endpointOf(a), harnessRevision: a.harnessRevision })), trials: rows,
    expectedTrials: tasks.length * config.seeds.length * planned.length, incomplete, halted,
    document: { valid: checked.ok, issues: checked.ok ? [] : [...checked.issues] },
  }
  if (!checked.ok) return { measurement: null, report: null, summary, exitCode: 1 }
  return { measurement: raw, report: reduceRelayMeasurement(raw), summary, exitCode: halted === 'arm_mode_mismatch' || halted === 'arm_mode_mixed' || halted === 'arm_mode_unconfirmed' ? 1 : incomplete ? 3 : 0 }
}
