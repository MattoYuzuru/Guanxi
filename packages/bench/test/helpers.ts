import { validatePlan, type Plan } from '../src/protocol.ts'
export function plan(patch: Partial<Plan> = {}): Plan {
  return validatePlan({ version: 1, id: 'test', mode: 'fixture',
    tasks: Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, suite: 'fixture', revision: '1'.repeat(40), path: `/tasks/task-${i}`, published: '2026-10-21' })),
    seeds: [0], arms: [{ id: 'control', kind: 'mini-swe-agent', version: '2.4.6' }, { id: 'candidate', kind: 'fixture', version: '1' }],
    model: 'fixture-free', provider: 'fixture', connection: null, maxTrialMicrousd: 0, maxTrialTokens: 0,
    maxSteps: 4, armCapMicrousd: 0, dailyTokenCap: 0, timeoutSec: 120, cpus: 1, memoryMb: 128, ...patch })
}
