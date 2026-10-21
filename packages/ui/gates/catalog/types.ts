/**
 * Minimal gate interface for lane DS1-b's catalog gates (G10–G16). DS1-a owns the shared gate
 * runner and registry under packages/ui/gates/; until it lands on main these gates run through
 * ./run.ts. Each gate is a plain object, so the registry can import `catalogGates` from
 * ./registry.ts and run them next to G1–G7 (see docs/plans/lanes/DS1-b.handoff.md).
 */
import type { TrustedKey, TrustedKeyFile } from '../../catalog/approval/index.ts'
import type { UsageScope } from '../../catalog/tooling/usage.ts'

export type GateMode = 'fast' | 'browser'

export interface BaseSnapshot {
  label: string
  trustedKeys: TrustedKeyFile
  /** Raw review records on the base branch, by component id. */
  records: Record<string, unknown>
  /** The base commit, when read from git (G12 walks its history). */
  commit?: string
}

/** One committed version of a review record, for G12's lifecycle walk (N1). */
export interface HistoryVersion {
  /** A commit, the base branch or a fixture step, for messages. */
  label: string
  /** The parsed JSON, `undefined` when the file is absent, or the string 'unreadable'. */
  json: unknown
  trustedKeys: TrustedKey[]
}

export interface GateFinding {
  severity: 'error' | 'warning'
  message: string
  file?: string
  component?: string
}

export interface GateContext {
  repoRoot: string
  uiRoot: string
  usageScope: UsageScope
  /** Release or stage-exit policy: `review` and `stale` uses become errors (G11). */
  release: boolean
  /**
   * The base branch's trusted keys and review records, for G12's key-set and replay checks.
   * `undefined` means "read them from git" (failing closed when git cannot tell); `null`
   * skips the comparison (fixtures that test something else).
   */
  base?: BaseSnapshot | null
  /**
   * Committed versions of each record, oldest first, for G12's lifecycle walk. `undefined`
   * reads git when `base` is read from git too; fixtures pass the sequence they test.
   */
  history?: Record<string, HistoryVersion[][]>
  /** Browser gates: restrict to these story keys (seeded fixtures use it). */
  stories?: string[]
  /** Browser gates: load the fixture stories into the harness. */
  fixtures?: boolean
  /** Browser gates: harness query added to every story URL (for example `seed=g13`). */
  seed?: string
  updateSnapshots?: boolean
}

export interface GateResult {
  id: string
  title: string
  status: 'pass' | 'fail' | 'skipped'
  findings: GateFinding[]
  /** Why a gate was skipped; a skip is never silent. */
  reason?: string
}

/** A seeded violation: a change to a scratch copy of the repository that must fail the gate. */
export interface SeededViolation {
  name: string
  description: string
  /** The failure must name this, so a seed cannot pass by failing for an unrelated reason. */
  expect: RegExp
  /** Mutates the scratch repository and may adjust the context the gate runs with. */
  apply(scratch: { repoRoot: string; uiRoot: string; context: GateContext }): Promise<GateContext> | GateContext
}

export interface CatalogGate {
  id: 'G10' | 'G11' | 'G12' | 'G13' | 'G14' | 'G15' | 'G16'
  title: string
  mode: GateMode
  run(context: GateContext): Promise<GateResult>
  seeded: SeededViolation[]
}

export function result(gate: Pick<CatalogGate, 'id' | 'title'>, findings: GateFinding[]): GateResult {
  return {
    id: gate.id,
    title: gate.title,
    status: findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass',
    findings,
  }
}
