// Shared builders for the B3-b tests. Every value is invented.
import {
  EvidenceBook, assembleMeasurement, buildTrialSlot, type ArmProfile, type LedgerObservation, type SealObservation, type TrialObservation,
} from '../src/relay-smoke-build.ts'
import type { SmokeFact } from '../src/relay-smoke-facts.ts'
import { buildSmokePlan, parseSmokeConfig, type SmokeConfig } from '../src/relay-smoke-run.ts'
import { checkRelayMeasurement } from '../src/relay-protocol.ts'
import { reduceRelayMeasurement } from '../src/relay-measurement.ts'

export const T0 = Date.parse('2026-11-01T00:00:00Z')
export const H = (c: string) => c.repeat(64)
export const HEAD = (n: number) => String(n).padStart(40, 'a')

export function config(overrides: Record<string, unknown> = {}): SmokeConfig {
  return parseSmokeConfig(JSON.stringify({
    version: 1, experimentId: 'exp-test', harnessRevision: 'a'.repeat(40), endpoint: { url: 'http://127.0.0.1:4551' },
    start: { projectId: 'project-1', connectionId: 'connection-1', model: 'model-1' },
    stratum: { provider: 'fake', model: 'fake-model', revision: 'r1', quantization: { kind: 'not_applicable' }, runtime: 'rt', adapter: 'ad', resourceProfile: 'rp', windowTokens: 32768, tokenCountConvention: 'conv' },
    horizon: 6, caps: { tokens: null, moneyMicros: 0, wallMs: null }, tasks: ['ll-money-text'], seeds: [0],
    arms: [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction' }],
    ...overrides,
  }))
}
export const LEDGER_ARM: ArmProfile = { id: 'ledger-relay', kind: 'ledger_relay', ledgerHandoff: true, deadEndGuard: true }

let seq = 0
const base = (atMs: number) => ({ seq: ++seq, atMs })
export const begin = (cycle: number, atMs: number): SmokeFact => ({ ...base(atMs), kind: 'cycle_begin', cycle })
export const sealed = (cycle: number, atMs: number): SmokeFact => ({ ...base(atMs), kind: 'sealed', cycle })
export const probe = (cycle: number, atMs: number, retry: number, correct: boolean, damaged = false): SmokeFact => ({ ...base(atMs), kind: 'probe', cycle, retry, correct, damaged })
export const done = (cycle: number, atMs: number, messageId: string): SmokeFact => ({ ...base(atMs), kind: 'call_done', cycle, messageId })
export const failure = (cycle: number, atMs: number, code: string): SmokeFact => ({ ...base(atMs), kind: 'error', cycle, code })
export const judge = (cycle: number, atMs: number, signals: string[], unknownFacts: string[]): SmokeFact => ({ ...base(atMs), kind: 'judge_signals', cycle, phase: 'cycle_start', signals, unknownFacts })

export function seal(cycle: number, evidence: Array<{ item: string; ok: boolean }>, overrides: Partial<SealObservation> = {}): SealObservation {
  return {
    cycle, epoch: 1, head: HEAD(cycle), items: {}, evidence: evidence.map(e => ({ item: e.item, head: HEAD(cycle), ok: e.ok })),
    ledgerSha256: H('c'), handoffLedgerSha256: H('c'), bundleSha256: H('d'), bundleMatchesHandoff: true, artifactMatchesHandoff: true, ...overrides,
  }
}
/** Cumulative evidence: `perCycle[k]` lists the gates recorded in cycle k+1. */
export function ledgerOf(perCycle: Array<Array<{ item: string; ok: boolean }>>, costs: LedgerObservation['costs'] = []): LedgerObservation {
  const cumulative: Array<{ item: string; ok: boolean }> = []
  const seals = perCycle.map((gates, i) => { cumulative.push(...gates); return seal(i + 1, [...cumulative]) })
  return { seals, final: null, costs }
}

/** Facts of `n` complete cycles, one call each (message ids `m-<cycle>`), with whole-answer probes after the first. */
export function cycles(n: number, options: { probes?: (cycle: number) => boolean[] } = {}): SmokeFact[] {
  const out: SmokeFact[] = []
  for (let k = 1; k <= n; k++) {
    const at = T0 + k * 100_000
    out.push(begin(k, at), done(k, at + 1_000, `m-${k}`))
    if (k > 1) (options.probes?.(k) ?? [true]).forEach((correct, retry) => out.push(probe(k, at + 2_000 + retry, retry, correct)))
    out.push(sealed(k, at + 50_000))
  }
  return out
}
export function observation(overrides: Partial<TrialObservation> = {}): TrialObservation {
  return {
    version: 1, task: 'll-money-text', arm: 'ledger-relay', seed: 0, key: 'b3s-test', fingerprint: 'fp-test', runId: 'run-1', startedAtMs: T0, finishedAtMs: T0 + 900_000, status: 'completed', statusError: null,
    windowTokens: 32768, facts: [], ledger: null, ledgerError: null, endedBy: 'terminal', ...overrides,
  }
}
/** Builds one slot into a one-trial document (ledger arm planned, naive arm unsupported) and checks it. */
export function documentOf(obs: TrialObservation, arm: ArmProfile = LEDGER_ARM, cfg: SmokeConfig = config()) {
  const book = new EvidenceBook()
  const plan = buildSmokePlan(cfg, book)
  const built = buildTrialSlot({ horizon: cfg.horizon, book, arm }, obs, plan)
  const raw = assembleMeasurement({ plan, origin: 'synthetic_fixture', trials: [built.slot], book, recordedAtMs: T0 + 2_000_000, analysisAsOfMs: T0 + 2_000_000 })
  const checked = checkRelayMeasurement(raw)
  return { raw, checked, built, report: checked.ok ? reduceRelayMeasurement(raw) : null }
}
