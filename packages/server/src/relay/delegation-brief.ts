import { z } from 'zod'
import { hash } from './handoff.ts'
import { capsSchema, planSchema, relativePath, invariant, type Plan } from './types.ts'

const text = z.string().min(1)
const positive = z.number().int().positive().safe()
const nonnegative = z.number().int().nonnegative().safe()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const judgeRoleSchema = z
  .object({
    connectionId: text,
    model: text,
    windowTokens: positive,
    maxInputTokens: positive,
    maxOutputTokens: positive,
    temperature: z.number().finite(),
    tokenReserve: positive,
    moneyReserveMicros: nonnegative,
    /** Wall limit of one sample, from dispatch to the settled answer; absent means the judge model's own default. A stuck
     * executor would otherwise hold a cycle for the whole call deadline of its runtime. */
    sampleTimeoutMs: positive.optional()
  })
  .strict()
  .refine(
    (r) =>
      r.maxInputTokens + r.maxOutputTokens <= r.windowTokens &&
      r.tokenReserve >= r.maxInputTokens + r.maxOutputTokens
  )
export type JudgeRole = z.infer<typeof judgeRoleSchema>
export const checkerSchema = z
  .object({
    base: z.string().regex(/^[a-f0-9]{40,64}$/),
    path: relativePath,
    digest,
    timeoutMs: positive,
    outputBytes: positive
  })
  .strict()
export type CheckerSpec = z.infer<typeof checkerSchema>
export const delegationBriefSchema = z
  .object({
    version: z.literal(1),
    objective: text,
    definitionOfDone: z.array(text).min(1),
    plan: planSchema,
    estimatesMs: z.record(positive),
    identity: z.object({ accountId: text, homeNodeId: text, executorNodeId: text }).strict(),
    constraints: z
      .object({
        roots: z.array(text).min(1),
        commands: z.array(text),
        network: z.literal('none'),
        protectedPaths: z.array(relativePath),
        localOnly: z.literal(true)
      })
      .strict(),
    resources: z
      .object({ windowTokens: positive, keepAlive: text, reserves: z.record(nonnegative) })
      .strict(),
    caps: capsSchema,
    roles: z
      .object({
        executor: z.object({ connectionId: text, model: text }).strict(),
        j2: judgeRoleSchema.nullable(),
        j3: judgeRoleSchema.nullable(),
        fallbacks: z.array(
          z
            .object({ role: z.enum(['executor', 'j2', 'j3']), connectionId: text, model: text })
            .strict()
        ),
        onQuotaLow: z.enum(['stop', 'escalate'])
      })
      .strict(),
    judges: z
      .object({
        samples: z.union([z.literal(2), z.literal(3)]),
        checker: checkerSchema.nullable(),
        j3: z
          .object({
            enabled: z.boolean(),
            maxCallsPerRun: nonnegative,
            maxCallsPerNight: nonnegative,
            override: z.object({ id: text, reason: text }).strict().nullable(),
            tokenCapPerNight: nonnegative,
            moneyCapPerNightMicros: nonnegative
          })
          .strict()
      })
      .strict(),
    wake: z
      .object({
        timeZone: text,
        nightStartsHour: z.number().int().min(0).max(23),
        completionHour: z.literal(8),
        completion: z.enum(['defer', 'immediate']),
        failure: z.literal('immediate')
      })
      .strict(),
    report: z.object({ format: text, evidenceRefs: z.array(text) }).strict()
  })
  .strict()
  .superRefine((b, ctx) => {
    if (
      b.plan.items.some((i) => !Object.hasOwn(b.estimatesMs, i.id)) ||
      Object.keys(b.estimatesMs).some((id) => !b.plan.items.some((i) => i.id === id))
    )
      ctx.addIssue({ code: 'custom', message: 'exact estimates required' })
    if (b.judges.checker && b.judges.checker.base !== b.plan.base)
      ctx.addIssue({ code: 'custom', message: 'checker base mismatch' })
    if (!b.judges.j3.override && b.judges.j3.maxCallsPerNight > 3)
      ctx.addIssue({ code: 'custom', message: 'night override required' })
    try {
      new Intl.DateTimeFormat('en', { timeZone: b.wake.timeZone }).format(0)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid timezone' })
    }
  })
export type RelayDelegationBrief = z.infer<typeof delegationBriefSchema>
export function copyBrief(raw: RelayDelegationBrief, plan: Plan): RelayDelegationBrief {
  const b = delegationBriefSchema.parse(structuredClone(raw))
  invariant(hash(b.plan) === hash(plan), 'brief_plan_conflict')
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(b)
  return b
}
/** Civil night identity, including DST: before the configured local start belongs to the
 * previous calendar date. This records requested wake policy; it schedules no delivery. */
export function nightKey(wake: RelayDelegationBrief['wake'], now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: wake.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]))
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)))
  if (Number(p.hour) < wake.nightStartsHour) day.setUTCDate(day.getUTCDate() - 1)
  return `${wake.timeZone}:${day.toISOString().slice(0, 10)}`
}
export interface RoleCandidate {
  role: JudgeRole
  installedLocal: boolean
  unattended: boolean
  calibration: null | {
    probability: number
    confidence: 'validated'
    observedAt: number
    source: string
  }
  cost: number
}
/** Host-supplied facts only; explicit choices retain precedence and may not fall through a
 * denied choice. Automatic policy selection requires real fresh calibrated observations. */
export function selectJudgeRole(input: {
  session?: RoleCandidate
  project?: RoleCandidate
  policy: RoleCandidate[]
  threshold: number
  now: number
  maxAgeMs: number
}): JudgeRole {
  invariant(
    Number.isFinite(input.threshold) &&
      input.threshold >= 0 &&
      input.threshold <= 1 &&
      Number.isFinite(input.maxAgeMs) &&
      input.maxAgeMs >= 0,
    'selection_unavailable'
  )
  const allowed = (c: RoleCandidate) =>
    c.installedLocal === true && c.unattended === true && Number.isFinite(c.cost) && c.cost >= 0
  const explicit = input.session ?? input.project
  if (explicit) {
    invariant(allowed(explicit), 'selection_unavailable')
    return judgeRoleSchema.parse(explicit.role)
  }
  const selected = input.policy
    .filter(
      (c) =>
        allowed(c) &&
        c.calibration?.confidence === 'validated' &&
        c.calibration.source.trim() &&
        c.calibration.observedAt <= input.now &&
        input.now - c.calibration.observedAt <= input.maxAgeMs &&
        Number.isFinite(c.calibration.probability) &&
        c.calibration.probability >= input.threshold &&
        c.calibration.probability <= 1
    )
    .sort((a, b) => a.cost - b.cost)[0]
  invariant(selected, 'selection_unavailable')
  return judgeRoleSchema.parse(selected.role)
}
