import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
export const relativePath = z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => s === '..' || s === '.' || !s) && !p.startsWith('-'), 'relative path required')
export const planSchema = z.object({
  revision: id, base: z.string().regex(/^[a-f0-9]{40,64}$/), goal: z.string().min(1),
  items: z.array(z.object({ id, title: z.string().min(1), dependsOn: z.array(id),
    acceptance: z.array(z.string().min(1)).min(1), protectedPaths: z.array(relativePath),
  }).strict()).min(1),
  protectedPaths: z.array(relativePath),
}).strict().superRefine((p, ctx) => {
  const ids = new Set(p.items.map(i => i.id))
  if (ids.size !== p.items.length || p.items.some(i => i.dependsOn.some(d => !ids.has(d) || d === i.id))) ctx.addIssue({ code: 'custom', message: 'invalid dependencies' })
  const visit = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false
    return p.items.find(i => i.id === id)!.dependsOn.every(d => visit(d, new Set([...seen, id])))
  }
  if (!p.items.every(i => visit(i.id, new Set()))) ctx.addIssue({ code: 'custom', message: 'cyclic dependencies' })
})
export type Plan = z.infer<typeof planSchema>
export const capsSchema = z.object({ cycles: z.number().int().positive().nullable(), tokens: z.number().int().positive().nullable(),
  moneyMicros: z.number().int().nonnegative().nullable(), wallMs: z.number().int().positive().nullable() }).strict()
export type Caps = z.infer<typeof capsSchema>
export const states = ['boot', 'orient', 'work', 'wind_down', 'handoff_write', 'handoff_validate', 'sealed', 'harness_fallback', 'finish', 'escalate'] as const
export type CycleState = typeof states[number]
export interface WindowObservation { tokens: number; source: string; observedAt: number; confidence: 'high'; framingTokens: number }
export interface RelayLimits { gateTimeoutMs: number; goalBytes: number; pageBytes: number; invalidActions: number }
export const DEFAULT_RELAY_LIMITS: RelayLimits = { gateTimeoutMs: 120_000, goalBytes: 512, pageBytes: 2048, invalidActions: 3 }
export interface Reserves { turn: number; safety: number; handoff: number; tool: number; stepMedian: number; effective: number }
export interface Thresholds { W: number; H: number; hard: number; soft: number; handoff: number }
export type NoteKind = 'decision' | 'dead_end' | 'hypothesis' | 'open_issue' | 'lesson'
export interface Note { id: number; kind: NoteKind; text: string; items: string[]; expiresAt: number | null }
export interface Evidence { id: string; item: string; head: string; ok: boolean; output: string }
export interface Ledger {
  plan: Plan; caps: Caps; cycle: number; state: CycleState; startedAt: number;
  items: Record<string, 'open' | 'verification_requested' | 'done'>;
  head: string; files: string[]; diffstat: string; evidence: Evidence[];
  noProgress: number; tokens: number; moneyMicros: number; unknownCosts: number;
  errors: number; proposals: string[]; eta: null; withheld?: boolean;
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
