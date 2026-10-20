/**
 * Minimal gate interface for lane DS1-b's catalog gates (G10–G16). DS1-a owns the shared gate
 * runner and registry under packages/ui/gates/; until it lands on main these gates run through
 * ./run.ts. Each gate is a plain object, so the registry can import `catalogGates` from
 * ./registry.ts and run them next to G1–G7 (see docs/plans/lanes/DS1-b.handoff.md).
 */
import type { TrustedKeyFile } from '../../catalog/approval/index.ts'
import type { UsageScope } from '../../catalog/tooling/usage.ts'

export type GateMode = 'fast' | 'browser'

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
   * Trusted keys on the base branch, for G12's key-set check. `undefined` means "read them
   * from git"; `null` skips the comparison (fixtures that test something else).
   */
  baseTrustedKeys?: TrustedKeyFile | null
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
