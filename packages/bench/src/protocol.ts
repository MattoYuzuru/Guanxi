import { z } from 'zod'
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@/-]{0,159}$/)
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const taskSchema = z.object({
  id, suite: z.enum(['swe-rebench', 'verified', 'fixture']),
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  path: z.string().min(1), published: z.string().date(),
}).strict()
export const planSchema = z.object({
  version: z.literal(1), id,
  mode: z.enum(['fixture', 'ab', 'noise-floor']),
  tasks: z.array(taskSchema).min(1), seeds: z.array(uint).min(1),
  arms: z.array(z.object({ id, kind: z.enum(['mini-swe-agent', 'guanxi', 'fixture']), version: id }).strict()).min(1),
  model: id, provider: id, change: z.enum(['addition', 'simplification']).default('simplification'),
  connection: z.string().regex(/^secret:\/\/[a-zA-Z0-9_.\/-]+$/).nullable(),
  maxTrialMicrousd: uint, maxTrialTokens: uint, maxSteps: uint.positive(),
  armCapMicrousd: uint, dailyTokenCap: uint,
  timeoutSec: uint.positive().max(2_147_483), // Node timer representable range, in seconds.
  cpus: z.number().int().min(1).max(8), memoryMb: z.number().int().min(64).max(12288),
}).strict()
export type Plan = z.infer<typeof planSchema>
export type Task = z.infer<typeof taskSchema>
export function validatePlan(raw: unknown, now = new Date()): Plan {
  const p = planSchema.parse(raw)
  if (new Set(p.tasks.map(t => t.id)).size !== p.tasks.length || new Set(p.seeds).size !== p.seeds.length || new Set(p.arms.map(a => a.id)).size !== p.arms.length) throw new Error('duplicate_protocol_key')
  if (p.id.includes('/') || p.arms.some(a => a.id.includes('/'))) throw new Error('invalid_run_id')
  if (p.mode === 'fixture' && p.tasks.some(t => t.suite !== 'fixture')) throw new Error('fixture_tasks_required')
  if (p.mode !== 'fixture' && !p.arms.some(a => a.kind === 'mini-swe-agent')) throw new Error('control_arm_required')
  if (p.mode === 'noise-floor' && (p.arms.length !== 1 || p.seeds.length !== 5)) throw new Error('noise_floor_requires_one_arm_five_seeds')
  if (p.mode === 'ab' && (p.arms.length < 2 || p.tasks.filter(t => t.suite === 'swe-rebench').length !== 50 || p.tasks.filter(t => t.suite === 'verified').length !== 30 || p.tasks.some(t => t.suite === 'fixture'))) throw new Error('ab_requires_50_fresh_30_regression')
  if (p.mode === 'ab' && p.tasks.some(t => t.suite === 'swe-rebench' && (Date.parse(t.published) > now.getTime() || now.getTime() - Date.parse(t.published) > 93 * 86400000))) throw new Error('stale_ab_corpus')
  if (p.maxTrialMicrousd && (!p.connection || !p.maxTrialTokens)) throw new Error('paid_requires_connection_and_token_bound')
  return p
}
export const trialSchema = z.object({
  task: id, arm: id, seed: uint,
  outcome: z.enum(['passed', 'failed', 'infra_error', 'infra_tainted']),
  errorType: z.enum(['none', 'RuntimeError', 'ValueError', 'KeyError', 'TypeError', 'AttributeError', 'UndefinedError', 'FileNotFoundError', 'RewardFileNotFoundError', 'other']).default('none'),
  costMicrousd: uint.nullable(), tokens: uint.nullable(), durationMs: uint,
  reason: z.enum(['none', 'hidden_tests', 'agent_limit', 'agent_error', 'environment', 'verifier', 'cancelled', 'preempted', 'malformed_result', 'cleanup_unconfirmed']),
}).strict()
export type Trial = z.infer<typeof trialSchema>
/** Counterbalance adjacent arm order; retain the same task/seed/model/resource tuple. */
export function schedule(plan: Plan) {
  return plan.tasks.flatMap((task, i) => plan.seeds.flatMap((seed, j) => {
    const arms = [...plan.arms]
    if ((i + j) % 2) arms.reverse()
    return arms.map(arm => ({ task, seed, arm }))
  }))
}
export function validateResults(plan: Plan, raw: unknown): Trial[] {
  const trials = z.array(trialSchema).parse(raw)
  const expected = new Set(schedule(plan).map(t => JSON.stringify([t.task.id, t.arm.id, t.seed])))
  for (const t of trials) {
    const key = JSON.stringify([t.task, t.arm, t.seed])
    if (!expected.delete(key)) throw new Error('unexpected_or_duplicate_trial')
    if ((t.outcome === 'passed' && t.reason !== 'none') || (t.outcome === 'failed' && !['hidden_tests', 'agent_limit', 'agent_error'].includes(t.reason))) throw new Error('invalid_outcome_reason')
    if (t.costMicrousd === null || t.tokens === null) {
      if (!t.outcome.startsWith('infra_')) throw new Error('unknown_billing')
    }
    if ((t.costMicrousd ?? 0) > plan.maxTrialMicrousd || (t.tokens ?? 0) > plan.maxTrialTokens) throw new Error('trial_bound_violated')
  }
  if (expected.size) throw new Error('missing_trials')
  return trials
}
