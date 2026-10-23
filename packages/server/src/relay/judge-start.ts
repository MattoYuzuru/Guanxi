import { createHash } from 'node:crypto'
import type { RelayMeterFact, RelayRuntimeFact, RelayStartInput } from '@guanxi/contract'
import type { Connections } from '../connections/service.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { copyBrief } from './delegation-brief.ts'
import type { RelayCascadeInput } from './judge-cascade.ts'
import { prepareJudgeSignals, type RelayJudgeInput } from './judge-host.ts'
import { ConnectionJudgeModel, type InstalledJudgeAttestation, type JudgeModelInput } from './judge-model.ts'
import type { JudgeSignalPolicy } from './judge-signals.ts'
import { canonical, hash } from './handoff.ts'
import type { RuntimeMeter } from './model.ts'
import type { RelayStartHost, RelayStartPolicy } from './start.ts'
import { RelayError } from './types.ts'

/** What a host needs to build the judge of ONE public relay start. Everything here is T0: it is read from the start's
 * own admitted state, never from model output or HTTP. The meter is the guarded one the relay's own calls use, so a
 * judge that counts and dispatches through it is bound to the same runtime, the same fence and the same window. */
export interface RelayStartJudgeContext {
  readonly input: Readonly<RelayStartInput>
  readonly policy: Readonly<RelayStartPolicy>
  readonly meter: RuntimeMeter
  /** The runtime and counter facts admitted for this start (the same ones persisted with it). */
  readonly runtime: Readonly<{ fact: RelayRuntimeFact; meterFact: RelayMeterFact }>
  /** The relay store's clock: the ledger, the wall deadline and the judge's observations are all in it. */
  readonly clock: () => number
  readonly connections: Connections
  readonly scrubber: EgressScrubber
}
/** The J0/J1 signals layer needs no model and works for every relay; the cascade (J1.5 to J3) needs a judge model and a
 * delegation brief that binds this start's exact plan and caps. Either may be absent. */
export interface RelayStartJudge {
  signals?: RelayJudgeInput
  cascade?: RelayCascadeInput
}
/** A per-start host option (`RelayStartHost.judge`, default `RelayConfig.judge`). It is called once per start, before the
 * start has done anything irreversible. Returning nothing leaves that start without a judge. Throwing, or returning a
 * configuration that cannot be admitted, refuses the start with `judge_config_invalid`. */
export type RelayStartJudgeSource = (context: Readonly<RelayStartJudgeContext>) => RelayStartJudge | undefined

/** The plugin-level default: a judge source set on the start host wins, otherwise the default is used. */
export function startHostWithJudge(host: RelayStartHost, fallback: RelayStartJudgeSource | undefined): RelayStartHost {
  return host.judge || !fallback ? host : { ...host, judge: fallback }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const refused = (): never => { throw new RelayError('judge_config_invalid') }

/** Build and admit the judge of one start. Every refusal is the one fixed code, and the source's own error is dropped. */
export function prepareStartJudge(source: RelayStartJudgeSource | undefined, context: Readonly<RelayStartJudgeContext>): RelayStartJudge | undefined {
  if (!source) return undefined
  let judge: unknown
  try { judge = source(context) } catch { return refused() }
  if (judge === undefined || judge === null) return undefined
  // A refused promise is still a promise: its rejection must be consumed here, or the host process would exit on it
  // (and its text would reach stderr).
  if (typeof (judge as { then?: unknown }).then === 'function') Promise.resolve(judge).then(undefined, () => undefined)
  // A promise is not a judge: an asynchronous source would otherwise look like an empty one and silently opt the start out.
  if (!isRecord(judge) || typeof (judge as { then?: unknown }).then === 'function' || Object.keys(judge).some(key => key !== 'signals' && key !== 'cascade')) return refused()
  const { signals, cascade } = judge as { signals?: RelayJudgeInput; cascade?: RelayCascadeInput }
  try {
    if (signals !== undefined) prepareJudgeSignals(signals)
    if (cascade !== undefined) {
      if (!isRecord(cascade) || !isRecord(cascade.model)) return refused()
      // The brief binds this start's exact plan and caps; a brief written for another plan or other caps would only fail
      // when the run begins, after the run, its pin and its checkout exist.
      const brief = copyBrief(cascade.brief, context.input.plan)
      if (hash(brief.caps) !== hash(context.input.caps)) return refused()
      if (typeof cascade.model.admit !== 'function' || typeof cascade.model.sample !== 'function') return refused()
      // A runtime that counts and serves through its own transport serves one connection and one model: a role on any other
      // would never be admitted, so the start is refused now instead of degrading at every boundary.
      if (context.meter.transport) {
        for (const role of [brief.roles.j2, brief.roles.j3])
          if (role && (role.connectionId !== context.input.connectionId || role.model !== context.input.model)) return refused()
      }
    }
  } catch { return refused() }
  if (!signals && !cascade) return undefined
  return { ...(signals ? { signals } : {}), ...(cascade ? { cascade } : {}) }
}

/** The default signals collector: it reports what the relay ledger actually holds and nothing else. The no-progress
 * streak, the cycle and the wall deadline are read from the ledger; the heartbeat, the lease, the disk and a per-item
 * token budget are unknown (the evaluator keeps them as unknown, never as healthy). The ledger does not track repeated
 * failures, edit-revert cycles, dead ends or protected or out-of-scope edits, so those are reported as zero or empty:
 * this collector can raise `no_progress` and `deadline`, and a host that observes more supplies its own collector. */
export function ledgerJudgeInput(policy: JudgeSignalPolicy, clock: () => number): RelayJudgeInput {
  return {
    policy,
    // The required fields below are zero or empty only because the ledger has no such fact: published as unknown to the judge.
    unobserved: ['failureStreak', 'editRevert', 'deadEnds', 'pathEdits', 'crash', 'itemTokens'],
    collect: async ({ ledger }) => ({
      observedAt: clock(), heartbeatAt: null, lease: null,
      deadlineAt: ledger.caps.wallMs === null ? null : ledger.startedAt + ledger.caps.wallMs,
      disk: null, cycle: ledger.cycle, noProgressCycles: ledger.noProgress,
      sameFailureStreak: 0, editRevertStreak: 0, deadEndRepetitions: 0, protectedPathEdits: [], outOfScopeEdits: [],
      tokensThisItem: 0, tokenBudgetForItem: null, crashed: false,
    }),
  }
}

/** An attestor for a judge role that IS the relay's own model on the relay's own connection (the case of a transport
 * runtime, which serves exactly one model). The fact is made fresh at every admission from a new observation of that
 * runtime, so it can never be older than the window it is checked against. A role that is any other model or connection
 * is not attested here (`null`): the judge is then unavailable, not run elsewhere. */
export function relayRuntimeAttestor(context: Pick<RelayStartJudgeContext, 'input' | 'meter' | 'runtime'>, accountId: string):
  (input: JudgeModelInput) => Promise<InstalledJudgeAttestation | null> {
  const { input, meter, runtime } = context
  const identity = createHash('sha256').update(canonical([runtime.fact.model, runtime.fact.digest, runtime.fact.runtimeVersion, runtime.fact.contextTokens])).digest('hex')
  return async ({ role, signal }) => {
    if (role.connectionId !== input.connectionId || role.model !== input.model) return null
    const window = await meter.observe(signal)
    return { accountId, connectionId: role.connectionId, model: role.model, placement: 'installed-local', digest: identity,
      source: window.source, observedAt: window.observedAt, confidence: 'high', unattended: true }
  }
}

/** The judge model of a start: the relay's own meter (so count and dispatch share one runtime, local or remote) and its
 * own connection and model as the only runtime it may use. */
export function relayJudgeModel(context: Readonly<RelayStartJudgeContext>,
  options: { accountId: string; maxAgeMs: number; sampleTimeoutMs?: number; attest?: (input: JudgeModelInput) => Promise<InstalledJudgeAttestation | null> }): ConnectionJudgeModel {
  return new ConnectionJudgeModel(context.connections, options.accountId, context.meter as RuntimeMeter & { readonly countIsExact: true },
    context.scrubber, options.attest ?? relayRuntimeAttestor(context, options.accountId), options.maxAgeMs, context.clock,
    { connectionId: context.input.connectionId, model: context.input.model }, { sampleTimeoutMs: options.sampleTimeoutMs })
}
