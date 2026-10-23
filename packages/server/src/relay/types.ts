import { z } from 'zod'
import type { EtaProjection } from './eta.ts'

import { relayPlanSchema, relayCapsSchema, relayRelativePathSchema } from '@guanxi/contract'
export const relativePath = relayRelativePathSchema
export const planSchema = relayPlanSchema
export type Plan = z.infer<typeof planSchema>
export const capsSchema = relayCapsSchema
export type Caps = z.infer<typeof capsSchema>
export const states = ['boot', 'orient', 'work', 'wind_down', 'handoff_write', 'handoff_validate', 'sealed', 'harness_fallback', 'finish', 'escalate'] as const
export type CycleState = typeof states[number]
export interface WindowObservation { tokens: number; source: string; observedAt: number; confidence: 'high'; framingTokens: number }
export interface RelayLimits {
  gateTimeoutMs: number; goalBytes: number; pageBytes: number; invalidActions: number
  /** Ask the runtime to decode probes, work actions and judge verdicts under a JSON Schema (llama-server `json_schema`). Turn it off only for a
   * runtime that rejects the grammar; the replies are then validated exactly as before. */
  structuredOutput: boolean
}
export const DEFAULT_RELAY_LIMITS: RelayLimits = { gateTimeoutMs: 120_000, goalBytes: 512, pageBytes: 2048, invalidActions: 3, structuredOutput: true }
export interface Reserves { turn: number; safety: number; handoff: number; tool: number; stepMedian: number; effective: number }
export interface Thresholds { W: number; H: number; hard: number; soft: number; handoff: number }
export type NoteKind = 'decision' | 'dead_end' | 'hypothesis' | 'open_issue' | 'lesson'
export interface Note { id: number; kind: NoteKind; text: string; items: string[]; expiresAt: number | null }
export interface Evidence { id: string; item: string; head: string; ok: boolean; output: string }
export interface Ledger {
  judge?: { briefHash: string; requestedWake?: string; requests: Array<{key:string;state:string}> };
  plan: Plan; caps: Caps; cycle: number; state: CycleState; startedAt: number;
  items: Record<string, 'open' | 'verification_requested' | 'done'>;
  head: string; files: string[]; diffstat: string; evidence: Evidence[];
  noProgress: number; tokens: number; moneyMicros: number; unknownCosts: number;
  errors: number; proposals: string[]; eta: EtaProjection | null; withheld?: boolean;
  baseline: { statuses: string; gates: string; head: string; done?: string[]; passed?: string[] }; pendingCall: string | null;
}
export interface Handoff {
  format: 'guanxi.handoff/v1'; runId: string; cycle: number; attemptId: string; epoch: number; token: number;
  ledgerHash: string; ledger: { ref: string; strip: string; head: string; revision: string }; notes: Note[]; narrative: string; degraded: boolean; bundleHash: string;
}
export class RelayError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'RelayError'; this.code = code }
}
export function invariant(value: unknown, code: string): asserts value { if (!value) throw new RelayError(code) }
