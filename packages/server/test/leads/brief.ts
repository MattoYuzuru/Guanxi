import type { LeadDelegateInput } from '@guanxi/contract'

export const START = 1_800_000_000_000
export const HOUR = 3_600_000

export function brief(overrides: Partial<LeadDelegateInput> = {}): LeadDelegateInput {
  return {
    objective: 'Make the fixture tests pass', definitionOfDone: ['npm test is green'],
    plan: { revision: 'r1', base: 'a'.repeat(40), goal: 'Fix the fixture', protectedPaths: [],
      items: [{ id: 't1', title: 'Fix it', dependsOn: [], acceptance: ['npm', 'test'], protectedPaths: [] }] },
    caps: { cycles: null, tokens: null, moneyMicros: null, wallMs: null },
    executor: { connectionId: 'local-executor', model: 'qwen-fixture' }, deadlineMs: 8 * HOUR, onDeadline: 'wrap_up', onCancel: 'cancel',
    ...overrides,
  }
}
