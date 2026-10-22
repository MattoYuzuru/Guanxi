// Synthetic B3-a envelope builder. Every value is invented. Nothing here is a measurement.
import {
  relayContextManifestDigest, relayEvidenceDigest, relayGuardManifestDigest, relayItemsManifestDigest, relayPlanDigest, relayProbeManifestDigest,
} from '../src/relay-protocol.ts'

export const H = (c: string) => c.repeat(64)
export const BASE = 1_000_000
export const TASKS = ['task-a', 'task-b']
export const SEEDS = [1, 2]
export const HORIZON = 3
// Hand-countable shape: 2 tasks x 2 seeds = 4 trials per planned arm, 3 cycles each.
// Per observed cycle: 2 item opportunities, probes {whole, critical head, critical ledgerHash},
// 2 context samples, 1 guard check, 1 integrity fact. The naive arm fails one opportunity in cycle 3.
export type Raw = any
export interface Options { origin?: 'synthetic_fixture' | 'recorded_observation'; mutate?: (raw: Raw) => void }

export function build(options: Options = {}): Raw {
  const evidence: Raw[] = []
  let n = 0
  const ev = (kind: string, task: string | null, arm: string | null, seed: number | null, attempt: string | null, cycle: number | null) => {
    const id = `ev-${++n}`
    evidence.push({ id, kind, task, arm, seed, attempt, cycle, metaSha256: '' })
    return id
  }
  const arms = [
    { id: 'arm-relay', kind: 'ledger_relay', harnessSha256: H('1'), availability: { state: 'planned' } },
    { id: 'arm-naive', kind: 'naive_compaction', harnessSha256: H('2'), availability: { state: 'planned' } },
    { id: 'arm-large', kind: 'single_large_window', harnessSha256: H('3'), availability: { state: 'unsupported', reason: 'unsupported', ref: ev('arm_declaration', null, null, null, null, null) } },
  ]
  const trials: Raw[] = []
  for (const task of TASKS) for (const arm of ['arm-relay', 'arm-naive']) for (const seed of SEEDS) {
    const att = 'att-1'
    const c = (k: number) => {
      const start = BASE + (k - 1) * 1000 + 100
      const opps = [`o-${k}-1`, `o-${k}-2`]
      const occasions = [{ id: 'p-whole', scope: 'whole_answer', field: null }, { id: 'p-head', scope: 'critical_field', field: 'head' }, { id: 'p-ledger', scope: 'critical_field', field: 'ledgerHash' }]
      const checks = [{ id: 'g-1', deadEnd: 'd-1' }]
      const samples = ['s-1', 's-2']
      const e = (kind: string) => ev(kind, task, arm, seed, att, k)
      return {
        ordinal: k, state: 'observed', attempt: att, receiptRef: e('cycle_receipt'), startedAtMs: start, endedAtMs: BASE + k * 1000,
        items: {
          state: 'observed', manifest: { ref: e('assignment_manifest'), sha256: relayItemsManifestDigest(opps), assignedAtMs: start + 10, opportunities: opps },
          assessments: opps.map((o, i) => ({ opportunity: o, state: 'observed', ref: e('verifier_result'), head: 'b'.repeat(40), acceptanceSha256: H('9'), assessedAtMs: start + 500,
            result: arm === 'arm-naive' && k === 3 && i === 1 ? 'failed' : 'passed' })),
        },
        probes: {
          state: 'observed', manifest: { ref: e('probe_manifest'), sha256: relayProbeManifestDigest(occasions), occasions },
          grades: occasions.map(o => ({ occasion: o.id, attempt: 1, state: 'observed', ref: e('probe_grading'), result: 'correct' })),
        },
        context: {
          state: 'observed', manifest: { ref: e('context_manifest'), sha256: relayContextManifestDigest(samples), samples },
          samples: samples.map(s => ({ sample: s, state: 'observed', ref: e('runtime_sample'), actualWindowTokens: 32768, renderedTokens: 30000, truncationEvents: 0 })),
        },
        guards: {
          state: 'observed', manifest: { ref: e('guard_manifest'), sha256: relayGuardManifestDigest(checks), checks },
          checks: [{ check: 'g-1', state: 'observed', ref: e('guard_observation'), guardActive: true, repeated: false }],
        },
        integrity: { state: 'observed', ref: e('seal_reference'), value: { ledgerSha256: H('c'), handoffLedgerSha256: H('c'), bundleSha256: H('d'), reportedValidation: 'passed' } },
      }
    }
    const end = BASE + HORIZON * 1000 + 100
    trials.push({
      task, arm, seed, state: 'observed', runId: `run-${task}-${arm}-${seed}`, outcome: 'passed',
      attempts: [{ id: att, epoch: 1, receiptRef: ev('attempt_receipt', task, arm, seed, att, null) }],
      startedAtMs: { state: 'observed', value: BASE }, finishedAtMs: { state: 'observed', value: end },
      cycles: [1, 2, 3].map(c),
      // Two forecasts per trial: the plan selects the cycle-2 one; the cycle-1 one is retained, not counted.
      forecasts: [
        { id: 'f-1', cycle: 1, ref: ev('forecast_record', task, arm, seed, null, 1), issuedAtMs: BASE + 100, cohortId: 'cohort-1', p80RemainingMs: 5000, taint: 'none' },
        { id: 'f-2', cycle: 2, ref: ev('forecast_record', task, arm, seed, null, 2), issuedAtMs: BASE + 1000, cohortId: 'cohort-1', p80RemainingMs: 2100, taint: 'none' },
      ],
    })
  }
  const raw: Raw = {
    format: 'guanxi.b3.measurement/v1', declaredOrigin: options.origin ?? 'synthetic_fixture', recordedAtMs: BASE + 10_000, analysisAsOfMs: BASE + 20_000,
    plan: {
      experimentId: 'exp-fixture',
      stratum: {
        provider: 'fixture', model: 'fixture-model', revision: 'rev-1', quantization: { kind: 'quantized', id: 'q4-fixture' },
        runtimeSha256: H('4'), adapterSha256: H('5'), resourceProfileSha256: H('6'), windowTokens: 32768, tokenCountConvention: 'fixture-count-v1',
        eCalibration: { state: 'unknown', reason: 'not_collected' },
      },
      taskManifestSha256: H('7'), acceptanceSha256: H('9'), verifierSetSha256: H('8'), sourceCommit: 'a'.repeat(40),
      tasks: [...TASKS], seeds: [...SEEDS], arms, horizon: HORIZON, eta: { selectionCycle: 2, cohortId: 'cohort-1' },
    },
    planSha256: '', evidence, trials,
  }
  options.mutate?.(raw)
  return resign(raw)
}

/** Recompute the plan, evidence and manifest digests so a test can break exactly one rule. */
export function resign(raw: Raw, skip: { plan?: boolean; evidence?: boolean; manifests?: boolean } = {}): Raw {
  if (!skip.plan) raw.planSha256 = relayPlanDigest(raw.plan)
  if (!skip.evidence) for (const e of raw.evidence) e.metaSha256 = relayEvidenceDigest(raw.planSha256, e)
  if (!skip.manifests) for (const t of raw.trials) for (const c of t.cycles ?? []) {
    if (c.state !== 'observed') continue
    if (c.items.state === 'observed') c.items.manifest.sha256 = relayItemsManifestDigest(c.items.manifest.opportunities)
    if (c.probes.state === 'observed') c.probes.manifest.sha256 = relayProbeManifestDigest(c.probes.manifest.occasions)
    if (c.context.state === 'observed') c.context.manifest.sha256 = relayContextManifestDigest(c.context.manifest.samples)
    if (c.guards.state === 'observed') c.guards.manifest.sha256 = relayGuardManifestDigest(c.guards.manifest.checks)
  }
  return raw
}
export const trialOf = (raw: Raw, task: string, arm: string, seed: number): Raw => raw.trials.find((t: Raw) => t.task === task && t.arm === arm && t.seed === seed)
